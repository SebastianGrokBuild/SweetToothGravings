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
  "Stripe Deposit",
];

/** Dropdown action only — never include Sent/checkbox options (Sent is written after success). */
const SEND_DEPOSIT_BUTTON_LABEL = "Send Deposit Invoice";
const SEND_DEPOSIT_SENT_LABEL = "✓ Sent";
/** Narrow enough for the button text without stretching the sheet row. */
const SEND_DEPOSIT_COLUMN_WIDTH_PX = 120;

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
  const actionCol = SHEET_HEADERS.indexOf("Stripe Deposit");
  if (actionCol < 0) return;

  const requests = [
    {
      updateDimensionProperties: {
        range: {
          sheetId: gid,
          dimension: "COLUMNS",
          startIndex: actionCol,
          endIndex: actionCol + 1,
        },
        properties: {
          pixelSize: SEND_DEPOSIT_COLUMN_WIDTH_PX,
        },
        fields: "pixelSize",
      },
    },
    {
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
              fontSize: 8,
            },
            horizontalAlignment: "CENTER",
            wrapStrategy: "CLIP",
          },
        },
        fields:
          "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,wrapStrategy)",
      },
    },
    // Clear checkbox / old multi-option validation
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
    // Only one action option — no “Sent” checkbox garbage in the list
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
            values: [{ userEnteredValue: SEND_DEPOSIT_BUTTON_LABEL }],
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
          endRowIndex: 2000,
          startColumnIndex: actionCol,
          endColumnIndex: actionCol + 1,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.48, green: 0.3, blue: 0.72 },
            textFormat: {
              bold: true,
              foregroundColor: { red: 1, green: 1, blue: 1 },
              fontSize: 8,
            },
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
            wrapStrategy: "CLIP",
          },
        },
        fields:
          "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)",
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
    // Empty until bakery chooses “Send Deposit Invoice” from the dropdown
    "Stripe Deposit": "",
  };
}

/**
 * Short public order numbers: ST-YYMMDD-NNN (Miami / America/New_York calendar day).
 * Sequence is max(existing sheet Order column for that day, local counter) + 1.
 */
async function allocateOrderId() {
  forceProductionTargets();
  const sheetId = getSheetId();
  const tab = process.env.GOOGLE_SHEET_TAB || "Orders";

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const yy = parts.find((p) => p.type === "year")?.value || "00";
  const mm = parts.find((p) => p.type === "month")?.value || "01";
  const dd = parts.find((p) => p.type === "day")?.value || "01";
  const dayKey = `${yy}${mm}${dd}`;
  const prefix = `ST-${dayKey}-`;

  let maxSeq = 0;
  try {
    const res = await sheetsApi(
      "GET",
      `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab)}!A2:A1000`,
    );
    for (const row of res.values || []) {
      const v = String(row[0] || "").trim();
      if (!v.startsWith(prefix)) continue;
      const n = parseInt(v.slice(prefix.length), 10);
      if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
    }
  } catch (e) {
    console.warn("[orderId] sheet scan failed:", e.message);
  }

  // Local counter file survives across requests on the same instance
  try {
    const dataDir = path.join(ROOT, "data");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const seqPath = path.join(dataDir, `order-seq-${dayKey}.json`);
    let localMax = 0;
    if (fs.existsSync(seqPath)) {
      try {
        localMax = Number(JSON.parse(fs.readFileSync(seqPath, "utf8")).max) || 0;
      } catch {
        localMax = 0;
      }
    }
    if (localMax > maxSeq) maxSeq = localMax;
    const next = maxSeq + 1;
    fs.writeFileSync(seqPath, JSON.stringify({ max: next, prefix }) + "\n");
    return `${prefix}${String(next).padStart(3, "0")}`;
  } catch (e) {
    console.warn("[orderId] local counter failed:", e.message);
    return `${prefix}${String(maxSeq + 1).padStart(3, "0")}`;
  }
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
    "stripe deposit": "Stripe Deposit",
    "send deposit invoice": "Stripe Deposit",
    "send deposit": "Stripe Deposit",
    "send invoice": "Stripe Deposit",
    invoice: "Stripe Deposit",
    deposit: "Stripe Deposit",
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
 * Read recent Order Log rows (newest first at row 2).
 * Used by the mobile Admin page for Pending Review + Send Invoice.
 */
/** Extract a Drive file id from common link shapes stored in the sheet. */
function extractDriveFileId(url) {
  const s = String(url || "").trim();
  if (!s) return "";
  let m = s.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  m = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  m = s.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return "";
}

/**
 * Normalize sheet Photo cells into admin gallery items.
 * Returns [{ url, thumb, label }] for openable / displayable images only.
 */
function normalizeSheetPhotoLinks(rawLinks) {
  const out = [];
  const list = Array.isArray(rawLinks) ? rawLinks : [rawLinks];
  list.forEach((raw, i) => {
    const s = String(raw || "").trim();
    if (!s) return;
    // Skip error / placeholder text from failed uploads
    if (/^\(?upload failed/i.test(s) || /^too large/i.test(s) || s === "—") return;
    if (!/^https?:\/\//i.test(s) && !s.startsWith("data:image/")) return;

    const fileId = extractDriveFileId(s);
    let thumb = s;
    let openUrl = s;
    if (fileId) {
      // Public-ish Drive thumbnail (works when file is link-shared or domain-visible)
      thumb = `https://drive.google.com/thumbnail?id=${fileId}&sz=w600`;
      openUrl = `https://drive.google.com/file/d/${fileId}/view`;
    } else if (s.startsWith("data:image/")) {
      thumb = s;
      openUrl = s;
    }

    out.push({
      url: openUrl,
      thumb,
      label: `Photo ${out.length + 1}`,
      fileId: fileId || null,
    });
  });
  return out;
}

/** Split Order Log “Line Items” cell into cart lines + notes/allergies for admin UI. */
function parseLineItemsDetail(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return {
      cartText: "",
      cartLines: [],
      allergies: "",
      notes: "",
      additionalNotes: "",
      specialRequests: "",
    };
  }

  const allergies =
    (raw.match(/Allergies:\s*(.+?)(?:\n|$)/i) || [])[1]?.trim() || "";
  const notes =
    (raw.match(/Order notes:\s*(.+?)(?:\n|$)/i) || [])[1]?.trim() || "";
  const additionalNotes =
    (raw.match(/Additional:\s*(.+?)(?:\n|$)/i) || [])[1]?.trim() || "";
  // Special requests: decoration notes aliases or freeform
  const specialRequests =
    (raw.match(/(?:Special requests?|Decoration(?:\s*&\s*Custom)?\s*Notes?):\s*(.+?)(?:\n|$)/i) ||
      [])[1]?.trim() || notes;

  let cartText = raw;
  const cartMatch = raw.match(/—\s*Cart\s*—\s*([\s\S]*?)(?=—\s*Notes\s*—|—\s*Totals\s*—|$)/i);
  if (cartMatch) cartText = cartMatch[1].trim();
  else {
    // Drop notes/totals sections if present without cart header
    cartText = raw
      .split(/\n—\s*Notes\s*—/i)[0]
      .split(/\n—\s*Totals\s*—/i)[0]
      .replace(/^—\s*Cart\s*—\s*/i, "")
      .trim();
  }

  const cartLines = cartText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l &&
        !/^—/.test(l) &&
        !/^estimated subtotal/i.test(l) &&
        !/^deposit due/i.test(l) &&
        !/^allergies:/i.test(l) &&
        !/^order notes:/i.test(l) &&
        !/^additional:/i.test(l) &&
        !/^phone/i.test(l) &&
        !/^needed by:/i.test(l) &&
        !/^\(no line items\)/i.test(l),
    );

  return {
    cartText: cartLines.join("\n"),
    cartLines,
    allergies,
    notes,
    additionalNotes,
    specialRequests,
  };
}

/**
 * Update Status (and optional Stripe Deposit) for a sheet row by order id or row number.
 * Used after Admin “Send Invoice” → status becomes "Invoice Sent".
 */
async function updateOrderStatusInSheet({
  orderNumber,
  sheetRow,
  status = "Invoice Sent",
  // Only write Stripe Deposit column when a label is provided (null = leave alone)
  stripeDepositLabel = null,
} = {}) {
  forceProductionTargets();
  if (!isConfigured()) {
    throw new Error("Google Sheets is not configured");
  }
  const sheetId = getSheetId();
  if (sheetId !== DEFAULT_ORDER_LOG_SHEET_ID) {
    throw new Error(`Refusing to update unexpected sheet ${sheetId}`);
  }
  const tab = process.env.GOOGLE_SHEET_TAB || "Orders";
  const headers = (await readHeaderRow(sheetId, tab)).map((h) =>
    String(h || "").trim(),
  );

  const findCol = (names) => {
    const list = Array.isArray(names) ? names : [names];
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i].toLowerCase();
      for (const n of list) {
        if (h === String(n).toLowerCase()) return i;
      }
    }
    return -1;
  };

  const statusCol = findCol(["Status"]);
  if (statusCol < 0) throw new Error('Sheet has no "Status" column');
  const orderCol = findCol(["Order", "Order ID"]);
  const depositBtnCol = findCol([
    "Stripe Deposit",
    "Send Deposit Invoice",
    "Invoice",
  ]);

  let rowNum = Number(sheetRow) || 0;
  if (rowNum < 2 && orderNumber && orderCol >= 0) {
    const endRow = 250;
    const colLetter = columnIndexToLetter(orderCol);
    const range = `${tab}!${colLetter}2:${colLetter}${endRow}`;
    const res = await sheetsApi(
      "GET",
      `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
    );
    const vals = res.values || [];
    const want = String(orderNumber).trim().toLowerCase();
    for (let i = 0; i < vals.length; i++) {
      const v = String((vals[i] && vals[i][0]) || "")
        .trim()
        .toLowerCase();
      if (v && v === want) {
        rowNum = i + 2;
        break;
      }
    }
  }
  if (rowNum < 2) {
    throw new Error(
      `Could not find sheet row for order ${orderNumber || "(unknown)"}`,
    );
  }

  const statusCell = `${columnIndexToLetter(statusCol)}${rowNum}`;
  await sheetsApi(
    "PUT",
    `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab)}!${statusCell}?valueInputOption=USER_ENTERED`,
    { values: [[String(status)]] },
  );

  if (depositBtnCol >= 0 && stripeDepositLabel) {
    const depCell = `${columnIndexToLetter(depositBtnCol)}${rowNum}`;
    try {
      await sheetsApi(
        "PUT",
        `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab)}!${depCell}?valueInputOption=USER_ENTERED`,
        { values: [[String(stripeDepositLabel)]] },
      );
    } catch (e) {
      console.warn("[sheets] Stripe Deposit cell update skipped:", e.message);
    }
  }

  return {
    ok: true,
    sheetId,
    sheetRow: rowNum,
    status: String(status),
    orderNumber: orderNumber || null,
  };
}

/**
 * Rebuild Line Items cell from existing cart text + edited notes fields.
 * Preserves cart lines; replaces Notes block.
 */
function rebuildLineItemsDetail(existingDetail, {
  allergies,
  notes,
  additionalNotes,
  eventDate,
  customerPhone,
} = {}) {
  const raw = String(existingDetail || "");
  let cartPart = raw;
  const notesMarker = raw.search(/\n?\s*—\s*Notes\s*—\s*\n?/i);
  const totalsMarker = raw.search(/\n?\s*—\s*Totals\s*—\s*\n?/i);
  let cutAt = -1;
  if (notesMarker >= 0) cutAt = notesMarker;
  if (totalsMarker >= 0 && (cutAt < 0 || totalsMarker < cutAt)) cutAt = totalsMarker;
  if (cutAt >= 0) cartPart = raw.slice(0, cutAt).trim();
  // Drop leading "— Cart —" for cleaner rebuild
  cartPart = cartPart.replace(/^\s*—\s*Cart\s*—\s*\n?/i, "").trim();

  const chunks = [];
  if (cartPart) {
    chunks.push("— Cart —");
    chunks.push(cartPart);
  }

  const notesBlock = [];
  if (notes) notesBlock.push(`Order notes: ${notes}`);
  if (allergies) notesBlock.push(`Allergies: ${allergies}`);
  if (additionalNotes) notesBlock.push(`Additional: ${additionalNotes}`);
  if (customerPhone) notesBlock.push(`Phone (confirm): ${customerPhone}`);
  if (eventDate) notesBlock.push(`Needed by: ${eventDate}`);
  if (notesBlock.length) {
    chunks.push("— Notes —");
    chunks.push(...notesBlock);
  }

  return chunks.filter(Boolean).join("\n") || raw || "(no line items)";
}

/**
 * Update editable customer/order fields on a sheet row (Admin edit form).
 * fields: customerName, customerEmail, customerPhone, eventDate,
 *         allergies, notes, additionalNotes, estimatedSubtotal (optional)
 */
async function updateOrderFieldsInSheet({
  orderNumber,
  sheetRow,
  fields = {},
} = {}) {
  forceProductionTargets();
  if (!isConfigured()) {
    throw new Error("Google Sheets is not configured");
  }
  const sheetId = getSheetId();
  if (sheetId !== DEFAULT_ORDER_LOG_SHEET_ID) {
    throw new Error(`Refusing to update unexpected sheet ${sheetId}`);
  }
  const tab = process.env.GOOGLE_SHEET_TAB || "Orders";
  const headers = (await readHeaderRow(sheetId, tab)).map((h) =>
    String(h || "").trim(),
  );

  const findCol = (names) => {
    const list = Array.isArray(names) ? names : [names];
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i].toLowerCase();
      for (const n of list) {
        if (h === String(n).toLowerCase()) return i;
      }
    }
    return -1;
  };

  const orderCol = findCol(["Order", "Order ID"]);
  const nameCol = findCol(["Customer Name", "Name"]);
  const emailCol = findCol(["Email", "Customer Email"]);
  const phoneCol = findCol(["Phone"]);
  const eventCol = findCol(["Event Date"]);
  const linesCol = findCol(["Line Items"]);
  const subCol = findCol(["Estimated Subtotal", "Subtotal"]);
  const depCol = findCol(["Deposit Due", "Deposit"]);

  let rowNum = Number(sheetRow) || 0;
  if (rowNum < 2 && orderNumber && orderCol >= 0) {
    const endRow = 250;
    const colLetter = columnIndexToLetter(orderCol);
    const range = `${tab}!${colLetter}2:${colLetter}${endRow}`;
    const res = await sheetsApi(
      "GET",
      `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
    );
    const vals = res.values || [];
    const want = String(orderNumber).trim().toLowerCase();
    for (let i = 0; i < vals.length; i++) {
      const v = String((vals[i] && vals[i][0]) || "")
        .trim()
        .toLowerCase();
      if (v && v === want) {
        rowNum = i + 2;
        break;
      }
    }
  }
  if (rowNum < 2) {
    throw new Error(
      `Could not find sheet row for order ${orderNumber || "(unknown)"}`,
    );
  }

  const data = [];
  const updated = {};

  const put = (col, value, key) => {
    if (col < 0 || value === undefined) return;
    const cell = `${columnIndexToLetter(col)}${rowNum}`;
    data.push({
      range: `${tab}!${cell}`,
      values: [[value == null ? "" : String(value)]],
    });
    if (key) updated[key] = value == null ? "" : String(value);
  };

  if (fields.customerName !== undefined) {
    put(nameCol, String(fields.customerName || "").trim(), "customerName");
  }
  if (fields.customerEmail !== undefined) {
    put(emailCol, String(fields.customerEmail || "").trim(), "customerEmail");
  }
  if (fields.customerPhone !== undefined) {
    put(phoneCol, String(fields.customerPhone || "").trim(), "customerPhone");
  }
  if (fields.eventDate !== undefined) {
    put(eventCol, String(fields.eventDate || "").trim(), "eventDate");
  }

  const touchNotes =
    fields.allergies !== undefined ||
    fields.notes !== undefined ||
    fields.additionalNotes !== undefined ||
    fields.lineItemsDetail !== undefined;

  if (touchNotes && linesCol >= 0) {
    let nextLines = fields.lineItemsDetail;
    if (nextLines === undefined) {
      // Read current Line Items cell so we preserve cart lines
      const linesCell = `${columnIndexToLetter(linesCol)}${rowNum}`;
      let existing = "";
      try {
        const cur = await sheetsApi(
          "GET",
          `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab)}!${linesCell}`,
        );
        existing =
          cur.values && cur.values[0] && cur.values[0][0] != null
            ? String(cur.values[0][0])
            : "";
      } catch (e) {
        console.warn("[sheets] read Line Items for edit failed:", e.message);
      }
      nextLines = rebuildLineItemsDetail(existing, {
        allergies:
          fields.allergies !== undefined ? fields.allergies : undefined,
        notes: fields.notes !== undefined ? fields.notes : undefined,
        additionalNotes:
          fields.additionalNotes !== undefined
            ? fields.additionalNotes
            : undefined,
        eventDate:
          fields.eventDate !== undefined ? fields.eventDate : undefined,
        customerPhone:
          fields.customerPhone !== undefined
            ? fields.customerPhone
            : undefined,
      });
      // If only some note fields were sent, merge with parsed existing
      if (
        fields.allergies === undefined ||
        fields.notes === undefined ||
        fields.additionalNotes === undefined
      ) {
        const parsed = parseLineItemsDetail(existing);
        nextLines = rebuildLineItemsDetail(existing, {
          allergies:
            fields.allergies !== undefined
              ? String(fields.allergies || "").trim()
              : parsed.allergies,
          notes:
            fields.notes !== undefined
              ? String(fields.notes || "").trim()
              : parsed.notes || parsed.specialRequests,
          additionalNotes:
            fields.additionalNotes !== undefined
              ? String(fields.additionalNotes || "").trim()
              : parsed.additionalNotes,
          eventDate:
            fields.eventDate !== undefined
              ? String(fields.eventDate || "").trim()
              : undefined,
          customerPhone:
            fields.customerPhone !== undefined
              ? String(fields.customerPhone || "").trim()
              : undefined,
        });
      }
    }
    put(linesCol, String(nextLines || "").trim(), "lineItemsDetail");
    if (fields.allergies !== undefined) {
      updated.allergies = String(fields.allergies || "").trim();
    }
    if (fields.notes !== undefined) {
      updated.notes = String(fields.notes || "").trim();
    }
    if (fields.additionalNotes !== undefined) {
      updated.additionalNotes = String(fields.additionalNotes || "").trim();
    }
  }

  if (fields.estimatedSubtotal !== undefined && fields.estimatedSubtotal !== null && fields.estimatedSubtotal !== "") {
    const sub = Number(fields.estimatedSubtotal);
    if (Number.isFinite(sub) && sub >= 0) {
      const moneyStr = sub > 0 ? `$${sub.toFixed(2)}` : "";
      put(subCol, moneyStr, "estimatedSubtotal");
      if (depCol >= 0) {
        const dep = Math.round(sub * 50) / 100;
        put(depCol, dep > 0 ? `$${dep.toFixed(2)}` : "", "depositAmount");
      }
      updated.estimatedSubtotal = sub;
    }
  }

  if (!data.length) {
    throw new Error("No editable fields provided");
  }

  await sheetsApi(
    "POST",
    `/v4/spreadsheets/${sheetId}/values:batchUpdate`,
    {
      valueInputOption: "USER_ENTERED",
      data,
    },
  );

  return {
    ok: true,
    sheetId,
    sheetRow: rowNum,
    orderNumber: orderNumber || null,
    updated,
  };
}

/** 0-based column index → A1 letter(s). */
function columnIndexToLetter(index) {
  let n = Number(index) + 1;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function listRecentOrdersFromSheet({ limit = 80 } = {}) {
  forceProductionTargets();
  if (!isConfigured()) {
    return { ok: false, orders: [], error: "Google Sheets not configured" };
  }
  const sheetId = getSheetId();
  const tab = process.env.GOOGLE_SHEET_TAB || "Orders";
  const endRow = Math.max(2, Math.min(Number(limit) || 80, 200) + 1);
  // Include Photo 1–3 (+ Stripe Deposit) — full header row width
  const range = `${tab}!A1:Z${endRow}`;
  const res = await sheetsApi(
    "GET",
    `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`,
  );
  const values = res.values || [];
  if (values.length < 2) return { ok: true, orders: [], sheetId };

  const headers = values[0].map((h) => String(h || "").trim());
  const idx = (names) => {
    const list = Array.isArray(names) ? names : [names];
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i].toLowerCase();
      for (const n of list) {
        if (h === String(n).toLowerCase()) return i;
      }
    }
    return -1;
  };

  const iOrder = idx(["Order", "Order ID"]);
  const iStatus = idx(["Status"]);
  const iName = idx(["Customer Name", "Name"]);
  const iEmail = idx(["Email", "Customer Email"]);
  const iPhone = idx(["Phone"]);
  const iEvent = idx(["Event Date"]);
  const iLines = idx(["Line Items"]);
  const iSub = idx(["Estimated Subtotal", "Subtotal"]);
  const iDep = idx(["Deposit Due", "Deposit"]);
  const iType = idx(["Order Type"]);
  const iSubmit = idx(["Submit Date"]);
  const iPhoto1 = idx(["Photo 1", "Photo1", "Inspiration 1"]);
  const iPhoto2 = idx(["Photo 2", "Photo2", "Inspiration 2"]);
  const iPhoto3 = idx(["Photo 3", "Photo3", "Inspiration 3"]);

  const cell = (row, i) =>
    i >= 0 && row[i] != null ? String(row[i]).trim() : "";

  const parseMoney = (raw) => {
    if (raw == null || raw === "") return null;
    const s = String(raw).replace(/[^0-9.,-]/g, "");
    if (!s) return null;
    const n = Number(s.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  };

  const orders = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r] || [];
    const orderId = cell(row, iOrder);
    const email = cell(row, iEmail);
    // Skip blank / header-like rows
    if (!orderId && !email && !cell(row, iName)) continue;

    const subtotal = parseMoney(cell(row, iSub));
    let deposit = parseMoney(cell(row, iDep));
    if ((deposit == null || deposit <= 0) && subtotal != null && subtotal > 0) {
      deposit = Math.round(subtotal * 50) / 100;
    }

    const rawPhotos = [cell(row, iPhoto1), cell(row, iPhoto2), cell(row, iPhoto3)];
    const photos = normalizeSheetPhotoLinks(rawPhotos);
    const lineItemsDetail = cell(row, iLines);
    const parsed = parseLineItemsDetail(lineItemsDetail);

    const status = cell(row, iStatus) || "Pending Review";
    orders.push({
      id: orderId || `row-${r + 1}`,
      orderNumber: orderId || `row-${r + 1}`,
      sheetRow: r + 1,
      status,
      customerName: cell(row, iName),
      customerEmail: email,
      customerPhone: cell(row, iPhone),
      eventDate: cell(row, iEvent),
      lineItemsDetail,
      cartLines: parsed.cartLines,
      cartText: parsed.cartText,
      allergies: parsed.allergies,
      notes: parsed.notes,
      additionalNotes: parsed.additionalNotes,
      specialRequests: parsed.specialRequests,
      estimatedSubtotal: subtotal,
      depositAmount: deposit,
      depositDue: deposit,
      orderType: cell(row, iType),
      createdAt: cell(row, iSubmit) || null,
      photo1: rawPhotos[0] || "",
      photo2: rawPhotos[1] || "",
      photo3: rawPhotos[2] || "",
      photos,
      photoLinks: rawPhotos.filter(Boolean),
      source: "google_sheet",
    });
  }

  return { ok: true, orders, sheetId };
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

  // Action cell empty — bakery opens dropdown → “Send Deposit Invoice” (fires onEdit)
  const actionCol = SHEET_HEADERS.indexOf("Stripe Deposit");
  if (actionCol >= 0) {
    outRow[actionCol] = "";
  }

  // Write values into the new top row (A2:…)
  await sheetsApi(
    "PUT",
    `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab)}!A2:${lastCol}2?valueInputOption=USER_ENTERED`,
    { values: [outRow] },
  );

  // Narrow purple dropdown (only “Send Deposit Invoice” — no checkbox, no Sent option)
  if (actionCol >= 0) {
    try {
      await sheetsApi("POST", `/v4/spreadsheets/${sheetId}:batchUpdate`, {
        requests: [
          {
            updateDimensionProperties: {
              range: {
                sheetId: gid,
                dimension: "COLUMNS",
                startIndex: actionCol,
                endIndex: actionCol + 1,
              },
              properties: { pixelSize: SEND_DEPOSIT_COLUMN_WIDTH_PX },
              fields: "pixelSize",
            },
          },
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
                  values: [{ userEnteredValue: SEND_DEPOSIT_BUTTON_LABEL }],
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
                    fontSize: 8,
                  },
                  horizontalAlignment: "CENTER",
                  verticalAlignment: "MIDDLE",
                  wrapStrategy: "CLIP",
                },
                note: "After review: choose “Send Deposit Invoice” to email the 50% Stripe deposit to this row’s Email.",
              },
              fields:
                "userEnteredValue,userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy),note",
            },
          },
        ],
      });
    } catch (e) {
      console.warn("[sheets] Stripe Deposit button on row 2 skipped:", e.message);
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

  // Owner notification is required for ops — never block the sheet write if email fails.
  let emailNotification = { sent: false };
  try {
    const notify = require("./notify");
    const payload = {
      ...record,
      photoLinks,
      // Ensure deposit is present for the owner email body
      depositAmount:
        record.depositAmount != null
          ? record.depositAmount
          : Number(record.estimatedSubtotal) > 0
            ? Math.round(Number(record.estimatedSubtotal) * 50) / 100
            : null,
    };
    const result = await notify.sendNewOrderEmail(
      payload,
      photoLinks,
      photoErrors,
    );
    if (result && result.ok) {
      emailNotification = {
        sent: true,
        to: result.to,
        method: result.method,
        from: result.from,
        subject: `New Order Received – ${record.orderId}`,
      };
      console.log(
        `[saveOrder] Owner notify OK order=${record.orderId} to=${result.to} via=${result.method}`,
      );
    } else if (result && result.skipped) {
      emailNotification = { sent: false, skipped: true, reason: result.reason };
      console.warn(
        `[saveOrder] Owner notify skipped order=${record.orderId}: ${result.reason}`,
      );
    } else {
      emailNotification = {
        sent: false,
        error:
          (result && (result.error || result.reason)) || "email_failed",
      };
      console.error(
        `[saveOrder] Owner notify failed order=${record.orderId}:`,
        emailNotification.error,
      );
    }
  } catch (e) {
    console.error(
      `[saveOrder] Owner notify exception order=${record.orderId}:`,
      e.message,
    );
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

/**
 * Re-append an order row (for Admin undo after delete).
 * Accepts either a sheet list shape or a saveOrder record shape.
 */
async function restoreOrderToSheet(order) {
  forceProductionTargets();
  if (!isConfigured()) {
    throw new Error("Google Sheets is not configured");
  }
  if (!order || typeof order !== "object") {
    throw new Error("Order payload required to restore");
  }
  const orderId = String(
    order.orderId || order.orderNumber || order.id || "",
  ).trim();
  if (!orderId) throw new Error("Order number required to restore");

  const photoLinks = Array.isArray(order.photoLinks)
    ? order.photoLinks
    : [order.photo1, order.photo2, order.photo3].filter(Boolean);

  const record = {
    orderId,
    orderType: order.orderType || "Menu Order",
    status: order.status || "Pending Review",
    customerName: order.customerName || "",
    customerEmail: order.customerEmail || "",
    customerPhone: order.customerPhone || "",
    eventDate: order.eventDate || "",
    lineItemsDetail: order.lineItemsDetail || order.cartText || "",
    estimatedSubtotal:
      order.estimatedSubtotal != null
        ? Number(order.estimatedSubtotal)
        : order.subtotal != null
          ? Number(order.subtotal)
          : 0,
    photoLinks,
    allergies: order.allergies || "",
    decorationNotes:
      order.decorationNotes || order.notes || order.specialRequests || "",
    additionalNotes: order.additionalNotes || "",
    submittedAt: order.createdAt || order.submittedAt || new Date().toISOString(),
  };

  const appended = await appendOrderRow(record);
  return {
    ok: true,
    orderId,
    sheetRow: appended.insertedAtRow || null,
    sheetId: appended.sheetId || getSheetId(),
  };
}

/**
 * Delete a single order row from the Order Log sheet (by order number and/or row).
 * Used by Admin to remove test orders.
 */
async function deleteOrderFromSheet({ orderNumber, sheetRow } = {}) {
  forceProductionTargets();
  if (!isConfigured()) {
    throw new Error("Google Sheets is not configured");
  }
  const sheetId = getSheetId();
  if (sheetId !== DEFAULT_ORDER_LOG_SHEET_ID) {
    throw new Error(`Refusing to update unexpected sheet ${sheetId}`);
  }
  const tab = process.env.GOOGLE_SHEET_TAB || "Orders";
  const headers = (await readHeaderRow(sheetId, tab)).map((h) =>
    String(h || "").trim(),
  );
  const findCol = (names) => {
    const list = Array.isArray(names) ? names : [names];
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i].toLowerCase();
      for (const n of list) {
        if (h === String(n).toLowerCase()) return i;
      }
    }
    return -1;
  };
  const orderCol = findCol(["Order", "Order ID"]);

  let rowNum = Number(sheetRow) || 0;
  if (rowNum < 2 && orderNumber && orderCol >= 0) {
    const endRow = 500;
    const colLetter = columnIndexToLetter(orderCol);
    const range = `${tab}!${colLetter}2:${colLetter}${endRow}`;
    const res = await sheetsApi(
      "GET",
      `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
    );
    const vals = res.values || [];
    const want = String(orderNumber).trim().toLowerCase();
    for (let i = 0; i < vals.length; i++) {
      const v = String((vals[i] && vals[i][0]) || "")
        .trim()
        .toLowerCase();
      if (v && v === want) {
        rowNum = i + 2;
        break;
      }
    }
  }
  if (rowNum < 2) {
    throw new Error(
      `Could not find sheet row for order ${orderNumber || "(unknown)"}`,
    );
  }

  const gid = await getSheetGid(sheetId, tab);
  // Sheets API uses 0-based indexes; spreadsheet row N → startIndex N-1
  await sheetsApi("POST", `/v4/spreadsheets/${sheetId}:batchUpdate`, {
    requests: [
      {
        deleteDimension: {
          range: {
            sheetId: gid,
            dimension: "ROWS",
            startIndex: rowNum - 1,
            endIndex: rowNum,
          },
        },
      },
    ],
  });
  console.log(
    "[google] deleted sheet row",
    rowNum,
    "order",
    orderNumber || "(by row)",
  );
  return { ok: true, sheetRow: rowNum, orderNumber: orderNumber || null };
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
  allocateOrderId,
  mimeToExt,
  isConfigured,
  sheetsSetupStatus,
  isDriveOAuthReady,
  ensureHeaders,
  saveOrder,
  listRecentOrdersFromSheet,
  updateOrderStatusInSheet,
  updateOrderFieldsInSheet,
  deleteOrderFromSheet,
  restoreOrderToSheet,
  rebuildLineItemsDetail,
  parseLineItemsDetail,
  normalizeSheetPhotoLinks,
  extractDriveFileId,
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