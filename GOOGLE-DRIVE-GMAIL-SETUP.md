# Photo uploads with regular Gmail (no Workspace)

Orders save to Google Sheets via the **service account**.

Inspiration photos upload to **your** Google Drive folder using **your Gmail** (one-time sign-in). The sheet stores **Drive links only** (not base64).

**Max size:** 10MB per photo, up to 6 photos per order.

---

## Part A — OAuth client (Google Cloud)

Use the same Cloud project as your service account.

**APIs to enable:** Google Drive API, **Gmail API**, Google Sheets API.

### Step A1 — OAuth consent screen

1. https://console.cloud.google.com/ → your project
2. **Google Auth Platform** → **Audience**
3. User type: **External**
4. Publishing status: **Testing**
5. Add your Gmail under **Test users** → **Save**

### Step A2 — Desktop OAuth client

1. **Google Auth Platform** → **Clients** → **Create client**
2. Application type: **Desktop app**
3. Name: `Sweet Tooth Drive Upload`
4. **Create** → **Download JSON** → save as `credentials/oauth-client.json`

No redirect URI is required for Desktop apps.

---

## Part B — Photo folder (My Drive)

1. https://drive.google.com → **New** → **Folder**
2. Name: **Sweet Tooth — Order Photos**
3. Copy folder ID from URL into `.env`:

   `GOOGLE_DRIVE_FOLDER_ID=your_folder_id`

---

## Part C — Connect Gmail (one time)

```bash
cd ~/sweettooth-cravings
node scripts/google-drive-auth.js
```

Sign in with the Gmail that owns the folder. This grants **Drive uploads** and **sending order notification emails**.

Terminal should show:

`Saved: credentials/google-drive-token.json`

**If you connected Gmail before this feature:** run the script again so Google grants the new email permission.

In `.env` (optional — defaults are fine):

```env
ORDER_NOTIFY_EMAIL=sweettoothcravingsorder@gmail.com
ORDER_NOTIFY_ENABLED=true
```

Every order triggers an email to that address with order details and Drive photo links.

### Email not arriving?

1. Open http://127.0.0.1:8080/api/health and check `orderEmail`:
   - `"ready": true` — email should work after restart
   - `"ready": false` — read the `error` field

2. **Most common fix:** Your Gmail was connected before email was added. Revoke the app at https://myaccount.google.com/permissions then run:
   ```bash
   node scripts/google-drive-auth.js
   ```
   Enable **Gmail API** in Cloud Console first.

3. **Test email:**
   ```bash
   node scripts/test-order-email.js
   ```

4. **Reliable alternative (App Password SMTP):** In `.env`, set:
   ```env
   ORDER_SMTP_USER=sweettoothcravingsorder@gmail.com
   ORDER_SMTP_PASS=xxxx xxxx xxxx xxxx
   ```
   Create an App Password at https://myaccount.google.com/apppasswords (2-Step Verification required). SMTP is used automatically when these are set.

**Drive photo names** start with the Order ID, e.g. `a1b2c3d4e5 photo 1.jpg` — search Drive for the Order ID to find all photos for that order.

Restart:

```bash
node serve.js
```

Check: http://127.0.0.1:8080/api/health

```json
{"googleSheets":true,"googleDriveOAuth":true,"photoStorage":"google_drive","maxPhotoMb":10}
```

Test upload:

```bash
node scripts/test-drive-upload.js
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Access blocked / not verified | **Audience** → **Testing** + add your Gmail as **Test user** |
| `googleDriveOAuth: false` | Run `node scripts/google-drive-auth.js` |
| Photo columns say `(upload failed)` | Re-run auth; confirm `GOOGLE_DRIVE_FOLDER_ID` in `.env` |
| Photo over 10MB | Use a smaller image (site allows up to 10MB each) |