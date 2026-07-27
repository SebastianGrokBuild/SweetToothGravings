/**
 * Google Sheets (service account) + inspiration photos (user OAuth → Drive).
 *
 * ALWAYS writes to these production targets (forced — env cannot point elsewhere):
 *   Spreadsheet  13ch_g0giBozxwFqh1OVV-gTEqttmfC23xU9pNYFVxRs  (Sweet Tooth - Order Log)
 *   Drive folder 1r-3-RrGjLbE4JHO32bMCDbId4O0jwKPE
 *
 * Column order (left → right):
 *   Order | Submit Date | Order Type | Status | Customer Name | Email | Phone |
 *   Event Date | Line Items | Estimated Subtotal | Deposit Due |
 *   Photo 1 | Photo 2 | Photo 3 | Send Deposit Invoice
 */
const crypto = require("crypto");
const https = require("https");
const fs = require("fs");
const path = require("path");

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
/** Max inspiration photos stored in the Order Log (Photo 1–3). */
const MAX_SHEET_PHOTOS = 3;
const ROOT = path.join(__dirname, "..");

function emptyPhotoSlots() {
  return Array.from({ length: MAX_SHEET_PHOTOS }, () => "");
}

/** Canonical live Order Log — forced on every submit. */
const DEFAULT_ORDER_LOG_SHEET_ID = "13ch_g0giBozxwFqh1OVV-gTEqttmfC23xU9pNYFVxRs";
/** Canonical live inspiration photos folder — forced on every upload. */
const DEFAULT_DRIVE_FOLDER_ID = "1r-3-RrGjLbE4JHO32bMCDbId4O0jwKPE";

/** Always the live Order Log (ignores mismatched env). */
function getSheetId() {
  return DEFAULT_ORDER_LOG_SHEET_ID;
}

/** Always the live photos folder (ignores mismatched env). */
function getDriveFolderId() {
  return DEFAULT_DRIVE_FOLDER_ID;
}

/** Keep process.env in sync so other modules / health checks see the same IDs. */
function forceProductionTargets() {
  process.env.GOOGLE_SHEET_ID = DEFAULT_ORDER_LOG_SHEET_ID;
  process.env.GOOGLE_DRIVE_FOLDER_ID = DEFAULT_DRIVE_FOLDER_ID;
}
forceProductionTargets();

/** Prefer local credentials/, then project root, then Render secret mounts. */
function resolveRuntimeFile(...relativeCandidates) {
  for (const rel of relativeCandidates) {
    const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    if (fs.existsSync(abs)) return abs;
  }
  // Render Secret Files are also mounted at /etc/secrets/<filename>
  for (const rel of relativeCandidates) {
    const base = path.basename(rel);
    const secret = path.join("/etc/secrets", base);
    if (fs.existsSync(secret)) return secret;
  }
  // Default (for error messages / first-run paths)
  const first = relativeCandidates[0];
  return path.isAbsolute(first) ? first : path.join(ROOT, first);
}

const TOKEN_PATH = resolveRuntimeFile(
  path.join("credentials", "google-drive-token.json"),
  "google-drive-token.json",
);
const CLIENT_PATH = resolveRuntimeFile(
  path.join("credentials", "oauth-client.json"),
  "oauth-client.json",
);

/** Exact Order Log header row — do not reorder without updating appendOrderRow. */
const SHEET_HEADERS = [
  "Order",
  "Submit Date",
  "Order Type",
  "Status",
  "Customer Name",
  "Email",
  "Phone",
  "Event Date",
  "Line Items",
  "Estimated Subtotal",
  "Deposit Due",
  "Photo 1",
  "Photo 2",
  "Photo 3",
  "Send Deposit Invoice",
];

/** Label shown in the action column (dropdown “button”). */
const SEND_DEPOSIT_BUTTON_LABEL = "Send Deposit Invoice";
const SEND_DEPOSIT_SENT_LABEL = "✓ Sent";

let cachedSaToken = null;
let saTokenExpires = 0;
let cachedUserToken = null;
let userTokenExpires = 0;

function resolveCredentialPath(envPath, defaultRelative) {
  const rel = (envPath || defaultRelative).trim();
  if (path.isAbsolute(rel)) {
    if (fs.existsSync(rel)) return rel;
    // Fall through to basename search (e.g. /etc/secrets already checked via abs)
  }
  const candidates = [];
  if (rel) {
    candidates.push(path.isAbsolute(rel) ? rel : path.join(ROOT, rel.replace(/^\.\//, "")));
    candidates.push(path.join(ROOT, path.basename(rel)));
    candidates.push(path.join("/etc/secrets", path.basename(rel)));
  }
  if (defaultRelative) {
    candidates.push(path.join(ROOT, defaultRelative));
    candidates.push(path.join(ROOT, path.basename(defaultRelative)));
    candidates.push(path.join("/etc/secrets", path.basename(defaultRelative)));
  }
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return candidates[0] || path.join(ROOT, "credentials", "google-service-account.json");
}

function loadServiceAccount() {
  const jsonPath = resolveCredentialPath(
    process.env.GOOGLE_SERVICE_ACCOUNT_FILE,
    path.join("credentials", "google-service-account.json"),
  );

  if (!fs.existsSync(jsonPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
}

function loadOAuthClient() {
  if (!fs.existsSync(CLIENT_PATH)) return null;
  const j = JSON.parse(fs.readFileSync(CLIENT_PATH, "utf8"));
  const c = j.installed || j.web;
  if (!c?.client_id) return null;
  return { id: c.client_id, secret: c.client_secret || "" };
}

function loadRefreshToken() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  try {
    const t = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    return t.refresh_token || null;
  } catch {
    return null;
  }
}

function isConfigured() {
  const sa = loadServiceAccount();
  return !!(sa && getSheetId());
}

/** Safe diagnostics for /api/health (no secrets). */
function sheetsSetupStatus() {
  forceProductionTargets();
  const jsonPath = resolveCredentialPath(
    process.env.GOOGLE_SERVICE_ACCOUNT_FILE,
    path.join("credentials", "google-service-account.json"),
  );
  const sheetId = getSheetId();
  const driveFolderId = getDriveFolderId();
  let jsonReadable = false;
  if (fs.existsSync(jsonPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      jsonReadable = !!(j.client_email && j.private_key);
    } catch {
      jsonReadable = false;
    }
  }
  return {
    sheetIdSet: !!sheetId,
    sheetId,
    driveFolderId,
    forcedTargets: true,
    headers: SHEET_HEADERS.slice(),
    serviceAccountPath: jsonPath,
    serviceAccountFileExists: fs.existsSync(jsonPath),
    serviceAccountJsonValid: jsonReadable,
  };
}

function isDriveOAuthReady() {
  return !!(getDriveFolderId() && loadOAuthClient() && loadRefreshToken());
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signJwt(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: "RS256", typ: "JWT" });
  const claim = b64url({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  });
  const input = `${header}.${claim}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(input);
  const sig = sign
    .sign(sa.private_key)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${input}.${sig}`;
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400) {
            reject(
              new Error(json.error?.message || json.error || data || res.statusCode),
            );
          } else resolve(json);
        } catch {
          if (res.statusCode >= 400) reject(new Error(data || String(res.statusCode)));
          else resolve(data);
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpsForm(hostname, pathName, form) {
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path: pathName,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new Error(json.error_description || json.error?.message || data));
            } else resolve(json);
          } catch {
            reject(new Error(data || String(res.statusCode)));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function getServiceAccountToken() {
  if (cachedSaToken && Date.now() < saTokenExpires - 60_000) return cachedSaToken;

  const sa = loadServiceAccount();
  if (!sa) throw new Error("Google service account not configured");

  const jwt = signJwt(sa);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  }).toString();

  const tokenRes = await httpsRequest(
    {
      hostname: "oauth2.googleapis.com",
      path: "/token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    body,
  );

  cachedSaToken = tokenRes.access_token;
  saTokenExpires = Date.now() + (tokenRes.expires_in || 3600) * 1000;
  return cachedSaToken;
}

async function getUserAccessToken() {
  if (cachedUserToken && Date.now() < userTokenExpires - 60_000) {
    return cachedUserToken;
  }

  const client = loadOAuthClient();
  const refreshToken = loadRefreshToken();
  if (!client || !refreshToken) return null;

  const form = {
    client_id: client.id,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  };
  if (client.secret) form.client_secret = client.secret;

  try {
    const tokenRes = await httpsForm("oauth2.googleapis.com", "/token", form);
    cachedUserToken = tokenRes.access_token;
    userTokenExpires = Date.now() + (tokenRes.expires_in || 3600) * 1000;
    return cachedUserToken;
  } catch (e) {
    // invalid_grant / expired testing tokens should not abort the whole order
    console.error(
      "[drive] OAuth refresh failed:",
      e.message,
      "— re-run: node scripts/google-drive-auth.js",
    );
    cachedUserToken = null;
    userTokenExpires = 0;
    return null;
  }
}

async function sheetsApi(method, apiPath, payload) {
  const token = await getServiceAccountToken();
  const body = payload ? JSON.stringify(payload) : null;
  return httpsRequest(
    {
      hostname: "sheets.googleapis.com",
      path: apiPath,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
      },
    },
    body,
  );
}

async function driveApi(method, apiPath, accessToken, payload) {
  const body = payload ? JSON.stringify(payload) : null;
  return httpsRequest(
    {
      hostname: "www.googleapis.com",
      path: apiPath,
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
      },
    },
    body,
  );
}

function mimeToExt(mime, filename) {
  if (filename) {
    const m = String(filename).match(/\.([a-zA-Z0-9]+)$/);
    if (m) return m[1].toLowerCase().replace("jpeg", "jpg");
  }
  if (!mime) return "jpg";
  let ext = mime.split("/")[1]?.replace("jpeg", "jpg").replace("svg+xml", "svg") || "jpg";
  if (ext === "heic" || ext === "heif") ext = "jpg";
  return ext;
}

function sanitizePhotoLinksForSheet(links) {
  const src = links || emptyPhotoSlots();
  const out = emptyPhotoSlots();
  for (let i = 0; i < MAX_SHEET_PHOTOS; i++) {
    const link = src[i];
    if (!link) {
      out[i] = "";
      continue;
    }
    const s = String(link);
    if (s.startsWith("data:image/") || (s.length > 2000 && /^data:/.test(s))) {
      out[i] = "(upload failed — photo not stored in sheet)";
    } else {
      out[i] = s;
    }
  }
  return out;
}

function parseImagePayload(img) {
  const raw = img?.data ?? img;
  if (!raw) return null;

  const str = String(raw);
  const m = str.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  if (m) {
    const mime = m[1].toLowerCase();
    let ext = mime.split("/")[1].replace("jpeg", "jpg").replace("svg+xml", "svg");
    if (ext === "heic" || ext === "heif") ext = "jpg";
    return { mime, ext, buf: Buffer.from(m[2], "base64") };
  }

  if (/^[A-Za-z0-9+/=\s]+$/.test(str) && str.length > 100) {
    return {
      mime: "image/jpeg",
      ext: "jpg",
      buf: Buffer.from(str.replace(/\s/g, ""), "base64"),
    };
  }

  return null;
}

function driveViewLink(fileId, webViewLink) {
  if (webViewLink) return webViewLink;
  return `https://drive.google.com/file/d/${fileId}/view`;
}

/** Drive filename starts with Order ID so you can search Drive by order.
 *  @param {number} photoNumber 1-based photo slot (Photo 1, Photo 2, …)
 */
function drivePhotoFileName(orderId, photoNumber, ext) {
  const safeId = String(orderId).replace(/[/\\?%*:|"<>]/g, "").trim();
  const n = Math.max(1, Number(photoNumber) || 1);
  return `${safeId} photo ${n}.${ext}`;
}

async function uploadOnePhotoToDrive(accessToken, folderId, orderId, index, parsed) {
  // index is 0-based column slot; file name uses 1-based Photo N
  const fileName = drivePhotoFileName(orderId, index + 1, parsed.ext);
  const metadata = JSON.stringify({
    name: fileName,
    parents: [folderId],
    description: `Sweet Tooth Cravings order ${orderId}`,
  });

  const boundary = `stc_${crypto.randomBytes(16).toString("hex")}`;
  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${parsed.mime}\r\n\r\n`,
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([preamble, parsed.buf, epilogue]);

  const file = await httpsRequest(
    {
      hostname: "www.googleapis.com",
      path: "/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    },
    body,
  );

  try {
    await driveApi("POST", `/drive/v3/files/${file.id}/permissions`, accessToken, {
      role: "reader",
      type: "anyone",
    });
  } catch (e) {
    console.warn("[drive] link sharing skipped:", e.message);
  }

  return driveViewLink(file.id, file.webViewLink);
}

/**
 * Upload raw image buffers to Google Drive; return view links for sheet columns.
 * @param {Array<{ buf: Buffer, mime?: string, ext?: string }>} files
 */
async function uploadPhotosToDriveFromBuffers(orderId, files) {
  const links = emptyPhotoSlots();
  const errors = [];

  if (!Array.isArray(files) || !files.length) {
    return { links, errors };
  }

  const folderId = getDriveFolderId();
  if (!folderId) {
    const msg = "GOOGLE_DRIVE_FOLDER_ID not set and no default available";
    console.error("[drive]", msg);
    for (let i = 0; i < Math.min(files.length, MAX_SHEET_PHOTOS); i++) {
      errors.push(`Photo ${i + 1}: ${msg}`);
      links[i] = "(upload failed — missing Drive folder ID)";
    }
    return { links, errors };
  }

  const accessToken = await getUserAccessToken();
  if (!accessToken) {
    const msg =
      "Gmail Drive OAuth not ready or expired — run: node scripts/google-drive-auth.js";
    console.error("[drive]", msg);
    for (let i = 0; i < Math.min(files.length, MAX_SHEET_PHOTOS); i++) {
      errors.push(`Photo ${i + 1}: ${msg}`);
      links[i] = "(upload failed — reconnect Gmail Drive)";
    }
    return { links, errors };
  }

  for (let fi = 0; fi < Math.min(files.length, MAX_SHEET_PHOTOS); fi++) {
    const file = files[fi];
    const slot = Number.isInteger(file?.index) ? file.index : fi;
    if (slot < 0 || slot >= MAX_SHEET_PHOTOS) continue;
    const buf = file?.buf;
    if (!buf || !Buffer.isBuffer(buf) || !buf.length) {
      const msg = `Photo ${slot + 1}: empty file`;
      errors.push(msg);
      links[slot] = "(upload failed — empty file)";
      continue;
    }

    if (buf.length > MAX_PHOTO_BYTES) {
      const mb = (buf.length / (1024 * 1024)).toFixed(1);
      const msg = `Photo ${slot + 1}: exceeds 10MB limit (${mb}MB)`;
      errors.push(msg);
      console.error("[drive]", msg);
      links[slot] = `(too large — ${mb}MB, max 10MB)`;
      continue;
    }

    const mime = file.mime?.startsWith("image/") ? file.mime : "image/jpeg";
    const parsed = {
      mime,
      ext: file.ext || mimeToExt(mime, file.filename),
      buf,
    };

    try {
      links[slot] = await uploadOnePhotoToDrive(
        accessToken,
        folderId,
        orderId,
        slot,
        parsed,
      );
    } catch (e) {
      const msg = `Photo ${slot + 1}: ${e.message}`;
      errors.push(msg);
      console.error("[drive]", msg);
      links[slot] = "(upload failed)";
    }
  }

  return { links, errors };
}

/** Legacy JSON path: decode base64 data URLs, then upload to Drive (never embed in sheet). */
async function uploadPhotosToDrive(orderId, images) {
  if (!Array.isArray(images) || !images.length) {
    return { links: emptyPhotoSlots(), errors: [] };
  }

  const files = [];
  const errors = [];
  const links = emptyPhotoSlots();

  for (let i = 0; i < Math.min(images.length, MAX_SHEET_PHOTOS); i++) {
    const parsed = parseImagePayload(images[i]);
    if (!parsed) {
      errors.push(`Photo ${i + 1}: unrecognized image format`);
      links[i] = "(upload failed — invalid image)";
      continue;
    }
    files.push({ ...parsed, index: i });
  }

  if (!files.length) {
    return { links, errors };
  }

  const uploaded = await uploadPhotosToDriveFromBuffers(orderId, files);
  for (let i = 0; i < MAX_SHEET_PHOTOS; i++) {
    if (links[i]) continue;
    links[i] = uploaded.links[i] || "";
  }
  return { links, errors: [...errors, ...uploaded.errors] };
}

function colLetter(index0) {
  // 0 → A, 14 → O, 25 → Z
  let n = index0 + 1;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Ensure the Send Deposit Invoice column looks like a button column:
 * purple header + dropdown action (not a checkbox).
 * Choosing "Send Deposit Invoice" in a row fires Apps Script → Stripe email.
 */
async function ensureSendDepositButtonColumn(sheetId, tab, gid) {
  const actionCol = SHEET_HEADERS.indexOf("Send Deposit Invoice");
  if (actionCol < 0) return;

  const requests = [
    {
      // Purple header
      repeatCell: {
        range: {
          sheetId: gid,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: actionCol,
          endColumnIndex: actionCol + 1,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.48, green: 0.3, blue: 0.72 },
            textFormat: {
              bold: true,
              foregroundColor: { red: 1, green: 1, blue: 1 },
            },
            horizontalAlignment: "CENTER",
          },
        },
        fields:
          "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
      },
    },
    // Clear checkbox (BOOLEAN) validation if any leftover from older deploys
    {
      setDataValidation: {
        range: {
          sheetId: gid,
          startRowIndex: 1,
          endRowIndex: 2000,
          startColumnIndex: actionCol,
          endColumnIndex: actionCol + 1,
        },
        rule: null,
      },
    },
    {
      setDataValidation: {
        range: {
          sheetId: gid,
          startRowIndex: 1,
          endRowIndex: 2000,
          startColumnIndex: actionCol,
          endColumnIndex: actionCol + 1,
        },
        rule: {
          condition: {
            type: "ONE_OF_LIST",
            values: [
              { userEnteredValue: SEND_DEPOSIT_BUTTON_LABEL },
              { userEnteredValue: SEND_DEPOSIT_SENT_LABEL },
            ],
          },
          showCustomUi: true,
          strict: false,
        },
      },
    },
    // Style data cells like purple buttons
    {
      repeatCell: {
        range: {
          sheetId: gid,
          startRowIndex: 1,
          endRowIndex: 2000,
          startColumnIndex: actionCol,
          endColumnIndex: actionCol + 1,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.91, green: 0.85, blue: 0.97 },
            textFormat: {
              bold: true,
              foregroundColor: { red: 0.36, green: 0.2, blue: 0.59 },
            },
            horizontalAlignment: "CENTER",
          },
        },
        fields:
          "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
      },
    },
  ];

  await sheetsApi("POST", `/v4/spreadsheets/${sheetId}:batchUpdate`, {
    requests,
  });
}

/** @deprecated name kept as alias */
async function ensureStripeDepositCheckboxes(sheetId, tab, gid) {
  return ensureSendDepositButtonColumn(sheetId, tab, gid);
}

/** Skip repeated header/checkbox setup within one process (faster first + later submits). */
let headersEnsuredAt = 0;
const HEADERS_CACHE_MS = 10 * 60 * 1000;

async function ensureHeaders() {
  forceProductionTargets();
  const sheetId = getSheetId();
  const tab = process.env.GOOGLE_SHEET_TAB || "Orders";
  const lastHeaderCol = colLetter(SHEET_HEADERS.length - 1); // O for 15 cols

  if (headersEnsuredAt && Date.now() - headersEnsuredAt < HEADERS_CACHE_MS) {
    return;
  }

  const existing = await sheetsApi(
    "GET",
    `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab)}!A1:Z1`,
  );

  const current = (existing.values?.[0] || []).map((h) => String(h || "").trim());
  const expected = SHEET_HEADERS.map((h) => String(h).trim());
  const headersMatch =
    current.length >= expected.length &&
    expected.every((h, i) => current[i] === h) &&
    current.slice(expected.length).every((h) => !h);

  // Force A1:O1 to the canonical schema whenever the live sheet differs.
  if (!headersMatch) {
    console.log(
      "[sheets] rewriting headers on",
      sheetId.slice(0, 12) + "…",
      "was:",
      current.slice(0, 8).join(" | "),
    );

    await sheetsApi(
      "PUT",
      `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab)}!A1:${lastHeaderCol}1?valueInputOption=RAW`,
      { values: [SHEET_HEADERS] },
    );

    // Blank any leftover headers past Stripe Deposit (old Product/Photo 4–6/Source/etc.).
    try {
      const nextCol = colLetter(SHEET_HEADERS.length);
      await sheetsApi(
        "PUT",
        `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab)}!${nextCol}1:Z1?valueInputOption=RAW`,
        { values: [Array(Math.max(1, 26 - SHEET_HEADERS.length)).fill("")] },
      );
    } catch (e) {
      console.warn("[google] obsolete header clear skipped:", e.message);
    }

    try {
      const gid = await getSheetGid(sheetId, tab);
      await sheetsApi("POST", `/v4/spreadsheets/${sheetId}:batchUpdate`, {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId: gid,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: SHEET_HEADERS.length,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.79, green: 0.66, blue: 0.91 },
                  textFormat: { bold: true },
                },
              },
              fields: "userEnteredFormat(backgroundColor,textFormat)",
            },
          },
          {
            updateSheetProperties: {
              properties: {
                sheetId: gid,
                gridProperties: { frozenRowCount: 1 },
              },
              fields: "gridProperties.frozenRowCount",
            },
          },
        ],
      });
    } catch (e) {
      console.warn("[google] header formatting skipped:", e.message);
    }
  }

  // Keep Send Deposit Invoice action column (dropdown button, not checkbox).
  try {
    const gid = await getSheetGid(sheetId, tab);
    await ensureSendDepositButtonColumn(sheetId, tab, gid);
  } catch (e) {
    console.warn("[google] Send Deposit Invoice column skipped:", e.message);
  }

  headersEnsuredAt = Date.now();
}

async function getSheetGid(spreadsheetId, tabName) {
  const meta = await sheetsApi("GET", `/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`);
  const sheet = meta.sheets?.find((s) => s.properties.title === tabName);
  return sheet?.properties?.sheetId ?? meta.sheets?.[0]?.properties?.sheetId ?? 0;
}

function money(n) {
  if (n == null || Number.isNaN(n)) return "";
  return `$${Number(n).toFixed(2)}`;
}

/**
 * Full Line Items text: every cart line + notes/allergies so the sheet always
 * has complete order detail even if other columns are empty.
 */
function buildLineItemsCell(record) {
  const chunks = [];
  const lines = String(record.lineItemsDetail || "").trim();
  if (lines) {
    chunks.push("— Cart —");
    chunks.push(lines);
  }
  if (record.product && !/menu items/i.test(String(record.product))) {
    chunks.push(`Product: ${record.product}`);
  }
  const extras = [];
  if (record.size) extras.push(`Size: ${record.size}`);
  if (record.flavor) extras.push(`Flavor: ${record.flavor}`);
  if (record.filling) extras.push(`Filling: ${record.filling}`);
  if (extras.length) chunks.push(extras.join(" | "));

  const notesBlock = [];
  if (record.decorationNotes) notesBlock.push(`Order notes: ${record.decorationNotes}`);
  if (record.allergies) notesBlock.push(`Allergies: ${record.allergies}`);
  if (record.additionalNotes) notesBlock.push(`Additional: ${record.additionalNotes}`);
  if (record.customerPhone) notesBlock.push(`Phone (confirm): ${record.customerPhone}`);
  if (record.eventDate) notesBlock.push(`Needed by: ${record.eventDate}`);
  if (notesBlock.length) {
    chunks.push("— Notes —");
    chunks.push(...notesBlock);
  }

  const subtotal = Number(record.estimatedSubtotal) || 0;
  if (subtotal > 0) {
    chunks.push("— Totals —");
    chunks.push(`Estimated subtotal: ${money(subtotal)}`);
    chunks.push(`Deposit due (50%): ${money(subtotal * 0.5)}`);
  }

  return chunks.filter(Boolean).join("\n") || "(no line items)";
}

/** Canonical field values keyed by exact SHEET_HEADERS names. */
function buildOrderColumnValues(record) {
  const subtotal = Number(record.estimatedSubtotal) || 0;
  const deposit = subtotal > 0 ? subtotal * 0.5 : 0;
  const submitted = record.submittedAt || new Date().toISOString();
  const photoLinks = sanitizePhotoLinksForSheet(record.photoLinks || emptyPhotoSlots());

  return {
    Order: String(record.orderId || "").trim(),
    "Submit Date": submitted,
    "Order Type": String(record.orderType || "Menu Order").trim(),
    Status: String(record.status || "Pending Review").trim(),
    "Customer Name": String(record.customerName || "").trim(),
    Email: String(record.customerEmail || "").trim(),
    Phone: String(record.customerPhone || "").trim(),
    "Event Date": String(record.eventDate || "").trim(),
    "Line Items": buildLineItemsCell(record),
    "Estimated Subtotal": subtotal > 0 ? money(subtotal) : "",
    "Deposit Due": deposit > 0 ? money(deposit) : "",
    "Photo 1": photoLinks[0] || "",
    "Photo 2": photoLinks[1] || "",
    "Photo 3": photoLinks[2] || "",
    // Empty until bakery chooses the Send Deposit Invoice dropdown action
    "Send Deposit Invoice": "",
  };
}

/**
 * Map a header cell to a canonical SHEET_HEADERS name (handles old aliases).
 */
function normalizeHeaderName(raw) {
  const h = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!h) return "";
  const aliases = {
    order: "Order",
    "order id": "Order",
    "orderid": "Order",
    "submit date": "Submit Date",
    "submitted at": "Submit Date",
    "submitted": "Submit Date",
    "order type": "Order Type",
    status: "Status",
    "customer name": "Customer Name",
    name: "Customer Name",
    email: "Email",
    "customer email": "Email",
    phone: "Phone",
    "customer phone": "Phone",
    "event date": "Event Date",
    "needed by": "Event Date",
    "line items": "Line Items",
    "line items (full detail)": "Line Items",
    "estimated subtotal": "Estimated Subtotal",
    subtotal: "Estimated Subtotal",
    "deposit due": "Deposit Due",
    "deposit due (50%)": "Deposit Due",
    deposit: "Deposit Due",
    "photo 1": "Photo 1",
    "photo 2": "Photo 2",
    "photo 3": "Photo 3",
    "stripe deposit": "Send Deposit Invoice",
    "send deposit invoice": "Send Deposit Invoice",
    "send deposit": "Send Deposit Invoice",
    "send invoice": "Send Deposit Invoice",
  };
  if (aliases[h]) return aliases[h];
  // Exact match against canonical headers (case-insensitive)
  for (const name of SHEET_HEADERS) {
    if (name.toLowerCase() === h) return name;
  }
  return "";
}

async function readHeaderRow(sheetId, tab) {
  const res = await sheetsApi(
    "GET",
    `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab)}!A1:Z1`,
  );
  return (res.values && res.values[0]) || [];
}

/**
 * Write one order row at the TOP of the sheet (row 2, right under headers).
 * Mapped by header name so full details land in the correct columns.
 */
async function appendOrderRow(record) {
  forceProductionTargets();
  const sheetId = getSheetId();
  // Always the live Order Log spreadsheet
  if (sheetId !== DEFAULT_ORDER_LOG_SHEET_ID) {
    throw new Error(`Refusing to write to unexpected sheet ${sheetId}`);
  }
  const tab = process.env.GOOGLE_SHEET_TAB || "Orders";

  await ensureHeaders();

  const valuesByHeader = buildOrderColumnValues(record);
  const headerRow = await readHeaderRow(sheetId, tab);

  // Prefer our canonical 15-column layout A–O
  let useHeaders = SHEET_HEADERS.slice();
  const mapped = headerRow.map(normalizeHeaderName);
  const hasCore =
    mapped.includes("Customer Name") &&
    mapped.includes("Email") &&
    mapped.includes("Line Items") &&
    mapped.includes("Estimated Subtotal");

  if (hasCore && headerRow.length >= SHEET_HEADERS.length) {
    // Use live header row order so we fill the columns the bakery actually sees
    useHeaders = headerRow.map((raw, i) => normalizeHeaderName(raw) || `COL_${i}`);
  }

  const width = Math.max(useHeaders.length, SHEET_HEADERS.length);
  const row = Array.from({ length: width }, () => "");

  // Fill by canonical name wherever that header sits
  for (let i = 0; i < useHeaders.length; i++) {
    const key = useHeaders[i];
    if (key && Object.prototype.hasOwnProperty.call(valuesByHeader, key)) {
      row[i] = valuesByHeader[key];
    }
  }

  // Safety: if mapping missed core fields (weird sheet), write positional A–O
  const nameIdx = useHeaders.indexOf("Customer Name");
  if (nameIdx < 0 || !row[nameIdx]) {
    SHEET_HEADERS.forEach((h, i) => {
      row[i] = valuesByHeader[h];
    });
  }

  const lastCol = colLetter(Math.max(SHEET_HEADERS.length, row.length) - 1);
  const outRow = row.slice(0, Math.max(SHEET_HEADERS.length, row.length));
  while (outRow.length < SHEET_HEADERS.length) outRow.push("");

  const gid = await getSheetGid(sheetId, tab);

  // Insert a blank data row at index 1 → becomes sheet row 2 (newest on top)
  await sheetsApi("POST", `/v4/spreadsheets/${sheetId}:batchUpdate`, {
    requests: [
      {
        insertDimension: {
          range: {
            sheetId: gid,
            dimension: "ROWS",
            startIndex: 1,
            endIndex: 2,
          },
          inheritFromBefore: false,
        },
      },
    ],
  });

  // Action cell starts empty — bakery opens the dropdown and picks "Send Deposit Invoice"
  // (pre-filling the label would not fire onEdit if they re-select the same value).
  const actionCol = SHEET_HEADERS.indexOf("Send Deposit Invoice");
  if (actionCol >= 0) {
    outRow[actionCol] = "";
  }

  // Write values into the new top row (A2:…)
  await sheetsApi(
    "PUT",
    `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab)}!A2:${lastCol}2?valueInputOption=USER_ENTERED`,
    { values: [outRow] },
  );

  // Style the action cell as a purple button + dropdown (not a checkbox)
  if (actionCol >= 0) {
    try {
      await sheetsApi("POST", `/v4/spreadsheets/${sheetId}:batchUpdate`, {
        requests: [
          {
            setDataValidation: {
              range: {
                sheetId: gid,
                startRowIndex: 1,
                endRowIndex: 2,
                startColumnIndex: actionCol,
                endColumnIndex: actionCol + 1,
              },
              rule: {
                condition: {
                  type: "ONE_OF_LIST",
                  values: [
                    { userEnteredValue: SEND_DEPOSIT_BUTTON_LABEL },
                    { userEnteredValue: SEND_DEPOSIT_SENT_LABEL },
                  ],
                },
                showCustomUi: true,
                strict: false,
              },
            },
          },
          {
            repeatCell: {
              range: {
                sheetId: gid,
                startRowIndex: 1,
                endRowIndex: 2,
                startColumnIndex: actionCol,
                endColumnIndex: actionCol + 1,
              },
              cell: {
                userEnteredValue: { stringValue: "" },
                userEnteredFormat: {
                  backgroundColor: { red: 0.48, green: 0.3, blue: 0.72 },
                  textFormat: {
                    bold: true,
                    foregroundColor: { red: 1, green: 1, blue: 1 },
                  },
                  horizontalAlignment: "CENTER",
                },
                note: "Open the dropdown and choose “Send Deposit Invoice” to email the 50% Stripe deposit after review.",
              },
              fields:
                "userEnteredValue,userEnteredFormat(backgroundColor,textFormat,horizontalAlignment),note",
            },
          },
        ],
      });
    } catch (e) {
      console.warn(
        "[sheets] Send Deposit Invoice button on row 2 skipped:",
        e.message,
      );
    }
  }

  console.log(
    "[sheets] insert order at row 2",
    valuesByHeader.Order,
    "→",
    sheetId.slice(0, 12) + "…",
    "name=",
    valuesByHeader["Customer Name"],
    "email=",
    valuesByHeader.Email,
    "phone=",
    valuesByHeader.Phone,
    "date=",
    valuesByHeader["Event Date"],
    "subtotal=",
    valuesByHeader["Estimated Subtotal"],
    "deposit=",
    valuesByHeader["Deposit Due"],
  );

  return {
    ok: true,
    orderId: record.orderId,
    sheetId,
    driveFolderId: getDriveFolderId(),
    insertedAtRow: 2,
    columns: {
      customerName: valuesByHeader["Customer Name"],
      email: valuesByHeader.Email,
      phone: valuesByHeader.Phone,
      eventDate: valuesByHeader["Event Date"],
      estimatedSubtotal: valuesByHeader["Estimated Subtotal"],
      depositDue: valuesByHeader["Deposit Due"],
      lineItemsPreview: String(valuesByHeader["Line Items"] || "").slice(0, 200),
    },
  };
}

async function saveOrder(record) {
  forceProductionTargets();
  if (!isConfigured()) {
    throw new Error(
      "Google Sheets is not configured. See GOOGLE-SHEETS-SETUP.md in your project folder.",
    );
  }

  let photoLinks = emptyPhotoSlots();
  let photoErrors = [];

  if (record.photoFiles?.length) {
    const uploaded = await uploadPhotosToDriveFromBuffers(
      record.orderId,
      record.photoFiles.slice(0, MAX_SHEET_PHOTOS),
    );
    photoLinks = uploaded.links;
    photoErrors = uploaded.errors;
  } else if (record.inspirationImages?.length) {
    const uploaded = await uploadPhotosToDrive(
      record.orderId,
      record.inspirationImages.slice(0, MAX_SHEET_PHOTOS),
    );
    photoLinks = uploaded.links;
    photoErrors = uploaded.errors;
  }

  photoLinks = sanitizePhotoLinksForSheet(photoLinks);

  const appended = await appendOrderRow({ ...record, photoLinks });

  let emailNotification = { sent: false };
  try {
    const notify = require("./notify");
    const result = await notify.sendNewOrderEmail(
      { ...record, photoLinks },
      photoLinks,
      photoErrors,
    );
    if (result.ok) {
      emailNotification = {
        sent: true,
        to: result.to,
        method: result.method,
        from: result.from,
      };
    } else if (result.skipped) {
      emailNotification = { sent: false, skipped: true, reason: result.reason };
    } else {
      emailNotification = {
        sent: false,
        error: result.error || result.reason || "email_failed",
      };
    }
  } catch (e) {
    console.error("[notify] Order email failed:", e.message);
    emailNotification = { sent: false, error: e.message };
  }

  return {
    ok: true,
    orderId: record.orderId,
    sheetId: appended.sheetId || getSheetId(),
    driveFolderId: appended.driveFolderId || getDriveFolderId(),
    insertedAtRow: appended.insertedAtRow || 2,
    columns: appended.columns || null,
    photoLinks,
    photoErrors,
    emailNotification,
  };
}

module.exports = {
  SHEET_HEADERS,
  SEND_DEPOSIT_BUTTON_LABEL,
  SEND_DEPOSIT_SENT_LABEL,
  MAX_PHOTO_BYTES,
  MAX_SHEET_PHOTOS,
  DEFAULT_ORDER_LOG_SHEET_ID,
  DEFAULT_DRIVE_FOLDER_ID,
  getSheetId,
  getDriveFolderId,
  forceProductionTargets,
  mimeToExt,
  isConfigured,
  sheetsSetupStatus,
  isDriveOAuthReady,
  ensureHeaders,
  saveOrder,
  buildOrderColumnValues,
  buildLineItemsCell,
  uploadPhotosToDrive,
  uploadPhotosToDriveFromBuffers,
  parseImagePayload,
  sanitizePhotoLinksForSheet,
  drivePhotoFileName,
  getUserAccessToken,
  httpsRequest,
};