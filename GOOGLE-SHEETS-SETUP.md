# Google Sheets setup (required for order requests)

Every order request from your website is saved to one Google Sheet. Inspiration photos are uploaded to **Google Drive**; the sheet stores **links** in Photo 1–6 (up to 10MB per photo).

**Time needed:** about 15–20 minutes, one time only.

---

## Before you start

You need:

- A Google account (Gmail)
- The `sweettooth-cravings` folder on your Mac
- Node.js installed (you already use `node serve.js`)

---

## Step 1 — Create a Google Cloud project

1. Open **https://console.cloud.google.com/**
2. Sign in with your Google account.
3. Top bar: click the project dropdown → **New Project**.
4. Name: `Sweet Tooth Cravings` → **Create**.
5. Wait until it finishes, then **select** that project in the dropdown.

---

## Step 2 — Turn on the APIs

1. Left menu: **APIs & Services** → **Library**.
2. Search **Google Sheets API** → open it → **Enable**.
3. Go back to Library.
4. Search **Google Drive API** → open it → **Enable**.

---

## Step 3 — Create a service account (robot user for your website)

1. Left menu: **IAM & Admin** → **Service Accounts**.
2. **+ Create Service Account**.
3. Name: `sweettooth-orders` → **Create and Continue**.
4. Role: skip (optional) → **Continue** → **Done**.
5. Click the new service account email (looks like `sweettooth-orders@....iam.gserviceaccount.com`).
6. Tab **Keys** → **Add key** → **Create new key** → **JSON** → **Create**.
7. A `.json` file downloads to your Downloads folder.

**On your Mac:**

1. In the project folder, create a folder if it does not exist:
   ```
   sweettooth-cravings/credentials/
   ```
2. Move the downloaded JSON file there and rename it exactly:
   ```
   google-service-account.json
   ```
   Full path:
   ```
   sweettooth-cravings/credentials/google-service-account.json
   ```
3. **Never** commit this file to GitHub (it is already gitignored).

4. **Copy the service account email** from that JSON file (`client_email` field) or from the Cloud Console. You will share your Sheet and Drive folder with this email.

Example email shape:
```
sweettooth-orders@your-project-id.iam.gserviceaccount.com
```

---

## Step 4 — Create the Google Sheet

1. Open **https://sheets.google.com** → **Blank spreadsheet**.
2. Name it: **Sweet Tooth — Order Log**.
3. Bottom tab: rename **Sheet1** to **Orders** (must match `.env` below).
4. Click **Share** (top right).
5. Paste the **service account email** from Step 3.
6. Set permission to **Editor** → uncheck “Notify people” → **Share**.

**Copy the Sheet ID** from the browser URL:

```
https://docs.google.com/spreadsheets/d/THIS_PART_IS_THE_SHEET_ID/edit
```

Example: if the URL is  
`https://docs.google.com/spreadsheets/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ/edit`  
then your Sheet ID is `1aBcDeFgHiJkLmNoPqRsTuVwXyZ`.

You do **not** need to type column headers manually — the server creates them on the first order.

---

## Step 5 — Inspiration photos (Google Drive)

Follow **`GOOGLE-DRIVE-GMAIL-SETUP.md`** in this folder:

1. OAuth **Desktop app** → `credentials/oauth-client.json`
2. Create **Sweet Tooth — Order Photos** folder → `GOOGLE_DRIVE_FOLDER_ID` in `.env`
3. Run `node scripts/google-drive-auth.js` (one-time Gmail sign-in)
4. Restart `node serve.js` — `/api/health` should show `"googleDriveOAuth": true`

Photo columns in the sheet will contain **Drive links** like `https://drive.google.com/file/d/.../view` (not base64).

---

## Step 6 — Configure `.env` on your Mac

1. In `sweettooth-cravings`, open `.env` (create from `.env.example` if missing).
2. Fill in these lines (replace with your real IDs):

```env
GOOGLE_SHEET_ID=paste_your_sheet_id_here
GOOGLE_SHEET_TAB=Orders
GOOGLE_DRIVE_FOLDER_ID=paste_your_folder_id_here
GOOGLE_SERVICE_ACCOUNT_FILE=./credentials/google-service-account.json
```

3. Save the file.

**Checklist:**

| Item | Location |
|------|----------|
| JSON key file | `credentials/google-service-account.json` |
| Sheet shared with service account | Editor |
| Drive folder shared with service account | Editor |
| `GOOGLE_SHEET_ID` in `.env` | From spreadsheet URL |
| `GOOGLE_DRIVE_FOLDER_ID` in `.env` | From folder URL |

---

## Step 7 — Start the server and verify

1. Terminal:

```bash
cd ~/sweettooth-cravings
node serve.js
```

2. Open in browser (use the URL printed in Terminal, usually):

```
http://127.0.0.1:8080/api/health
```

You should see JSON like:

```json
{"ok":true,"googleSheets":true}
```

- If `googleSheets` is **false**: credentials path or `GOOGLE_SHEET_ID` is wrong/missing.
- If you get “cannot connect”: run `node serve.js` first.

---

## Step 8 — Test a real order

1. Open **http://127.0.0.1:8080** (or your printed URL).
2. Add something to the cart → open cart → **Submit Request**.
3. Fill name + email → submit.
4. Open **Sweet Tooth — Order Log** → tab **Orders**.

You should see a new row (headers appear on first submit). If you attached photos, **Photo 1–6** columns will contain Google Drive links.

If submit fails, read the alert message and check Terminal where `node serve.js` is running for errors like “permission denied” (usually means Sheet/folder not shared with the service account).

---

## How customers order now (one flow)

1. Browse menu → **Select** items (including Custom Cakes).
2. Customize size, flavor, notes in the product modal.
3. Cart → **Submit Request** → contact info + optional inspiration photos.
4. Everything goes to the same Sheet via `/api/cart-submit`.

No separate custom-cake wizard — one path for all orders.

---

## Sheet columns (taxes & bookkeeping)

| Column | Purpose |
|--------|---------|
| Order ID | Unique reference |
| Submitted At | Timestamp |
| Order Type | Menu Order |
| Status | Pending Review |
| Customer Name, Email, Phone | Contact |
| Event Date | When they need it |
| Product / Cake | Summary |
| Size / Tier, Flavor, Filling | From line items / notes |
| Decoration & Custom Notes | Order notes |
| Line Items (full detail) | Full cart breakdown |
| Estimated Subtotal | Starting total |
| Deposit Due (50%) | Auto-calculated |
| Photo 1–6 | Google Drive photo links |
| Tax Year | Auto from submit date |
| Source | Sweet Tooth Website |

Filter by **Tax Year** or **Order Type** for records.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `googleSheets: false` in health | Check `.env` paths and that JSON file exists |
| “Google Sheets is not configured” on submit | Same as above |
| “Permission denied” / 403 | Re-share Sheet **and** Drive folder with service account **Editor** |
| Photo columns say “(upload failed)” | Run `node scripts/google-drive-auth.js`; see **GOOGLE-DRIVE-GMAIL-SETUP.md** |
| Photo over 10MB | Each photo must be 10MB or less |
| Works on Mac but not for customers | Deploy `serve.js` on a host with same `.env` and credentials (do not expose JSON publicly) |

---

## Security reminder

- Keep `google-service-account.json` private.
- Only share the Sheet/folder with the service account email, not “Anyone on the internet.”
- Change `ADMIN_PASSWORD` in `.env` from the default before going live.