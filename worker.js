/**
 * Calorie Tracker Worker
 *
 * Cloudflare Worker that:
 *  1. Receives Telegram messages (webhook), asks Gemini to estimate calories/macros,
 *     and stores the daily totals in Workers KV.
 *  2. Exposes GET /api/widget?secret=... returning today's totals as JSON
 *     (consumed by a KWGT widget on Android).
 *
 * Required bindings / secrets (set in Cloudflare, never commit them):
 *   CALORII_KV          KV namespace binding
 *   TELEGRAM_BOT_TOKEN  token from BotFather
 *   GEMINI_API_KEY      Google AI Studio key
 *   WEBHOOK_SECRET      shared secret (Telegram webhook header + widget query param)
 *   MY_TELEGRAM_ID      the only Telegram user id allowed to use the bot
 */

const GEMINI_MODEL = "gemini-3.6-flash";
const TIMEZONE = "Europe/Bucharest";
const KV_TTL_SECONDS = 172800; // keep each day's data for 48h

const SYSTEM_INSTRUCTION = `Ești un asistent de nutriție. Analizează textul și extrage datele.
Dacă e doar apă, pune calorii/macro pe 0 și pune cantitatea la water_ml.
Dacă e o altă forma de lichid, pune calorii/macro corespunzătoare și pune cantitatea la water_ml.
Răspunde STRICT cu JSON formatat astfel:
{
  "dish_name": "Numele general (ex: Mic dejun)",
  "calories": număr,
  "protein": număr,
  "carbs": număr,
  "fat": număr,
  "water_ml": număr,
  "breakdown": [
    "Primul aliment (~X kcal)",
    "Al doilea aliment (~X kcal)"
  ]
}`;

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/widget") {
      return handleWidget(request, url, env);
    }
    return handleTelegramWebhook(request, env);
  },
};

/* ------------------------------------------------------------------ */
/* Widget API                                                          */
/* ------------------------------------------------------------------ */

async function handleWidget(request, url, env) {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Fail closed: if the secret is not configured, nobody gets in.
  const providedSecret = url.searchParams.get("secret");
  if (!env.WEBHOOK_SECRET || providedSecret !== env.WEBHOOK_SECRET) {
    return new Response("Acces respins", { status: 403 });
  }

  const dailyData = await loadDay(env, env.MY_TELEGRAM_ID, getToday());
  return new Response(JSON.stringify(dailyData), {
    headers: { "Content-Type": "application/json" },
  });
}

/* ------------------------------------------------------------------ */
/* Telegram webhook                                                    */
/* ------------------------------------------------------------------ */

async function handleTelegramWebhook(request, env) {
  if (request.method !== "POST") {
    return new Response("Unauthorized", { status: 403 });
  }

  // Fail closed: reject if the secret is missing or the header does not match.
  const headerSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!env.WEBHOOK_SECRET || headerSecret !== env.WEBHOOK_SECRET) {
    return new Response("Unauthorized Webhook", { status: 403 });
  }

  let chatId = null; // kept outside try so errors can be reported to the user

  try {
    const update = await request.json();
    if (!update.message || !update.message.text) {
      return new Response("OK", { status: 200 });
    }

    chatId = update.message.chat.id;
    const senderId = update.message.from.id;
    const userText = update.message.text.trim();

    // Fail closed: only the configured user may use the bot.
    if (!env.MY_TELEGRAM_ID || String(senderId) !== String(env.MY_TELEGRAM_ID)) {
      return new Response("OK", { status: 200 });
    }

    const today = getToday();

    if (await handleCommand(userText, chatId, senderId, today, env)) {
      return new Response("OK", { status: 200 });
    }

    await telegramApi("sendChatAction", env.TELEGRAM_BOT_TOKEN, {
      chat_id: chatId,
      action: "typing",
    });

    const dailyData = await loadDay(env, senderId, today);
    const {meal, model} = await askGemini(userText, env);

    dailyData.calories += num(meal.calories);
    dailyData.protein += num(meal.protein);
    dailyData.carbs += num(meal.carbs);
    dailyData.fat += num(meal.fat);
    dailyData.water_ml += num(meal.water_ml);
    if (num(meal.calories) > 0) dailyData.meals_count += 1;

    await env.CALORII_KV.put(dayKey(senderId, today), JSON.stringify(dailyData), {
      expirationTtl: KV_TTL_SECONDS,
    });

    await sendTelegramMessage(chatId, formatMealReply(meal, dailyData), env.TELEGRAM_BOT_TOKEN);
  } catch (err) {
    console.error(err);
    if (chatId) {
      await telegramApi("sendMessage", env.TELEGRAM_BOT_TOKEN, {
        chat_id: chatId,
        text: `❌ Eroare de procesare în cod: ${err.message}`,
      });
    }
  }

  return new Response("OK", { status: 200 });
}

/** Handles /start, /reset, /total. Returns true if the text was a command. */
async function handleCommand(text, chatId, userId, today, env) {
  const token = env.TELEGRAM_BOT_TOKEN;

  if (text === "/start") {
    await sendTelegramMessage(
      chatId,
      "👋 Tracker privat activat.\n\nComenzi:\n• Scrie ce ai mâncat sau băut\n• /total - Vezi totalul zilei\n• /reset - Șterge ziua curentă",
      token
    );
    return true;
  }

  if (text === "/reset") {
    await env.CALORII_KV.delete(dayKey(userId, today));
    await sendTelegramMessage(chatId, "🔄 Ziua de astăzi a fost resetată.", token);
    return true;
  }

  if (text === "/total") {
    const d = await loadDay(env, userId, today);
    const summary =
      `📊 *TOTAL ZI CURENTĂ (${today})*\n\n` +
      `🔥 *Calorii:* ${Math.round(d.calories)} kcal\n` +
      `💧 *Apă:* ${d.water_ml} ml\n` +
      `🥩 *Proteine:* ${Math.round(d.protein)}g\n` +
      `🍞 *Carbohidrați:* ${Math.round(d.carbs)}g\n` +
      `🥑 *Grăsimi:* ${Math.round(d.fat)}g\n` +
      `🍽️ *Mese:* ${d.meals_count}`;
    await sendTelegramMessage(chatId, summary, token);
    return true;
  }

  return false;
}

/* ------------------------------------------------------------------ */
/* Gemini                                                              */
/* ------------------------------------------------------------------ */

// Order = preference. Check Google AI Studio for the model names currently
// available to you and adjust this list. Lite/older models often have
// separate (and sometimes more generous) free quotas.
const GEMINI_MODELS = [
  "gemini-3.6-flash",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3.1-flash-lite",
];

// Errors where trying another model makes sense (404 = wrong/retired model ID)
const RETRYABLE_STATUS = new Set([404, 429, 500, 503, 504]);

/** Seconds until midnight Pacific, when Gemini's daily quotas reset. */
function secondsUntilQuotaReset() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const elapsed = get("hour") * 3600 + get("minute") * 60 + get("second");
  return Math.max(60, 86400 - elapsed + 5); // KV minimum TTL is 60s
}

function cooldownSeconds(status, error) {
  if (status === 404) return 86400; // broken ID, don't retry today
  if (status === 429) {
    const isDaily = JSON.stringify(error || {}).includes("PerDay");
    return isDaily ? secondsUntilQuotaReset() : 60;
  }
  return 60; // 5xx overload: brief pause
}

async function askGemini(userText, env) {
  const errors = [];

  for (const model of GEMINI_MODELS) {
    const cooldownKey = `cooldown_${model}`;
    if (await env.CALORII_KV.get(cooldownKey)) {
      errors.push(`${model}: în pauză`);
      continue;
    }

    let response;
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": env.GEMINI_API_KEY,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${SYSTEM_INSTRUCTION}\n\nUser: "${userText}"` }] }],
            generationConfig: { responseMimeType: "application/json" },
          }),
          signal: AbortSignal.timeout(15000), // don't hang on a stalled model
        }
      );
    } catch (networkErr) {
      errors.push(`${model}: ${networkErr.message}`);
      continue;
    }

    let result = null;
    try {
      result = await response.json();
    } catch {
      /* non-JSON body, handled below */
    }

    if (response.ok && !result?.error) {
      try {
        let raw = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
        raw = raw.replace(/^```json/im, "").replace(/```$/m, "").trim();
        const meal = JSON.parse(raw);
        // Must be an object with a numeric calories field, otherwise treat as a failed answer
        if (!meal || typeof meal !== "object" || !Number.isFinite(Number(meal.calories))) {
          throw new Error("missing calories");
        }
        return { meal, model };
      } catch {
        errors.push(`${model}: răspuns invalid`);
        continue;
      }
    }

    const msg = result?.error?.message || `HTTP ${response.status}`;

    if (!RETRYABLE_STATUS.has(response.status)) {
      throw new Error(`Google API (${model}): ${msg}`);
    }

    errors.push(`${model}: ${msg}`);
    await env.CALORII_KV.put(cooldownKey, "1", {
      expirationTtl: cooldownSeconds(response.status, result?.error),
    });
  }

  throw new Error(`Toate modelele sunt indisponibile:\n${errors.join("\n")}`);
}

/* ------------------------------------------------------------------ */
/* Storage helpers                                                     */
/* ------------------------------------------------------------------ */

function emptyDay() {
  return { calories: 0, protein: 0, carbs: 0, fat: 0, water_ml: 0, meals_count: 0 };
}

function dayKey(userId, date) {
  return `daily_${userId}_${date}`;
}

async function loadDay(env, userId, date) {
  return (await env.CALORII_KV.get(dayKey(userId, date), "json")) || emptyDay();
}

/** Today's date in the configured timezone, formatted YYYY-MM-DD. */
function getToday() {
  return new Intl.DateTimeFormat("ro-RO", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .split(".")
    .reverse()
    .join("-");
}

/** Coerces model output to a non-negative finite number (guards against strings/NaN). */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

/* ------------------------------------------------------------------ */
/* Telegram helpers                                                    */
/* ------------------------------------------------------------------ */

function telegramApi(method, botToken, payload) {
  return fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function sendTelegramMessage(chatId, text, botToken) {
  const res = await telegramApi("sendMessage", botToken, {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
  });

  // If Telegram rejects the Markdown, resend as plain text.
  if (!res.ok) {
    await telegramApi("sendMessage", botToken, { chat_id: chatId, text });
  }
}

function formatMealReply(meal, dailyData) {
  let breakdown = "";
  if (Array.isArray(meal.breakdown) && meal.breakdown.length > 0) {
    breakdown = "📋 *Alimente:*\n• " + meal.breakdown.join("\n• ");
  } else if (typeof meal.breakdown === "string" && meal.breakdown.trim() !== "") {
    breakdown = `📋 _${meal.breakdown}_`;
  }

  return (
    `🍽️ *${meal.dish_name || "Înregistrat"}*\n` +
    `🔥 *+${num(meal.calories)} kcal*` +
    (num(meal.water_ml) ? ` | 💧 +${num(meal.water_ml)} ml` : "") +
    `\n\n` +
    (breakdown ? `${breakdown}\n\n` : "") +
    `📈 *TOTAL AZI: ${Math.round(dailyData.calories)} kcal*`
  );
}
