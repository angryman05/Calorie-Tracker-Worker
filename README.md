<a name="english"></a>

# Calorie Tracker Worker

**English** | [Română](#romana) (scroll down)

A private, serverless calorie and macro tracker. Send a plain-text message to a Telegram bot ("two eggs and a slice of toast", "500 ml water"), and a Cloudflare Worker asks Google Gemini to estimate calories, macros and water intake, stores the daily totals in Workers KV, and replies with a summary. An Android home-screen widget (KWGT) shows today's progress as rings.

I built it for my own daily use, so it is single-user by design.

## Screenshots

| Logging a meal | Daily total | Logging liquids |
|---|---|---|
| ![Logging a meal](docs/example1.png) | ![Daily total](docs/example3.png) | ![Logging water](docs/example2.png) |

### Home-screen widget

![KWGT widget with progress rings](docs/example4.png)

The widget is a custom [KWGT](https://kustom.rocks/) layout with progress rings for calories, carbs, water and other daily totals. It polls the Worker's `/api/widget` endpoint. The widget file itself is not included in this repo because its export embeds the endpoint URL and secret.

## How it works

```mermaid
flowchart LR
    U[Telegram message] --> W[Cloudflare Worker]
    W -->|text prompt| G[Gemini API]
    G -->|JSON: kcal, macros, water| W
    W <-->|daily totals| K[(Workers KV)]
    W -->|reply with breakdown + total| U
    K --> A["GET /api/widget"]
    A --> KW[KWGT widget on Android]
```

1. Telegram delivers each message to the Worker through a webhook.
2. The Worker checks the webhook secret header and that the sender is the configured user.
3. Commands (`/start`, `/total`, `/reset`) are handled directly.
4. Any other text is sent to Gemini, which is instructed to answer strictly in JSON (dish name, calories, protein, carbs, fat, water, per-item breakdown).
5. The values are validated, added to the day's totals in KV (`daily_<userId>_<YYYY-MM-DD>`, kept for 48 hours), and a formatted reply is sent back.
6. The widget calls `GET /api/widget?secret=...` and receives today's totals as JSON.

## Commands

| Command | What it does |
|---|---|
| any text | Logs a meal or drink (estimated by Gemini) |
| `/total` | Shows today's calories, water, protein, carbs, fat and meal count |
| `/reset` | Clears today's data |
| `/start` | Shows the help message |

## Widget API

`GET /api/widget?secret=<WEBHOOK_SECRET>`

```json
{
  "calories": 1450,
  "protein": 92,
  "carbs": 160,
  "fat": 48,
  "water_ml": 1500,
  "meals_count": 3
}
```

Wrong or missing secret returns `403`. Other methods return `405`.

## Configuration

Secrets are never stored in the repo. Set them in Cloudflare (or in `.dev.vars` for local development, see `.dev.vars.example`).

| Name | Type | Description |
|---|---|---|
| `CALORII_KV` | KV binding | Namespace that stores the daily totals |
| `TELEGRAM_BOT_TOKEN` | secret | Bot token from [@BotFather](https://t.me/BotFather) |
| `GEMINI_API_KEY` | secret | API key from [Google AI Studio](https://aistudio.google.com/) |
| `WEBHOOK_SECRET` | secret | Random string used for the Telegram webhook header and the widget URL (letters, digits, `_` and `-` only) |
| `MY_TELEGRAM_ID` | secret | Numeric Telegram user ID of the only person allowed to use the bot |

The Gemini model name and timezone are constants at the top of `worker.js` (`GEMINI_MODEL`, `TIMEZONE`).

## Setup

1. **Create the bot.** Talk to @BotFather, run `/newbot`, and copy the token.
2. **Create a KV namespace** and put its ID in `wrangler.toml` (replace `YOUR_KV_NAMESPACE_ID`):
   ```bash
   npx wrangler kv namespace create CALORII_KV
   ```
3. **Set the secrets:**
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put WEBHOOK_SECRET
   npx wrangler secret put MY_TELEGRAM_ID
   ```
4. **Deploy:**
   ```bash
   npx wrangler deploy
   ```
5. **Register the webhook** with the same secret you set above:
   ```bash
   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     -d "url=https://<your-worker>.workers.dev" \
     -d "secret_token=<WEBHOOK_SECRET>"
   ```
6. Message your bot with `/start`.

To find your numeric Telegram ID, message a bot such as @userinfobot.

## Security notes

- Only the Telegram user ID in `MY_TELEGRAM_ID` can use the bot; messages from anyone else are ignored.
- Telegram requests are accepted only if the `X-Telegram-Bot-Api-Secret-Token` header matches `WEBHOOK_SECRET`.
- Both checks fail closed: if a secret is not configured, requests are rejected.
- The Gemini key is sent in a request header, not in the URL, so it does not end up in logs.
- Numbers returned by the model are coerced and clamped to non-negative values before being added to the totals.

## Limitations

- Single user only.
- Calorie and macro values are model estimates, not exact measurements.
- Daily totals are updated with a read-modify-write on KV, which is not atomic. This is fine for one person sending one message at a time.
- The widget secret is passed as a query parameter, which is acceptable for personal use but not for a multi-user service.

## Tech stack

Cloudflare Workers, Workers KV, Telegram Bot API, Google Gemini API, KWGT, JavaScript.

## Note

Parts of this project were written with the help of an AI assistant. The idea, architecture, deployment, widget design and daily use are mine, and I reviewed and hardened the code (secret handling, input validation, access control) before publishing.

---

<a name="romana"></a>

# Calorie Tracker Worker (Română)

[English](#english) | **Română**

Un tracker privat de calorii și macronutrienți, fără server dedicat (serverless). Trimiți un mesaj text unui bot de Telegram („două ouă și o felie de pâine", „500 ml apă"), iar un Cloudflare Worker cere unui model Google Gemini să estimeze caloriile, macronutrienții și cantitatea de apă, salvează totalurile zilei în Workers KV și răspunde cu un rezumat. Un widget Android (KWGT) afișează progresul de azi sub formă de inele.

L-am construit pentru uz personal zilnic, deci este făcut intenționat pentru un singur utilizator.

## Capturi de ecran

| Logarea unei mese | Totalul zilei | Logarea lichidelor |
|---|---|---|
| ![Logarea unei mese](docs/example1.png) | ![Totalul zilei](docs/example3.png) | ![Logarea apei](docs/example2.png) |

### Widget pe ecranul principal

![Widget KWGT cu inele de progres](docs/example4.png)

Widgetul este un layout [KWGT](https://kustom.rocks/) personalizat, cu inele de progres pentru calorii, carbohidrați, apă și alte totaluri zilnice. Interoghează periodic endpoint-ul `/api/widget` al Worker-ului. Fișierul widgetului nu este inclus în acest repo, deoarece exportul conține URL-ul endpoint-ului și secretul.

## Cum funcționează

```mermaid
flowchart LR
    U[Mesaj Telegram] --> W[Cloudflare Worker]
    W -->|prompt text| G[Gemini API]
    G -->|JSON: kcal, macro, apă| W
    W <-->|totaluri zilnice| K[(Workers KV)]
    W -->|răspuns cu detalii + total| U
    K --> A["GET /api/widget"]
    A --> KW[Widget KWGT pe Android]
```

1. Telegram trimite fiecare mesaj către Worker printr-un webhook.
2. Worker-ul verifică headerul cu secretul webhook-ului și că expeditorul este utilizatorul configurat.
3. Comenzile (`/start`, `/total`, `/reset`) sunt tratate direct.
4. Orice alt text este trimis la Gemini, care are instrucțiunea să răspundă strict în JSON (nume preparat, calorii, proteine, carbohidrați, grăsimi, apă, detalii pe aliment).
5. Valorile sunt validate, adunate la totalurile zilei în KV (`daily_<userId>_<YYYY-MM-DD>`, păstrate 48 de ore), iar răspunsul formatat este trimis înapoi.
6. Widgetul apelează `GET /api/widget?secret=...` și primește totalurile de azi ca JSON.

## Comenzi

| Comandă | Ce face |
|---|---|
| orice text | Înregistrează o masă sau o băutură (estimată de Gemini) |
| `/total` | Afișează caloriile, apa, proteinele, carbohidrații, grăsimile și numărul de mese de azi |
| `/reset` | Șterge datele de azi |
| `/start` | Afișează mesajul de ajutor |

## API-ul widgetului

`GET /api/widget?secret=<WEBHOOK_SECRET>`

```json
{
  "calories": 1450,
  "protein": 92,
  "carbs": 160,
  "fat": 48,
  "water_ml": 1500,
  "meals_count": 3
}
```

Un secret greșit sau lipsă returnează `403`. Alte metode HTTP returnează `405`.

## Configurare

Secretele nu sunt stocate niciodată în repo. Setează-le în Cloudflare (sau în `.dev.vars` pentru dezvoltare locală, vezi `.dev.vars.example`).

| Nume | Tip | Descriere |
|---|---|---|
| `CALORII_KV` | KV binding | Namespace-ul care stochează totalurile zilnice |
| `TELEGRAM_BOT_TOKEN` | secret | Tokenul botului de la [@BotFather](https://t.me/BotFather) |
| `GEMINI_API_KEY` | secret | Cheia API din [Google AI Studio](https://aistudio.google.com/) |
| `WEBHOOK_SECRET` | secret | Șir aleatoriu folosit pentru headerul webhook-ului Telegram și pentru URL-ul widgetului (doar litere, cifre, `_` și `-`) |
| `MY_TELEGRAM_ID` | secret | ID-ul numeric Telegram al singurei persoane care poate folosi botul |

Numele modelului Gemini și fusul orar sunt constante la începutul fișierului `worker.js` (`GEMINI_MODEL`, `TIMEZONE`).

## Instalare

1. **Creează botul.** Scrie-i lui @BotFather, rulează `/newbot` și copiază tokenul.
2. **Creează un namespace KV** și pune ID-ul lui în `wrangler.toml` (înlocuiește `YOUR_KV_NAMESPACE_ID`):
   ```bash
   npx wrangler kv namespace create CALORII_KV
   ```
3. **Setează secretele:**
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put WEBHOOK_SECRET
   npx wrangler secret put MY_TELEGRAM_ID
   ```
4. **Deploy:**
   ```bash
   npx wrangler deploy
   ```
5. **Înregistrează webhook-ul** cu același secret pe care l-ai setat mai sus:
   ```bash
   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     -d "url=https://<your-worker>.workers.dev" \
     -d "secret_token=<WEBHOOK_SECRET>"
   ```
6. Trimite `/start` botului tău.

Ca să afli ID-ul tău numeric de Telegram, scrie-i unui bot precum @userinfobot.

## Note de securitate

- Doar utilizatorul Telegram din `MY_TELEGRAM_ID` poate folosi botul; mesajele de la oricine altcineva sunt ignorate.
- Cererile Telegram sunt acceptate doar dacă headerul `X-Telegram-Bot-Api-Secret-Token` se potrivește cu `WEBHOOK_SECRET`.
- Ambele verificări sunt „fail closed": dacă un secret nu este configurat, cererile sunt respinse.
- Cheia Gemini este trimisă într-un header al cererii, nu în URL, deci nu ajunge în loguri.
- Numerele întoarse de model sunt convertite și limitate la valori nenegative înainte de a fi adunate la totaluri.

## Limitări

- Doar pentru un singur utilizator.
- Valorile de calorii și macronutrienți sunt estimări ale modelului, nu măsurători exacte.
- Totalurile zilnice se actualizează prin citire-modificare-scriere în KV, care nu este atomică. Este suficient pentru o persoană care trimite un mesaj pe rând.
- Secretul widgetului este trimis ca parametru în query string, ceea ce este acceptabil pentru uz personal, dar nu pentru un serviciu cu mai mulți utilizatori.

## Tehnologii

Cloudflare Workers, Workers KV, Telegram Bot API, Google Gemini API, KWGT, JavaScript.

## Notă

Părți din acest proiect au fost scrise cu ajutorul unui asistent AI. Ideea, arhitectura, deploy-ul, designul widgetului și utilizarea zilnică îmi aparțin, iar codul l-am revizuit și întărit (gestionarea secretelor, validarea datelor, controlul accesului) înainte de publicare.