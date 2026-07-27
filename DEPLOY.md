# Deploy the order server (`serve.js`)

The shop at **https://sweettoothcravings.shop** is static HTML on **GitHub Pages**. It cannot run `POST /api/cart-submit` — that returns **405** and the cart stays on “Submitting…”.

Orders need **`node serve.js`** running 24/7 (Google Sheet, Drive photos, email). The live site calls that API via **`config.js`** → `PRODUCTION_API`.

**Production API URL (configured in repo):** `https://sweettooth-cravings.onrender.com`

---

## Architecture

```text
Customer browser (sweettoothcravings.shop)
    → config.js sets STC_API_BASE to Render URL
    → POST https://sweettooth-cravings.onrender.com/api/cart-submit
         → Google Sheets + Drive + order email
         → (optional) Stripe Checkout session for 50% deposit
```

GitHub Pages only serves `index.html`, `config.js`, and assets. All order logic lives on Render.

---

## Quick checklist

1. Deploy `serve.js` on Render (below).
2. Add environment variables and credential **Secret Files** on Render.
3. Confirm health: `https://sweettooth-cravings.onrender.com/api/health` → `"ok": true`.
4. Ensure **`config.js`** has the same Render URL in `PRODUCTION_API` (already set in this repo).
5. **Push to GitHub** so Pages updates `config.js` on the live shop.
6. Submit a test order on https://sweettoothcravings.shop and check the Sheet + inbox.

---

## Step 1 — Push code to GitHub

```bash
cd ~/sweettooth-cravings
git add config.js DEPLOY.md render.yaml serve.js lib/ index.html
git commit -m "Connect live shop to Render order API"
git push origin main
```

Repo: `https://github.com/SebastianGrokBuild/SweetToothGravings`

---

## Step 2 — Create the Render web service

### Option A — Blueprint (easiest)

1. Sign in at [render.com](https://render.com).
2. **New** → **Blueprint** → connect **SweetToothGravings**.
3. Render reads `render.yaml` and creates a service named **`sweettooth-cravings`**.
4. **Start Command** must be: `node serve.js`
5. **Health Check Path:** `/api/health`

### Option B — Manual web service

1. **New** → **Web Service** → same repo.
2. **Runtime:** Node  
3. **Build Command:** `echo "No build"` (or leave empty)  
4. **Start Command:** `node serve.js`  
5. **Health Check Path:** `/api/health`  
6. **Instance type:** Free (cold starts ~30–60s after idle)

After the first successful deploy, note the URL. It should match:

`https://sweettooth-cravings.onrender.com`

If Render gives a different URL, update **`PRODUCTION_API`** in `config.js` to match, then push again.

---

## Step 3 — Environment variables (Render dashboard)

In the service → **Environment**, add the same values as your local `.env` (do **not** commit `.env`).

| Variable | Required | Notes |
|----------|----------|--------|
| `PORT` | Yes | `10000` (Render sets this; `render.yaml` includes it) |
| `GOOGLE_SHEET_ID` | Yes | Your orders spreadsheet ID |
| `GOOGLE_SHEET_TAB` | Yes | Usually `Orders` |
| `GOOGLE_DRIVE_FOLDER_ID` | Yes | Folder for inspiration photos |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | Yes | `./credentials/google-service-account.json` |
| `ORDER_NOTIFY_EMAIL` | Yes | `sweettoothcravingsorder@gmail.com` |
| `ORDER_NOTIFY_ENABLED` | Yes | `true` |
| `ORDER_SMTP_USER` | Recommended | Gmail address for SMTP |
| `ORDER_SMTP_PASS` | Recommended | Gmail **App Password** (16 chars) |
| `ORDER_SMTP_HOST` | Optional | `smtp.gmail.com` |
| `ORDER_SMTP_PORT` | Optional | `465` |
| `ADMIN_PASSWORD` | Yes | Change from default |
| `SESSION_SECRET` | Yes | Long random string |
| `APP_URL` | Yes | `https://sweettooth-cravings.onrender.com` (API base; not used for Stripe redirects) |
| `PUBLIC_SHOP_URL` | Recommended | `https://sweettoothcravings.shop` — Stripe success/cancel return URL |
| `STRIPE_SECRET_KEY` | Recommended | `sk_live_...` from the Sweet Tooth Stripe account — enables auto 50% deposit Checkout on submit |
| `SHEET_ACTIONS_SECRET` | Recommended | Secret for Google Sheet **Send Deposit Invoice** (Apps Script). Falls back to `ADMIN_PASSWORD` if unset |

SMTP is the most reliable way to send order emails on Render. See **GOOGLE-DRIVE-GMAIL-SETUP.md** for App Password setup.

**Stripe:** With `STRIPE_SECRET_KEY` set, each successful cart submit still writes Sheets + Drive as before, then creates a Checkout session for **50% of the estimated subtotal**. Without the key, submit behaves as Sheets-only (unchanged).

**Sheet button:** After review, use **Sweet Tooth → Send Deposit Invoice** in the Order Log (see **GOOGLE-SHEETS-SETUP.md**). That calls `POST /api/sheet/send-deposit-invoice` and emails the customer — it does not change the website submit path.

---

## Step 4 — Upload Google credentials (Secret Files)

The repo **does not** include `credentials/` (gitignored). On Render:

1. Service → **Environment** → **Secret Files**.
2. Upload each local file with this **filename** (relative to repo root — must match local paths):

| Filename on Render | Local file |
|--------------------|------------|
| `credentials/google-service-account.json` | same path in your project |
| `credentials/oauth-client.json` | same |
| `credentials/google-drive-token.json` | same |

3. **Drive OAuth token:** run locally once if needed:

   ```bash
   node scripts/google-drive-auth.js
   ```

   Then upload the generated `credentials/google-drive-token.json` to Render.

4. Redeploy after adding or changing secret files.

---

## Step 5 — Verify the API

Open in a browser or terminal:

```text
https://sweettooth-cravings.onrender.com/api/health
```

Expect JSON like:

```json
{
  "ok": true,
  "googleSheets": true,
  "googleDriveOAuth": true,
  "orderEmail": { "ready": true }
}
```

If `googleSheets` or `googleDriveOAuth` is `false`, fix env vars and secret files, then redeploy.

**Cold start:** Free tier may sleep; the first request after idle can take up to a minute.

---

## Step 6 — Connect the live shop (GitHub Pages)

`config.js` is already set for split hosting:

```javascript
const PRODUCTION_API = "https://sweettooth-cravings.onrender.com";
```

Push to `main` so **sweettoothcravings.shop** loads the updated `config.js`.

On the live site, open DevTools → **Network** when submitting an order:

- **URL:** `https://sweettooth-cravings.onrender.com/api/cart-submit`
- **Status:** `200`
- **Response:** `"success": true`, `"orderId": "STC-..."`

You should **not** see a POST to `sweettoothcravings.shop/api/cart-submit` (that is GitHub Pages and returns 405).

---

## Local development

```bash
cd ~/sweettooth-cravings
node serve.js
```

Open http://127.0.0.1:8080 — `config.js` uses same origin (`PRODUCTION_API` is ignored on localhost).

---

## Option — Full site on Render (one domain)

Instead of GitHub Pages + Render API:

1. Deploy `serve.js` on Render (steps above).
2. In Render → **Settings** → **Custom Domains**, add `sweettoothcravings.shop`.
3. Point DNS from your domain registrar to Render (CNAME to Render’s hostname).
4. Set **`PRODUCTION_API = ""`** in `config.js` so the shop uses same-origin `/api/...`.
5. You can stop using GitHub Pages for the shop, or keep Pages only for redirects.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|--------|-----|
| Alert: “Orders are not connected…” | `PRODUCTION_API` empty on live `config.js` | Set URL, push to GitHub |
| POST to `sweettoothcravings.shop/api/...` → **405** | Shop still hitting Pages, not Render | Deploy API; fix `config.js` |
| POST to Render → **502/503** | Service down or cold start | Wait and retry; check Render logs |
| CORS error in console | API not allowing shop origin | `serve.js` already allows `sweettoothcravings.shop` |
| `googleSheets: false` in health | Missing env or service account file | Render env + secret file |
| Photos fail, sheet OK | Drive OAuth | Upload `google-drive-token.json`; re-run auth locally |
| No email | SMTP not set on Render | Add `ORDER_SMTP_*` env vars |

Render logs: service → **Logs** → look for `[notify]` or `[google]` errors after a test submit.

---

## Related docs

- **GOOGLE-SHEETS-SETUP.md** — spreadsheet and service account  
- **GOOGLE-DRIVE-GMAIL-SETUP.md** — Drive uploads and email (SMTP / OAuth)  
- **.env.example** — full list of variables