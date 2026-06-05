# Deploy orders for sweettoothcravings.shop

The shop at **sweettoothcravings.shop** is static HTML on GitHub Pages. It **cannot** run `POST /api/cart-submit` by itself — that causes **405** and the form stays on “Submitting…”.

You need a **Node server** (`node serve.js`) running 24/7 for orders, Sheets, Drive photos, and email.

---

## Option A — Full site on Render (recommended)

One server serves the website **and** the API on the same domain.

1. Push this repo to GitHub.
2. [Render](https://render.com) → **New** → **Blueprint** → connect repo (uses `render.yaml`).
3. In Render → **Environment**, add the same variables as your local `.env` (Sheet ID, Drive folder, SMTP, etc.). Upload secrets via Render’s env UI — do not commit `.env`.
4. After deploy, copy your Render URL (e.g. `https://sweettooth-cravings.onrender.com`).
5. Point **sweettoothcravings.shop** DNS to Render (see Render custom domain docs), **or** until DNS is moved, use Option B.

Test: `https://your-app.onrender.com/api/health` → `"ok": true`

---

## Option B — GitHub Pages + API on Render

Keep the shop on GitHub Pages; API on Render.

1. Deploy `node serve.js` on Render (Option A steps 1–3).
2. Open **`config.js`** in the repo and set:

   ```javascript
   const PRODUCTION_API = "https://your-app.onrender.com";
   ```

3. Commit and push so GitHub Pages updates.
4. Test submit on https://sweettoothcravings.shop

---

## Local testing

```bash
cd ~/sweettooth-cravings
node serve.js
```

Open http://127.0.0.1:8080 — `config.js` uses same origin (no `PRODUCTION_API` needed).

---

## Verify

- Browser Network tab: `POST` to `/api/cart-submit` (or your Render URL) → **200**, not **405**
- Response JSON includes `"success": true` and `"orderId"`