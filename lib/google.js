/**
 * Google Sheets (service account) + inspiration photos (user OAuth → Drive).
 *
 * Production targets (defaults if .env / Render env is blank):
 *   GOOGLE_SHEET_ID     → "Sweet Tooth - Order Log"
 *                         13ch_g0giBozxwFqh1OVV-gTEqttmfC23xU9pNYFVxRs
 *   GOOGLE_DRIVE_FOLDER_ID → inspiration photos folder
 *                         1r-3-RrGjLbE4JHO32bMCDbId4O0jwKPE
 *
 * Sheet columns (do not reorder): Order ID, Submitted At, Order Type, Status,
 * Customer Name, Email, Phone, Event Date, product/notes fields, line items,
 * Estimated Subtotal, Deposit Due (50%), Photo 1–3 (shareable Drive links),
 * Tax Year, Stripe Deposit (checkbox / one-click Send Deposit Invoice).
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

/** Canonical live Order Log spreadsheet — do not change without updating Render + sharing. */
const DEFAULT_ORDER_LOG_SHEET_ID = "13ch_g0giBozxwFqh1OVV-gTEqttmfC23xU9pNYFVxRs";
/** Canonical live inspiration photos folder. */
const DEFAULT_DRIVE_FOLDER_ID = "1r-3-RrGjLbE4JHO32bMCDbId4O0jwKPE";

function getSheetId() {
  return (process.env.GOOGLE_SHEET_ID || "").trim() || DEFAULT_ORDER_LOG_SHEET_ID;
}

function getDriveFolderId() {
  return (process.env.GOOGLE_DRIVE_FOLDER_ID || "").trim() || DEFAULT_DRIVE_FOLDER_ID;
}

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

const SHEET_HEADERS = [
  "Order ID",
  "Submitted At",
  "Order Type",
  "Status",
  "Customer Name",
  "Email",
  "Phone",
  "Event Date",
  "Product / Cake",
  "Size / Tier",
  "Flavor",
  "Filling",
  "Decoration & Custom Notes",
  "Allergies",
  "Additional Notes",
  "Line Items (full detail)",
  "Estimated Subtotal",
  "Deposit Due (50%)",
  "Photo 1",
  "Photo 2",
  "Photo 3",
  "Tax Year",
  "Stripe Deposit",
];

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
  const jsonPath = resolveCredentialPath(
    process.env.GOOGLE_SERVICE_ACCOUNT_FILE,
    path.join("credentials", "google-service-account.json"),
  );
  const sheetId = getSheetId();
  const driveFolderId = getDriveFolderId();
  const envSheet = (process.env.GOOGLE_SHEET_ID || "").trim();
  const envDrive = (process.env.GOOGLE_DRIVE_FOLDER_ID || "").trim();
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
    usingDefaultSheetId: !envSheet,
    usingDefaultDriveFolderId: !envDrive,
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

async function ensureHeaders() {
  const sheetId = getSheetId();
  const tab = process.env.GOOGLE_SHEET_TAB || "Orders";
  const lastCol = String.fromCharCode(64 + Math.min(SHEET_HEADERS.length, 26));

  const existing = await sheetsApi(
    "GET",
    `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab)}!A1:${lastCol}1`,
  );

  const current = (existing.values?.[0] || []).map((h) => String(h || "").trim());
  const expected = SHEET_HEADERS.map((h) => String(h).trim());
  const headersMatch =
    current.length >= expected.length &&
    expected.every((h, i) => current[i] === h);

  if (headersMatch) return;

  // Rewrite header row to the cleaned schema (Photo 1–3, Stripe Deposit; no Source / Photo 4–6).
  await sheetsApi(
    "PUT",
    `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab)}!A1:${lastCol}1?valueInputOption=RAW`,
    { values: [SHEET_HEADERS] },
  );

  // Clear obsolete header cells past the new schema (Photo 4–6 / Source leftovers).
  const nextCol = String.fromCharCode(65 + SHEET_HEADERS.length); // e.g. X when headers fill A–W
  try {
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
    const stripeCol = SHEET_HEADERS.indexOf("Stripe Deposit");
    const requests = [
      {
        repeatCell: {
          range: { sheetId: gid, startRowIndex: 0, endRowIndex: 1 },
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
          properties: { sheetId: gid, gridProperties: { frozenRowCount: 1 } },
          fields: "gridProperties.frozenRowCount",
        },
      },
    ];
    // Highlight Stripe Deposit header so the one-click column is obvious
    if (stripeCol >= 0) {
      requests.push({
        repeatCell: {
          range: {
            sheetId: gid,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: stripeCol,
            endColumnIndex: stripeCol + 1,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.48, green: 0.3, blue: 0.72 },
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
            },
          },
          fields: "userEnteredFormat(backgroundColor,textFormat)",
        },
      });
    }
    await sheetsApi("POST", `/v4/spreadsheets/${sheetId}:batchUpdate`, { requests });
  } catch (e) {
    console.warn("[google] header formatting skipped:", e.message);
  }
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

async function appendOrderRow(record) {
  const sheetId = getSheetId();
  const tab = process.env.GOOGLE_SHEET_TAB || "Orders";

  await ensureHeaders();

  const subtotal = Number(record.estimatedSubtotal) || 0;
  const deposit = subtotal > 0 ? subtotal * 0.5 : "";
  const submitted = record.submittedAt || new Date().toISOString();
  const taxYear = new Date(submitted).getFullYear();

  const photoLinks = sanitizePhotoLinksForSheet(record.photoLinks || emptyPhotoSlots());

  const row = [
    record.orderId,
    submitted,
    record.orderType,
    record.status || "Pending Review",
    record.customerName,
    record.customerEmail,
    record.customerPhone || "",
    record.eventDate || "",
    record.product || "",
    record.size || "",
    record.flavor || "",
    record.filling || "",
    record.decorationNotes || "",
    record.allergies || "",
    record.additionalNotes || "",
    record.lineItemsDetail || "",
    money(subtotal),
    deposit ? money(deposit) : "",
    photoLinks[0] || "",
    photoLinks[1] || "",
    photoLinks[2] || "",
    String(taxYear),
    // Stripe Deposit: left blank for Apps Script checkbox / one-click Send Deposit Invoice
    "",
  ];

  await sheetsApi(
    "POST",
    `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab)}!A:W:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { values: [row] },
  );

  return { ok: true, orderId: record.orderId };
}

async function saveOrder(record) {
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

  await appendOrderRow({ ...record, photoLinks });

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
    }
  } catch (e) {
    console.error("[notify] Order email failed:", e.message);
    emailNotification = { sent: false, error: e.message };
  }

  return {
    ok: true,
    orderId: record.orderId,
    photoLinks,
    photoErrors,
    emailNotification,
  };
}

module.exports = {
  SHEET_HEADERS,
  MAX_PHOTO_BYTES,
  MAX_SHEET_PHOTOS,
  DEFAULT_ORDER_LOG_SHEET_ID,
  DEFAULT_DRIVE_FOLDER_ID,
  getSheetId,
  getDriveFolderId,
  mimeToExt,
  isConfigured,
  sheetsSetupStatus,
  isDriveOAuthReady,
  ensureHeaders,
  saveOrder,
  uploadPhotosToDrive,
  uploadPhotosToDriveFromBuffers,
  parseImagePayload,
  sanitizePhotoLinksForSheet,
  drivePhotoFileName,
  getUserAccessToken,
  httpsRequest,
};