#!/usr/bin/env node
/**
 * Sweet Tooth Cravings — local server
 * Run:  node serve.js
 * Stop: Ctrl+C in the terminal
 */
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const os = require("os");

const ROOT = __dirname;
const google = require("./lib/google");
const notify = require("./lib/notify");
const { parseMultipart } = require("./lib/multipart");
const HOST = "0.0.0.0";
const PREFERRED_PORT = Number(process.env.PORT) || 8080;
const UPLOADS = path.join(ROOT, "uploads");
const DATA = path.join(ROOT, "data");
const ORDERS = path.join(DATA, "orders.json");

loadEnv(path.join(ROOT, ".env"));

// Always pin Order Log + Drive folder — never write to a wrong spreadsheet.
if (typeof google.forceProductionTargets === "function") {
  google.forceProductionTargets();
}

/** Bump on every force-redeploy so health/cart-submit prove the new binary is live. */
const DEPLOY_BUILD = "2026-07-28-mobile-admin-v15";
const EXPECTED_SHEET_ID = "13ch_g0giBozxwFqh1OVV-gTEqttmfC23xU9pNYFVxRs";
const EXPECTED_DRIVE_ID = "1r-3-RrGjLbE4JHO32bMCDbId4O0jwKPE";

/** Sweet Tooth Cravings Stripe account — deposit invoices must use this account. */
const EXPECTED_STRIPE_ACCOUNT_ID =
  (process.env.STRIPE_ACCOUNT_ID || "acct_1TcrMNHTYIZb4z2l").trim();

const CONFIG = {
  adminPassword: process.env.ADMIN_PASSWORD || "sweettooth-admin",
  sessionSecret: process.env.SESSION_SECRET || "sweettooth-local-secret",
  stripeKey: process.env.STRIPE_SECRET_KEY || "",
  stripeAccountId: EXPECTED_STRIPE_ACCOUNT_ID,
};

ensureDirs();
console.log(
  `[boot] ${DEPLOY_BUILD} sheet=${EXPECTED_SHEET_ID} drive=${EXPECTED_DRIVE_ID} ` +
    `forced=${google.getSheetId() === EXPECTED_SHEET_ID && google.getDriveFolderId() === EXPECTED_DRIVE_ID} ` +
    `stripeMode=${stripeKeyMode()}`,
);

/** Cache of Stripe /v1/account probe (id must match EXPECTED_STRIPE_ACCOUNT_ID). */
let stripeAccountCache = null;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ─── Storage ───────────────────────────────────────────────────────────────

function ensureDirs() {
  for (const d of [UPLOADS, DATA]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
  if (!fs.existsSync(ORDERS)) fs.writeFileSync(ORDERS, "[]\n");
}

function loadOrders() {
  try {
    return JSON.parse(fs.readFileSync(ORDERS, "utf8"));
  } catch {
    return [];
  }
}

function saveOrders(list) {
  fs.writeFileSync(ORDERS, JSON.stringify(list, null, 2) + "\n");
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'")) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

function id() {
  return crypto.randomBytes(10).toString("hex");
}

/** Prefer short ST-YYMMDD-NNN order numbers; fall back to hex id. */
async function nextOrderId() {
  try {
    if (typeof google.allocateOrderId === "function") {
      return await google.allocateOrderId();
    }
  } catch (e) {
    console.warn("[orderId] allocate failed, using random:", e.message);
  }
  return id();
}

/**
 * Cart-submit idempotency: same clientRequestId must never create a second sheet row.
 * Cached successes live in memory for 48h (Render free tier may recycle; still blocks double-clicks).
 */
const CART_SUBMIT_IDEMPOTENCY_TTL_MS = 48 * 60 * 60 * 1000;
const cartSubmitResults = new Map(); // key -> { at, response }
const cartSubmitInflight = new Map(); // key -> Promise

function normalizeClientRequestId(raw) {
  const s = String(raw || "").trim().slice(0, 128);
  if (!s) return "";
  if (!/^[A-Za-z0-9._:-]+$/.test(s)) return "";
  return s;
}

function pruneCartSubmitCache() {
  const now = Date.now();
  for (const [k, v] of cartSubmitResults) {
    if (!v || now - v.at > CART_SUBMIT_IDEMPOTENCY_TTL_MS) cartSubmitResults.delete(k);
  }
}

function getCachedCartSubmit(key) {
  if (!key) return null;
  pruneCartSubmitCache();
  const hit = cartSubmitResults.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CART_SUBMIT_IDEMPOTENCY_TTL_MS) {
    cartSubmitResults.delete(key);
    return null;
  }
  return hit.response;
}

function setCachedCartSubmit(key, response) {
  if (!key || !response) return;
  pruneCartSubmitCache();
  cartSubmitResults.set(key, { at: Date.now(), response });
}

function adminToken() {
  return crypto
    .createHmac("sha256", CONFIG.sessionSecret)
    .update("stc-admin")
    .digest("hex");
}

function cookies(header) {
  const o = {};
  if (!header) return o;
  for (const p of header.split(";")) {
    const [k, ...v] = p.trim().split("=");
    o[k] = decodeURIComponent(v.join("="));
  }
  return o;
}

/** Accepted admin / sheet-action passwords (Bearer or login form). */
function adminPasswordCandidates() {
  const list = [
    process.env.ADMIN_PASSWORD?.trim(),
    process.env.SHEET_ACTIONS_SECRET?.trim(),
    CONFIG.adminPassword,
    "sweettooth2026",
    "sweettooth-admin",
  ].filter(Boolean);
  return [...new Set(list)];
}

function passwordMatchesAdmin(password) {
  const p = String(password || "");
  if (!p) return false;
  for (const expected of adminPasswordCandidates()) {
    try {
      const a = Buffer.from(p);
      const b = Buffer.from(expected);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    } catch {
      /* length mismatch */
    }
  }
  return false;
}

function bearerPassword(req) {
  const auth = req.headers.authorization || "";
  if (/^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }
  return "";
}

function isAdmin(req) {
  const bearer = bearerPassword(req);
  if (bearer && passwordMatchesAdmin(bearer)) return true;

  const t = cookies(req.headers.cookie).stc_admin;
  if (!t) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(adminToken()));
  } catch {
    return false;
  }
}

/** Shared secret for Google Apps Script sheet actions (or ADMIN_PASSWORD fallback). */
function sheetActionsSecret() {
  return (
    process.env.SHEET_ACTIONS_SECRET?.trim() ||
    process.env.ADMIN_PASSWORD?.trim() ||
    CONFIG.adminPassword ||
    ""
  );
}

function isSheetActionAuthorized(req) {
  const provided =
    bearerPassword(req) ||
    String(req.headers["x-sheet-secret"] || "").trim();
  if (!provided) return false;
  return passwordMatchesAdmin(provided);
}

/** True when status means bakery still needs to review / send deposit. */
function isPendingReviewStatus(status) {
  const s = String(status || "")
    .trim()
    .toLowerCase();
  if (!s) return true;
  return (
    s === "pending review" ||
    s === "pending_review" ||
    s === "needs review" ||
    s === "new" ||
    s.indexOf("pending") === 0
  );
}

/** Parse "$45.00" / "45" / "45,00" / "USD 45" style values from the sheet. */
function parseMoneyValue(raw) {
  if (raw == null || raw === "") return NaN;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  let s = String(raw).trim();
  if (!s || /^[-—–]$/.test(s) || /^n\/?a$/i.test(s)) return NaN;
  // Prefer last $amount in the string (handles "Est. $10 / deposit $5")
  const dollar = s.match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/);
  if (dollar) {
    const n = Number(dollar[1].replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  s = s.replace(/[^0-9.,-]/g, "");
  if (!s || s === "-" || s === "." || s === ",") return NaN;
  if (s.includes(",") && s.includes(".")) {
    // 1,234.56
    s = s.replace(/,/g, "");
  } else if (s.includes(",") && !s.includes(".")) {
    // 45,00 european → 45.00
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/** Bakery inboxes — never use as the customer invoice recipient. */
function isBakeryInboxEmail(email) {
  const e = String(email || "")
    .trim()
    .toLowerCase();
  if (!e.includes("@")) return false;
  const bakery = String(
    process.env.ORDER_NOTIFY_EMAIL || "sweettoothcravingsorder@gmail.com",
  )
    .trim()
    .toLowerCase();
  if (e === bakery) return true;
  return (
    e.includes("sweettoothcravingsorder@") ||
    e === "sweettoothcravings@gmail.com" ||
    e.endsWith("@sweettoothcravings.shop")
  );
}

/**
 * Parse Order Log "Line Items" cell into invoice lines.
 * Handles cart-submit format:
 *   1. 2× Name | Size/Tier: 8" | Flavor: X | Line total: $40.00
 */
function parseSheetLineItems(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const items = [];
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^—+\s*(cart|notes|totals)\s*—+/i.test(t)) continue;
    if (/^product:/i.test(t)) continue;
    if (/^estimated subtotal:/i.test(t)) continue;
    if (/^deposit due/i.test(t)) continue;
    if (/^order notes:/i.test(t) || /^allergies:/i.test(t)) continue;
    if (/^additional:/i.test(t) || /^phone/i.test(t) || /^needed by:/i.test(t))
      continue;
    if (/^\(no line items\)/i.test(t)) continue;

    // "1. 2× Name | Size/Tier: … | Flavor: … | Line total: $40.00"
    let m = t.match(
      /^(?:\d+\.\s*)?(\d+)\s*[x×]\s+(.+?)(?:\s*\|\s*|$)/i,
    );
    let qty = 1;
    let name = "";
    let rest = t;
    if (m) {
      qty = Math.max(1, parseInt(m[1], 10) || 1);
      name = m[2].trim();
      rest = t.slice(m[0].length);
    } else {
      // "Name | Size: … | $40"
      const parts = t.split("|").map((p) => p.trim());
      if (parts.length >= 1 && !/^size\/?tier:/i.test(parts[0])) {
        name = parts[0].replace(/^\d+\.\s*/, "").trim();
        rest = parts.slice(1).join(" | ");
      } else {
        continue;
      }
    }

    if (!name || /^menu items/i.test(name) || /^custom cake \(see/i.test(name)) {
      // still allow if it has a line total and details
      if (!/line total:|\$\s*\d/i.test(t)) continue;
    }

    const size =
      (t.match(/Size\/?Tier:\s*([^|]+)/i) || t.match(/Size:\s*([^|]+)/i) || [])[1] ||
      "";
    const flavor = (t.match(/Flavor:\s*([^|]+)/i) || [])[1] || "";
    const filling =
      (t.match(/Fillings?:\s*([^|]+)/i) || t.match(/Filling:\s*([^|]+)/i) || [])[1] ||
      "";
    const itemNotes = (t.match(/Item notes:\s*([^|]+)/i) || [])[1] || "";
    let lineTotal = parseMoneyValue(
      (t.match(/Line total:\s*(\$?[0-9.,]+)/i) || [])[1] || "",
    );
    if (!Number.isFinite(lineTotal) || lineTotal <= 0) {
      // last $amount on the line
      const all = [...t.matchAll(/\$\s*([0-9,.]+)/g)];
      if (all.length) lineTotal = parseMoneyValue(all[all.length - 1][0]);
    }
    if (!Number.isFinite(lineTotal) || lineTotal <= 0) {
      // description-only line (no price) — still show on invoice as $0 detail via memo; skip amount
      // Keep as free-text detail without a price
    }

    const bits = [];
    const cleanName = name.replace(/\s+/g, " ").trim() || "Item";
    bits.push(`${qty}× ${cleanName}`);
    if (size.trim()) bits.push(`Size: ${size.trim()}`);
    if (flavor.trim()) bits.push(`Flavor: ${flavor.trim()}`);
    if (filling.trim()) bits.push(`Filling: ${filling.trim()}`);
    if (itemNotes.trim()) bits.push(itemNotes.trim());
    if (Number.isFinite(lineTotal) && lineTotal > 0) {
      bits.push(`@ $${lineTotal.toFixed(2)}`);
    }

    items.push({
      quantity: qty,
      name: cleanName,
      size: size.trim(),
      flavor: flavor.trim(),
      filling: filling.trim(),
      lineTotalDollars: Number.isFinite(lineTotal) && lineTotal > 0 ? lineTotal : null,
      amountCents:
        Number.isFinite(lineTotal) && lineTotal > 0
          ? Math.round(lineTotal * 100)
          : null,
      description: bits.join(" · ").slice(0, 500),
      raw: t,
    });
  }

  return items;
}

/** Pull Estimated Subtotal / Deposit Due from Line Items “— Totals —” block or line sums. */
function extractTotalsFromLineItems(text) {
  const raw = String(text || "");
  let subtotal = NaN;
  let deposit = NaN;
  const subM = raw.match(/Estimated\s+subtotal:\s*(\$?[0-9.,]+)/i);
  if (subM) subtotal = parseMoneyValue(subM[1]);
  const depM = raw.match(/Deposit\s+due(?:\s*\(50%\))?:\s*(\$?[0-9.,]+)/i);
  if (depM) deposit = parseMoneyValue(depM[1]);

  if (!Number.isFinite(subtotal) || subtotal <= 0) {
    const items = parseSheetLineItems(raw);
    const sum = items.reduce(
      (s, it) => s + (it.amountCents != null ? it.amountCents : 0),
      0,
    );
    if (sum > 0) subtotal = sum / 100;
  }
  if (
    (!Number.isFinite(deposit) || deposit <= 0) &&
    Number.isFinite(subtotal) &&
    subtotal > 0
  ) {
    deposit = Math.round(subtotal * 50) / 100;
  }
  return { subtotal, deposit };
}

/** Up to 3 photos × 10MB raw + multipart overhead */
const MAX_UPLOAD_BODY_BYTES = 40 * 1024 * 1024;

function readBody(req, maxBytes = MAX_UPLOAD_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(
          new Error(
            `Request too large (max ${Math.round(maxBytes / (1024 * 1024))}MB). Use fewer or smaller photos.`,
          ),
        );
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isDrivePhotoLink(url) {
  return (
    typeof url === "string" &&
    (url.startsWith("https://drive.google.com/") || url.startsWith("http://drive.google.com/"))
  );
}

async function parseCartSubmitRequest(req) {
  const ct = req.headers["content-type"] || "";

  if (ct.includes("multipart/form-data")) {
    const raw = await readBody(req);
    const { fields, files } = parseMultipart(raw, ct);
    const body = JSON.parse(fields.payload || "{}");
    const photoFiles = [];

    for (const f of files) {
      if (photoFiles.length >= (google.MAX_SHEET_PHOTOS || 3)) break;
      if (!f.data?.length) continue;

      if (f.data.length > google.MAX_PHOTO_BYTES) {
        const mb = (f.data.length / (1024 * 1024)).toFixed(1);
        throw new Error(
          `Photo "${f.filename || "image"}" is ${mb}MB. Maximum size is 10MB per photo.`,
        );
      }

      const mime = f.mimeType?.startsWith("image/") ? f.mimeType : "image/jpeg";
      photoFiles.push({
        buf: f.data,
        mime,
        ext: google.mimeToExt(mime, f.filename),
        filename: f.filename,
        index: photoFiles.length,
      });
    }

    return { body, photoFiles };
  }

  const body = JSON.parse((await readBody(req)).toString() || "{}");
  return { body, photoFiles: [] };
}

function json(res, code, data, headers = {}) {
  const body = JSON.stringify(data);
  const cors = activeApiRequest ? corsHeaders(activeApiRequest) : {};
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    ...cors,
    ...headers,
  });
  res.end(body);
}

function text(res, code, msg) {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(msg);
}

function safePath(urlPath) {
  const file = path.normalize(path.join(ROOT, urlPath.replace(/^\//, "")));
  if (!file.startsWith(ROOT)) return null;
  return file;
}

function sendFile(res, filePath) {
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    text(res, 404, "Not found");
    return;
  }
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
  if (ext === ".html") {
    headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
  }
  // Service worker + manifest must revalidate so PWA updates install cleanly
  const base = path.basename(filePath);
  if (base === "sw.js" || base === "manifest.json" || ext === ".webmanifest") {
    headers["Cache-Control"] = "no-cache, must-revalidate";
    headers["Service-Worker-Allowed"] = "/";
  }
  res.writeHead(200, headers);
  res.end(buf);
}

function saveImages(orderId, images) {
  const out = [];
  if (!Array.isArray(images)) return out;
  const dir = path.join(UPLOADS, orderId);
  fs.mkdirSync(dir, { recursive: true });
  images.slice(0, 6).forEach((img, i) => {
    const m = String(img?.data || "").match(/^data:image\/(\w+);base64,(.+)$/);
    if (!m) return;
    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    const name = `photo-${i + 1}.${ext}`;
    fs.writeFileSync(path.join(dir, name), Buffer.from(m[2], "base64"));
    out.push(`/uploads/${orderId}/${name}`);
  });
  return out;
}

/** Public shop URL for Stripe success/cancel (never the Render API host). */
function shopPublicUrl(req, fallbackBaseUrl) {
  const candidates = [
    process.env.PUBLIC_SHOP_URL,
    process.env.SHOP_URL,
    process.env.APP_URL,
  ];
  for (const raw of candidates) {
    const u = String(raw || "")
      .trim()
      .replace(/\/$/, "");
    // Skip API hosts — customers must return to the static shop after Checkout
    if (u && !/onrender\.com/i.test(u) && !/localhost|127\.0\.0\.1/i.test(u)) {
      return u;
    }
    if (u && /localhost|127\.0\.0\.1/i.test(u)) return u;
  }

  const origin = (req && req.headers && req.headers.origin) || "";
  if (origin && LIVE_ORIGINS.has(origin)) return origin.replace(/\/$/, "");

  const base = String(fallbackBaseUrl || "").replace(/\/$/, "");
  if (base && /localhost|127\.0\.0\.1/i.test(base)) return base;

  return "https://sweettoothcravings.shop";
}

/** live | test | none — production deposit invoices require live only. */
function stripeKeyMode() {
  const key = String(CONFIG.stripeKey || "").trim();
  if (key.startsWith("sk_live_")) return "live";
  if (key.startsWith("sk_test_")) return "test";
  return "none";
}

function stripeConfigured() {
  return stripeKeyMode() !== "none";
}

/** Production: only sk_live_ creates real invoices (rejects test keys). */
function stripeLiveConfigured() {
  return stripeKeyMode() === "live";
}

function stripeGet(path) {
  return new Promise((resolve, reject) => {
    if (!stripeConfigured()) {
      reject(new Error("STRIPE_SECRET_KEY not set"));
      return;
    }
    const req = https.request(
      {
        hostname: "api.stripe.com",
        path: path.startsWith("/v1/") ? path : `/v1/${path.replace(/^\//, "")}`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${CONFIG.stripeKey.trim()}`,
        },
      },
      (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => {
          try {
            const j = JSON.parse(d);
            if (j.error) reject(new Error(j.error.message));
            else resolve(j);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Confirm the secret key belongs to Sweet Tooth account acct_1TcrMNHTYIZb4z2l.
 * Result is cached for a few minutes.
 */
async function getStripeAccountStatus() {
  if (!stripeConfigured()) {
    return {
      configured: false,
      expectedAccountId: CONFIG.stripeAccountId,
      ok: false,
      error: "STRIPE_SECRET_KEY not set on the API (Render)",
    };
  }
  const now = Date.now();
  if (stripeAccountCache && now - stripeAccountCache.at < 5 * 60 * 1000) {
    return stripeAccountCache.status;
  }
  try {
    const acct = await stripeGet("/v1/account");
    const id = String(acct.id || "");
    const accountMatch = id === CONFIG.stripeAccountId;
    // Stripe mode is determined by the secret key prefix (sk_live_ vs sk_test_).
    const mode = stripeKeyMode();
    const livemode = mode === "live";
    let error = null;
    if (!accountMatch) {
      error = `Stripe key is for ${id || "unknown"}, expected ${CONFIG.stripeAccountId}`;
    } else if (mode === "test") {
      error =
        "STRIPE_SECRET_KEY is a test key (sk_test_). Replace it with the live secret key (sk_live_…) for account acct_1TcrMNHTYIZb4z2l so deposit invoices charge real cards.";
    } else if (mode !== "live") {
      error =
        "STRIPE_SECRET_KEY must be a live secret key (sk_live_…) for Sweet Tooth account acct_1TcrMNHTYIZb4z2l";
    }
    // ok only when account matches AND we are in full live mode
    const ok = accountMatch && livemode;
    const status = {
      configured: true,
      ok,
      accountId: id,
      expectedAccountId: CONFIG.stripeAccountId,
      chargesEnabled: !!acct.charges_enabled,
      payoutsEnabled: !!acct.payouts_enabled,
      businessName:
        (acct.business_profile && acct.business_profile.name) ||
        acct.settings?.dashboard?.display_name ||
        null,
      livemode,
      keyMode: mode,
      error,
    };
    stripeAccountCache = { at: now, status };
    return status;
  } catch (e) {
    const status = {
      configured: true,
      ok: false,
      expectedAccountId: CONFIG.stripeAccountId,
      livemode: stripeLiveConfigured(),
      keyMode: stripeKeyMode(),
      error: e.message || String(e),
    };
    stripeAccountCache = { at: now, status };
    return status;
  }
}

/** POST application/x-www-form-urlencoded to Stripe API. */
function stripeForm(path, fields) {
  return new Promise((resolve, reject) => {
    if (!stripeConfigured()) {
      reject(
        new Error(
          "Add STRIPE_SECRET_KEY for Sweet Tooth Stripe account acct_1TcrMNHTYIZb4z2l on Render",
        ),
      );
      return;
    }
    const body = new URLSearchParams(fields).toString();
    const req = https.request(
      {
        hostname: "api.stripe.com",
        path: path.startsWith("/v1/") ? path : `/v1/${path.replace(/^\//, "")}`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${CONFIG.stripeKey.trim()}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => {
          try {
            const j = JSON.parse(d);
            if (j.error) reject(new Error(j.error.message || JSON.stringify(j.error)));
            else resolve(j);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Find an existing Stripe Customer by email, or create one.
 * Always uses the live secret key (sk_live_) configured on Render.
 */
async function stripeFindOrCreateCustomer({ email, name, orderId }) {
  const normalized = String(email || "")
    .trim()
    .replace(/^mailto:/i, "")
    .split(/[?,\s;]/)[0]
    .trim();
  if (!normalized.includes("@")) throw new Error("Customer email required");

  try {
    const listed = await stripeGet(
      `/v1/customers?email=${encodeURIComponent(normalized)}&limit=5`,
    );
    const match = (listed.data || []).find(
      (c) =>
        String(c.email || "")
          .trim()
          .toLowerCase() === normalized.toLowerCase() && !c.deleted,
    );
    if (match) {
      // Keep metadata fresh when we have order context
      if (orderId || name) {
        try {
          const fields = {};
          if (orderId) fields["metadata[orderId]"] = orderId;
          if (name) fields.name = name;
          fields["metadata[invoiceTo]"] = normalized;
          return await stripeForm(`/v1/customers/${match.id}`, fields);
        } catch {
          return match;
        }
      }
      return match;
    }
  } catch (e) {
    console.warn("[stripe] customer search failed, creating new:", e.message);
  }

  return stripeForm("/v1/customers", {
    email: normalized,
    ...(name ? { name } : {}),
    "metadata[orderId]": orderId || "",
    "metadata[source]": "sweet_tooth_order_log",
    "metadata[invoiceTo]": normalized,
    "metadata[sheetRowEmail]": normalized,
  });
}

/**
 * Create + email a Stripe Invoice for the 50% deposit (Stripe emails the customer).
 * Line items show full order breakdown (size/flavor/qty/price); total charged = deposit.
 * Returns { url, invoiceId, customerId, emailed: true, emailedTo }.
 */
async function stripeSendDepositInvoice(opts) {
  const amountCents = Math.round(Number(opts.amountCents) || 0);
  if (amountCents < 50) throw new Error("Stripe amount must be at least $0.50");
  // Exact recipient — never bakery / account defaults
  const email = String(opts.customerEmail || "")
    .trim()
    .replace(/^mailto:/i, "")
    .split(/[?,\s;]/)[0]
    .trim();
  if (!email.includes("@")) throw new Error("Customer email required");
  if (isBakeryInboxEmail(email)) {
    throw new Error(
      "Invoice recipient cannot be the bakery inbox. Use the customer Email on that sheet row.",
    );
  }
  if (!stripeLiveConfigured()) {
    throw new Error(
      "Stripe is not in live mode. Set STRIPE_SECRET_KEY to sk_live_… on Render.",
    );
  }
  const orderId = opts.orderId || "";
  const name = String(opts.customerName || "").trim();
  const description = String(opts.description || "50% order deposit").slice(0, 500);
  const orderDetails = String(opts.orderDetails || opts.lineItemsText || "").trim();
  const subtotalCents = Math.round(
    Number(opts.subtotalCents) || amountCents * 2,
  );
  const parsedItems = Array.isArray(opts.lineItems) ? opts.lineItems : [];

  // Find or create Stripe Customer with this exact email (invoice goes only here)
  const customer = await stripeFindOrCreateCustomer({
    email,
    name,
    orderId,
  });
  if (
    String(customer.email || "")
      .trim()
      .toLowerCase() !== email.toLowerCase()
  ) {
    throw new Error(
      `Stripe customer email mismatch (got ${customer.email}, expected ${email})`,
    );
  }

  // Create draft invoice first, then attach lines explicitly (Stripe no longer
  // auto-includes pending invoice items unless pending_invoice_items_behavior=include).
  // Note: Stripe Invoice create rejects "memo" on some API versions — use footer + description.
  const footerBits = [
    `Billed only to: ${email}`,
    orderDetails ? orderDetails.replace(/\s+/g, " ").slice(0, 320) : null,
    opts.footer ? String(opts.footer) : null,
  ]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 500);
  const invoiceFields = {
    customer: customer.id,
    collection_method: "send_invoice",
    days_until_due: "7",
    auto_advance: "false",
    pending_invoice_items_behavior: "exclude",
    "metadata[orderId]": orderId,
    "metadata[paymentType]": "sheet_deposit_invoice",
    "metadata[stripeAccountId]": CONFIG.stripeAccountId,
    "metadata[customerEmail]": email,
    "metadata[sheetRowEmail]": email,
    "metadata[depositCents]": String(amountCents),
    "metadata[subtotalCents]": String(subtotalCents),
    description: description.slice(0, 500),
    ...(footerBits ? { footer: footerBits } : {}),
  };
  // Custom fields visible on hosted invoice (max 4)
  let cf = 0;
  if (orderId) {
    invoiceFields[`custom_fields[${cf}][name]`] = "Order";
    invoiceFields[`custom_fields[${cf}][value]`] = String(orderId).slice(0, 30);
    cf += 1;
  }
  if (opts.eventDate) {
    invoiceFields[`custom_fields[${cf}][name]`] = "Event / needed-by";
    invoiceFields[`custom_fields[${cf}][value]`] = String(opts.eventDate).slice(0, 30);
    cf += 1;
  }
  invoiceFields[`custom_fields[${cf}][name]`] = "Invoice to";
  invoiceFields[`custom_fields[${cf}][value]`] = email.slice(0, 30);
  cf += 1;
  if (name) {
    invoiceFields[`custom_fields[${cf}][name]`] = "Customer";
    invoiceFields[`custom_fields[${cf}][value]`] = name.slice(0, 30);
  }

  const invoice = await stripeForm("/v1/invoices", invoiceFields);

  // Prefer priced cart lines so the hosted invoice shows full breakdown.
  // Each line shows full item price in the description; amounts are 50% share
  // so the invoice total equals the deposit (no $0 / auto-paid invoices).
  const priced = parsedItems.filter(
    (it) => it && it.amountCents != null && it.amountCents > 0 && it.description,
  );
  let lineItemCount = 0;

  if (priced.length > 0) {
    const fullSum = priced.reduce((s, it) => s + it.amountCents, 0);
    let allocated = 0;
    for (let i = 0; i < priced.length; i++) {
      const it = priced[i];
      const isLast = i === priced.length - 1;
      // Proportional 50% deposit share of this line
      let share = isLast
        ? amountCents - allocated
        : Math.round((it.amountCents / fullSum) * amountCents);
      if (share < 1 && amountCents - allocated >= 1) share = 1;
      if (share < 1) continue;
      allocated += share;
      const fullDollars = (it.amountCents / 100).toFixed(2);
      const desc = `${it.description} · 50% deposit share (full line $${fullDollars})`.slice(
        0,
        500,
      );
      await stripeForm("/v1/invoiceitems", {
        customer: customer.id,
        invoice: invoice.id,
        currency: "usd",
        amount: String(share),
        description: desc,
        "metadata[orderId]": orderId,
        "metadata[kind]": "order_line_deposit",
        "metadata[fullLineCents]": String(it.amountCents),
      });
      lineItemCount += 1;
    }
    // If rounding left a gap, top up on a small adjustment line
    if (allocated < amountCents) {
      await stripeForm("/v1/invoiceitems", {
        customer: customer.id,
        invoice: invoice.id,
        currency: "usd",
        amount: String(amountCents - allocated),
        description: "Deposit rounding adjustment",
        "metadata[orderId]": orderId,
        "metadata[kind]": "deposit_round",
      });
      lineItemCount += 1;
    }
  } else {
    // No parseable prices — single deposit line with free-text breakdown
    const detail = String(opts.lineItemsText || orderDetails || description || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400);
    const productName = (
      detail
        ? `50% deposit — ${detail}`
        : "Sweet Tooth Cravings — 50% deposit"
    ).slice(0, 500);
    await stripeForm("/v1/invoiceitems", {
      customer: customer.id,
      invoice: invoice.id,
      currency: "usd",
      amount: String(amountCents),
      description: productName,
      "metadata[orderId]": orderId,
      "metadata[kind]": "deposit",
    });
    lineItemCount = 1;
  }

  if (amountCents < 50) {
    throw new Error("Deposit amount resolved to less than $0.50");
  }

  const finalized = await stripeForm(`/v1/invoices/${invoice.id}/finalize`, {
    auto_advance: "true",
  });

  const total =
    finalized.amount_due != null
      ? Number(finalized.amount_due)
      : amountCents;
  if (!Number.isFinite(total) || total < 50) {
    throw new Error(
      `Stripe invoice total is $${((total || 0) / 100).toFixed(2)} — expected deposit $${(amountCents / 100).toFixed(2)}. Check Estimated Subtotal / Deposit Due on the row.`,
    );
  }

  // Stripe emails the hosted invoice to customer.email on this Customer object
  const sent = await stripeForm(`/v1/invoices/${finalized.id}/send`, {});

  const url =
    sent.hosted_invoice_url ||
    finalized.hosted_invoice_url ||
    sent.invoice_pdf ||
    finalized.invoice_pdf ||
    "";

  return {
    url,
    invoiceId: sent.id || finalized.id,
    customerId: customer.id,
    emailed: true,
    emailedTo: email,
    amountDueCents: total,
    method: "stripe_invoice_email",
    status: sent.status || finalized.status,
    lineItemCount: lineItemCount || 1,
  };
}

/**
 * Create a Stripe Checkout Session on the Sweet Tooth account.
 * @param {object} opts
 */
async function stripeCheckout(opts) {
  const amountCents = Math.round(Number(opts.amountCents) || 0);
  if (amountCents < 50) {
    throw new Error("Stripe amount must be at least $0.50");
  }

  const shopUrl = String(opts.shopUrl || "https://sweettoothcravings.shop").replace(
    /\/$/,
    "",
  );
  const productName =
    opts.productName || "Sweet Tooth Cravings — order payment";
  const description = (opts.description || "Order payment").slice(0, 500);
  const orderId = opts.orderId || "";
  const email = (opts.customerEmail || "").trim();

  const fields = {
    mode: "payment",
    success_url: `${shopUrl}/?payment=success&order=${encodeURIComponent(orderId)}`,
    cancel_url: `${shopUrl}/?payment=cancelled&order=${encodeURIComponent(orderId)}`,
    "metadata[orderId]": orderId,
    "metadata[paymentType]": opts.paymentType || "payment",
    "metadata[stripeAccountId]": CONFIG.stripeAccountId,
    "metadata[source]": "sweet_tooth_order_log",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(amountCents),
    "line_items[0][price_data][product_data][name]": productName.slice(0, 120),
    "line_items[0][price_data][product_data][description]": description,
    "payment_intent_data[description]": `${productName} · order ${orderId}`.slice(0, 1000),
    "payment_intent_data[metadata][orderId]": orderId,
    "payment_intent_data[metadata][stripeAccountId]": CONFIG.stripeAccountId,
  };
  if (email) fields.customer_email = email;
  if (opts.depositCents != null) {
    fields["metadata[depositCents]"] = String(opts.depositCents);
  }
  if (opts.estimatedSubtotalCents != null) {
    fields["metadata[estimatedSubtotalCents]"] = String(opts.estimatedSubtotalCents);
  }

  return stripeForm("/v1/checkout/sessions", fields);
}

/**
 * 50% deposit Checkout — used only AFTER bakery review
 * (Sheet "Send Deposit Invoice" / admin payment-link).
 * Form cart-submit does NOT call this (no auto Stripe redirect on submit).
 */
async function createDepositCheckout({
  orderId,
  customerEmail,
  customerName,
  subtotalDollars,
  lineSummary,
  shopUrl,
  orderType,
}) {
  if (!stripeConfigured()) {
    return { ok: false, skipped: true, reason: "stripe_not_configured" };
  }
  const subtotal = Number(subtotalDollars) || 0;
  if (subtotal <= 0) {
    return { ok: false, skipped: true, reason: "no_subtotal" };
  }
  const depositDollars = Math.round(subtotal * 50) / 100; // half, 2 decimals
  const depositCents = Math.round(depositDollars * 100);
  if (depositCents < 50) {
    return { ok: false, skipped: true, reason: "deposit_below_minimum" };
  }

  const subtotalCents = Math.round(subtotal * 100);
  const summary = String(lineSummary || "Order request")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  const who = (customerName || "").trim();

  try {
    const session = await stripeCheckout({
      orderId,
      customerEmail,
      amountCents: depositCents,
      shopUrl,
      paymentType: "deposit_50",
      depositCents,
      estimatedSubtotalCents: subtotalCents,
      productName: "Sweet Tooth Cravings — 50% deposit",
      description: [
        who ? `For ${who}` : null,
        `Est. total $${subtotal.toFixed(2)}`,
        `Deposit $${depositDollars.toFixed(2)} (50%)`,
        summary,
        orderType ? `(${orderType})` : null,
      ]
        .filter(Boolean)
        .join(" · ")
        .slice(0, 500),
    });
    return {
      ok: true,
      checkoutUrl: session.url,
      sessionId: session.id,
      depositCents,
      depositDollars,
      estimatedSubtotalCents: subtotalCents,
    };
  } catch (e) {
    console.error("[stripe] deposit checkout failed:", e.message);
    return { ok: false, error: e.message };
  }
}

// ─── CORS (live shop on GitHub Pages → API on another host) ───────────────

const LIVE_ORIGINS = new Set([
  "https://sweettoothcravings.shop",
  "https://www.sweettoothcravings.shop",
]);

function corsHeaders(req) {
  const origin = req.headers.origin || "";
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  const allow =
    LIVE_ORIGINS.has(origin) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ||
    /\.github\.io$/i.test(origin.replace(/^https?:\/\//, "").split("/")[0] || "");
  if (origin && allow) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  } else if (!origin) {
    // Non-browser clients (curl, Apps Script sometimes) — allow simple responses
    headers["Access-Control-Allow-Origin"] = "*";
  }
  return headers;
}

let activeApiRequest = null;

// ─── API routes ────────────────────────────────────────────────────────────

async function api(req, res, pathname, baseUrl) {
  activeApiRequest = req;
  const method = req.method;

  if (method === "OPTIONS") {
    res.writeHead(204, { ...corsHeaders(req), "Content-Length": "0" });
    res.end();
    return;
  }

  if (method === "GET" && pathname === "/api/health") {
    const orderEmail = await notify.checkEmailReady();
    const setup = google.sheetsSetupStatus();
    const stripeStatus = await getStripeAccountStatus();
    // Production: stripe + sheetDepositInvoice require full live mode (sk_live_)
    const stripeOk = stripeLiveConfigured() && stripeStatus.ok;
    google.forceProductionTargets();
    return json(res, 200, {
      ok: true,
      time: new Date().toISOString(),
      deployBuild: DEPLOY_BUILD,
      googleSheets: google.isConfigured(),
      googleSheetsSetup: setup,
      googleSheetId: google.getSheetId(),
      googleDriveFolderId: google.getDriveFolderId(),
      expectedSheetId: EXPECTED_SHEET_ID,
      expectedDriveFolderId: EXPECTED_DRIVE_ID,
      targetsMatch:
        google.getSheetId() === EXPECTED_SHEET_ID &&
        google.getDriveFolderId() === EXPECTED_DRIVE_ID,
      googleDriveOAuth: google.isDriveOAuthReady(),
      stripe: stripeOk,
      stripeLive: stripeOk,
      stripeAccount: stripeStatus,
      expectedStripeAccountId: CONFIG.stripeAccountId,
      // Auto Checkout on form submit is OFF — deposit only after sheet review
      depositCheckoutOnSubmit: false,
      depositCheckout: false,
      sheetDepositInvoice: stripeOk && !!sheetActionsSecret(),
      orderEmail,
      photoStorage: "google_drive",
      uploadMode: "multipart",
      maxPhotoMb: Math.round(google.MAX_PHOTO_BYTES / (1024 * 1024)),
      cartSubmitIdempotency: true,
      noAutoRetry: true,
      sheetWriteOnEverySubmit: true,
    });
  }

  if (method === "POST" && pathname === "/api/admin/login") {
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    if (!passwordMatchesAdmin(body.password)) {
      return json(res, 401, { error: "Wrong password" });
    }
    return json(
      res,
      200,
      {
        success: true,
        // Client (static GH Pages) stores this as Bearer for subsequent API calls
        token: String(body.password),
      },
      {
        "Set-Cookie": `stc_admin=${adminToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
      },
    );
  }

  if (method === "POST" && pathname === "/api/admin/logout") {
    return json(res, 200, { success: true }, { "Set-Cookie": "stc_admin=; Max-Age=0; Path=/" });
  }

  if (method === "GET" && pathname === "/api/admin/session") {
    return json(res, 200, { authenticated: isAdmin(req) });
  }

  /**
   * Mobile admin: recent Pending Review orders (Google Sheet + local fallback).
   * GET /api/admin/pending-orders
   * Auth: Bearer <password> or admin cookie
   */
  if (method === "GET" && pathname === "/api/admin/pending-orders") {
    if (!isAdmin(req) && !isSheetActionAuthorized(req)) {
      return json(res, 401, { error: "Unauthorized" });
    }
    try {
      google.forceProductionTargets();
      let sheetOrders = [];
      let sheetError = null;
      try {
        if (typeof google.listRecentOrdersFromSheet === "function") {
          const listed = await google.listRecentOrdersFromSheet({ limit: 80 });
          if (listed.ok) sheetOrders = listed.orders || [];
          else sheetError = listed.error || null;
        }
      } catch (e) {
        sheetError = e.message || String(e);
        console.warn("[admin/pending-orders] sheet read failed:", sheetError);
      }

      const local = loadOrders().map((o) => {
        const sub =
          o.estimatedSubtotal != null
            ? Number(o.estimatedSubtotal)
            : o.finalPriceCents != null
              ? o.finalPriceCents / 100
              : null;
        const deposit =
          o.depositCents != null
            ? o.depositCents / 100
            : sub != null && sub > 0
              ? Math.round(sub * 50) / 100
              : null;
        return {
          id: o.id,
          orderNumber: o.id,
          sheetRow: null,
          status: o.status || "pending_review",
          customerName: o.customerName || "",
          customerEmail: o.customerEmail || "",
          customerPhone: o.customerPhone || "",
          eventDate: o.eventDate || "",
          lineItemsDetail: o.lineItemsDetail || "",
          estimatedSubtotal: sub,
          depositAmount: deposit,
          depositDue: deposit,
          orderType: o.orderType || "",
          createdAt: o.createdAt || null,
          source: "local",
        };
      });

      // Prefer sheet rows; merge local-only orders not already in sheet
      const byId = new Map();
      for (const o of sheetOrders) {
        byId.set(String(o.orderNumber || o.id), o);
      }
      for (const o of local) {
        const key = String(o.orderNumber || o.id);
        if (!byId.has(key)) byId.set(key, o);
      }

      const all = [...byId.values()];
      const pending = all
        .filter((o) => isPendingReviewStatus(o.status))
        .filter((o) => o.customerEmail && String(o.customerEmail).includes("@"))
        .sort((a, b) => {
          const ta = new Date(a.createdAt || 0).getTime() || 0;
          const tb = new Date(b.createdAt || 0).getTime() || 0;
          if (tb !== ta) return tb - ta;
          return (b.sheetRow || 0) - (a.sheetRow || 0);
        });

      return json(res, 200, {
        success: true,
        orders: pending,
        count: pending.length,
        sheetError,
      });
    } catch (e) {
      console.error("[admin/pending-orders]", e);
      return json(res, 500, { error: e.message || String(e) });
    }
  }

  if (method === "GET" && pathname === "/api/orders") {
    if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
    const orders = loadOrders().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return json(res, 200, { orders });
  }

  const one = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (one) {
    const oid = one[1];
    if (method === "GET") {
      if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
      const order = loadOrders().find((o) => o.id === oid);
      return order ? json(res, 200, { order }) : json(res, 404, { error: "Not found" });
    }
    if (method === "PATCH") {
      if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const list = loadOrders();
      const order = list.find((o) => o.id === oid);
      if (!order) return json(res, 404, { error: "Not found" });
      if (body.status) order.status = body.status;
      if (body.finalPriceCents !== undefined) order.finalPriceCents = body.finalPriceCents;
      if (body.adminNotes !== undefined) order.adminNotes = body.adminNotes;
      order.updatedAt = new Date().toISOString();
      saveOrders(list);
      return json(res, 200, { order });
    }
  }

  const pay = pathname.match(/^\/api\/orders\/([^/]+)\/payment-link$/);
  if (method === "POST" && pay) {
    if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    const list = loadOrders();
    const order = list.find((o) => o.id === pay[1]);
    if (!order) return json(res, 404, { error: "Not found" });

    const dollars =
      body.finalPrice != null
        ? Number(body.finalPrice)
        : order.finalPriceCents
          ? order.finalPriceCents / 100
          : NaN;

    if (!dollars || dollars < 0.5) {
      return json(res, 400, { error: "Enter a final price of at least $0.50" });
    }

    try {
      const cents = Math.round(dollars * 100);
      const shopUrl = shopPublicUrl(req, baseUrl);
      const session = await stripeCheckout({
        orderId: order.id,
        customerEmail: order.customerEmail,
        amountCents: cents,
        shopUrl,
        paymentType: "admin_payment",
        productName: "Sweet Tooth Cravings — order payment",
        description: [
          order.cakeName,
          order.sizeLabel,
          order.lineItemsDetail
            ? String(order.lineItemsDetail).replace(/\s+/g, " ").slice(0, 200)
            : null,
        ]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 500) || `Order ${order.id}`,
      });
      order.finalPriceCents = cents;
      order.stripePaymentUrl = session.url;
      order.stripeSessionId = session.id;
      order.status = "payment_sent";
      order.updatedAt = new Date().toISOString();
      saveOrders(list);
      return json(res, 200, { order, paymentUrl: session.url });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  /**
   * Simple deposit invoice API (live Stripe only).
   *
   * POST /api/send-deposit-invoice
   * Headers: Authorization: Bearer <SHEET_ACTIONS_SECRET|ADMIN_PASSWORD>
   * Body: {
   *   orderNumber: string,   // required (order id)
   *   email: string,         // required — customer recipient only
   *   row?: number|string,   // optional sheet row reference
   *   // optional amounts (if omitted, looks up local order or requires estimatedSubtotal):
   *   estimatedSubtotal?, depositAmount?, depositDollars?, lineItemsDetail?, customerName?
   * }
   * Success: { success: true, invoiceUrl: "..." }
   * Failure: { error: "message" }
   */
  if (method === "POST" && pathname === "/api/send-deposit-invoice") {
    if (!isSheetActionAuthorized(req) && !isAdmin(req)) {
      return json(res, 401, {
        error:
          "Unauthorized. Send Authorization: Bearer <ADMIN_PASSWORD or SHEET_ACTIONS_SECRET>.",
      });
    }

    let body = {};
    try {
      body = JSON.parse((await readBody(req)).toString() || "{}");
    } catch {
      return json(res, 400, { error: "Invalid JSON body" });
    }

    const orderNumber = String(
      body.orderNumber || body.orderId || body.order_id || body.order || "",
    ).trim();
    const email = String(body.email || body.customerEmail || body.sheetRowEmail || "")
      .trim()
      .replace(/^mailto:/i, "")
      .split(/[?,\s;]/)[0]
      .trim()
      .toLowerCase();
    const row =
      body.row != null && body.row !== ""
        ? String(body.row).trim()
        : null;

    if (!orderNumber) {
      return json(res, 400, { error: "orderNumber is required" });
    }
    if (!email || !email.includes("@")) {
      return json(res, 400, { error: "email is required" });
    }
    if (isBakeryInboxEmail(email)) {
      return json(res, 400, {
        error:
          "email cannot be the bakery inbox — use the customer address for this order",
      });
    }
    if (!stripeLiveConfigured()) {
      return json(res, 503, {
        error:
          "Stripe is not in live mode. On Render set STRIPE_SECRET_KEY to the live secret key (sk_live_…) for account acct_1TcrMNHTYIZb4z2l.",
        keyMode: stripeKeyMode(),
        livemode: false,
      });
    }

    const stripeStatus = await getStripeAccountStatus();
    if (!stripeStatus.ok || !stripeStatus.livemode) {
      return json(res, 503, {
        error:
          stripeStatus.error ||
          `Stripe must be live mode for account ${CONFIG.stripeAccountId}`,
        keyMode: stripeStatus.keyMode || stripeKeyMode(),
        livemode: !!stripeStatus.livemode,
      });
    }

    // Resolve amounts: body → local order → 50% of subtotal
    const saved = loadOrders().find(
      (o) =>
        String(o.id || "") === orderNumber ||
        String(o.orderId || "") === orderNumber,
    );

    let subtotal = parseMoneyValue(
      body.estimatedSubtotal ??
        body.subtotal ??
        body.finalTotal ??
        body.orderTotal,
    );
    let depositDollars = parseMoneyValue(
      body.depositAmount ?? body.depositDollars ?? body.deposit ?? body.amount,
    );

    if (saved) {
      if ((!Number.isFinite(subtotal) || subtotal <= 0) && saved.estimatedSubtotal != null) {
        subtotal = parseMoneyValue(saved.estimatedSubtotal);
      }
      if (
        (!Number.isFinite(subtotal) || subtotal <= 0) &&
        saved.finalPriceCents != null
      ) {
        subtotal = Number(saved.finalPriceCents) / 100;
      }
      if (
        (!Number.isFinite(depositDollars) || depositDollars <= 0) &&
        saved.depositCents != null
      ) {
        depositDollars = Number(saved.depositCents) / 100;
      }
    }

    const lineSummary = String(
      body.lineItemsDetail ||
        body.lineItems ||
        (saved && saved.lineItemsDetail) ||
        "",
    ).trim();
    const fromLines = extractTotalsFromLineItems(lineSummary);
    if ((!Number.isFinite(subtotal) || subtotal <= 0) && Number.isFinite(fromLines.subtotal)) {
      subtotal = fromLines.subtotal;
    }
    if (
      (!Number.isFinite(depositDollars) || depositDollars <= 0) &&
      Number.isFinite(fromLines.deposit)
    ) {
      depositDollars = fromLines.deposit;
    }
    if (
      (!Number.isFinite(depositDollars) || depositDollars <= 0) &&
      Number.isFinite(subtotal) &&
      subtotal > 0
    ) {
      depositDollars = Math.round(subtotal * 50) / 100;
    }
    if (
      (!Number.isFinite(subtotal) || subtotal <= 0) &&
      Number.isFinite(depositDollars) &&
      depositDollars > 0
    ) {
      subtotal = Math.round(depositDollars * 2 * 100) / 100;
    }

    if (!Number.isFinite(depositDollars) || depositDollars < 0.5) {
      return json(res, 400, {
        error:
          "Need a deposit of at least $0.50. Pass estimatedSubtotal (or depositAmount), or ensure the order has a price.",
      });
    }

    const depositCents = Math.round(depositDollars * 100);
    const customerName = String(
      body.customerName || body.name || (saved && saved.customerName) || "",
    ).trim();
    const eventDate = String(
      body.eventDate || (saved && saved.eventDate) || "",
    ).trim();
    const parsedLineItems = parseSheetLineItems(lineSummary);
    const desc = [
      customerName ? `For ${customerName}` : null,
      Number.isFinite(subtotal) ? `Est. total $${subtotal.toFixed(2)}` : null,
      `Deposit due now $${depositDollars.toFixed(2)} (50%)`,
      `Order ${orderNumber}`,
      row ? `Sheet row ${row}` : null,
    ]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 500);

    try {
      const inv = await stripeSendDepositInvoice({
        orderId: orderNumber,
        customerEmail: email,
        customerName,
        eventDate,
        amountCents: depositCents,
        subtotalCents: Number.isFinite(subtotal)
          ? Math.round(subtotal * 100)
          : depositCents * 2,
        lineItems: parsedLineItems,
        lineItemsText: lineSummary,
        orderDetails: [
          `Order: ${orderNumber}`,
          customerName ? `Customer: ${customerName}` : null,
          `Email: ${email}`,
          row ? `Sheet row: ${row}` : null,
          eventDate ? `Event: ${eventDate}` : null,
          lineSummary || null,
          Number.isFinite(subtotal) ? `Est. total: $${subtotal.toFixed(2)}` : null,
          `Deposit (50%): $${depositDollars.toFixed(2)}`,
        ]
          .filter(Boolean)
          .join(" · "),
        description: desc,
        footer: [
          `Billed only to: ${email}`,
          `Order ${orderNumber}`,
          row ? `Row ${row}` : null,
          "Remaining 50% due before pickup/delivery.",
        ]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 500),
      });

      const invoiceUrl = inv.url || "";
      if (!invoiceUrl) {
        return json(res, 500, { error: "Stripe did not return an invoice URL" });
      }
      if (
        String(inv.emailedTo || "")
          .trim()
          .toLowerCase() !== email
      ) {
        return json(res, 500, {
          error: `Invoice recipient mismatch (got ${inv.emailedTo}, expected ${email})`,
        });
      }

      // Persist on local order if present
      if (saved) {
        const list = loadOrders();
        const order = list.find((o) => o.id === saved.id);
        if (order) {
          order.stripePaymentUrl = invoiceUrl;
          order.stripeSessionId = inv.invoiceId;
          order.depositCents = inv.amountDueCents || depositCents;
          order.status = "deposit_invoice_sent";
          order.updatedAt = new Date().toISOString();
          saveOrders(list);
        }
      }

      console.log(
        `[send-deposit-invoice] LIVE ${inv.invoiceId} $${((inv.amountDueCents || depositCents) / 100).toFixed(2)} → ${email} order=${orderNumber}`,
      );

      return json(res, 200, {
        success: true,
        invoiceUrl,
        // Extra fields (non-breaking) for clients that want them
        orderNumber,
        email,
        row,
        invoiceId: inv.invoiceId,
        depositDollars: (inv.amountDueCents || depositCents) / 100,
        livemode: true,
        keyMode: "live",
      });
    } catch (e) {
      console.error("[send-deposit-invoice]", e);
      return json(res, 500, { error: e.message || String(e) });
    }
  }

  /**
   * Google Sheet one-click: create 50% deposit Checkout + email customer.
   * Does not change cart-submit / Sheets append / Drive upload.
   *
   * POST /api/sheet/send-deposit-invoice
   * Headers: Authorization: Bearer <SHEET_ACTIONS_SECRET|ADMIN_PASSWORD>
   * Body: row fields from the Order Log (orderId, email, estimatedSubtotal, …)
   */
  if (method === "POST" && pathname === "/api/sheet/send-deposit-invoice") {
    if (!isSheetActionAuthorized(req) && !isAdmin(req)) {
      return json(res, 401, {
        error:
          "Unauthorized. Set SHEET_ACTIONS_SECRET (or ADMIN_PASSWORD) on the API and in Apps Script.",
      });
    }

    let body = {};
    try {
      body = JSON.parse((await readBody(req)).toString() || "{}");
    } catch {
      return json(res, 400, { error: "Invalid JSON body" });
    }

    const orderId = String(body.orderId || body.order_id || "").trim();
    // ONLY the sheet row Email — ignore bakery, notify, admin, or any other address
    const rawSheetEmail = String(
      body.sheetRowEmail || body.customerEmail || body.email || "",
    ).trim();
    const customerEmail = rawSheetEmail
      .replace(/^mailto:/i, "")
      .split(/[?,\s;]/)[0]
      .trim()
      .toLowerCase();
    const customerName = String(
      body.customerName || body.name || "",
    ).trim();
    const customerPhone = String(body.customerPhone || body.phone || "").trim();
    const eventDate = String(body.eventDate || body.event_date || "").trim();
    const lineSummary = String(
      body.lineItemsDetail ||
        body.lineItems ||
        body.product ||
        body.lineSummary ||
        "",
    ).trim();
    const orderDetails = String(
      body.orderDetails || body.fullOrderDetails || lineSummary || "",
    ).trim();
    const orderType = String(body.orderType || body.order_type || "Order").trim();
    const allergies = String(body.allergies || "").trim();
    const notes = String(
      body.notes || body.decorationNotes || body.additionalNotes || "",
    ).trim();

    if (!customerEmail || !customerEmail.includes("@")) {
      return json(res, 400, {
        error:
          "Customer email is required on this row’s Email column. The invoice is only sent to that address.",
      });
    }
    if (isBakeryInboxEmail(customerEmail)) {
      return json(res, 400, {
        error:
          "The Email column is set to the bakery inbox. Put the customer’s email in the Email column for that row, then try again.",
      });
    }
    // Refuse any alternate recipient fields if they disagree with the row Email
    const altTo = String(body.to || body.recipient || body.sendTo || "")
      .trim()
      .toLowerCase();
    if (altTo && altTo.includes("@") && altTo !== customerEmail) {
      return json(res, 400, {
        error: `Invoice recipient must be the row Email (${customerEmail}), not ${altTo}.`,
      });
    }
    if (!stripeLiveConfigured()) {
      const mode = stripeKeyMode();
      return json(res, 503, {
        error:
          mode === "test"
            ? "Stripe is in TEST mode (sk_test_ key). On Render set STRIPE_SECRET_KEY to the LIVE secret key (sk_live_…) for account acct_1TcrMNHTYIZb4z2l, then redeploy."
            : "Stripe is not configured for live mode. On Render set STRIPE_SECRET_KEY to the live Secret key (sk_live_…) for Sweet Tooth account acct_1TcrMNHTYIZb4z2l (Stripe Dashboard → Developers → API keys → Secret key).",
        keyMode: mode,
        livemode: false,
      });
    }

    const stripeStatus = await getStripeAccountStatus();
    if (!stripeStatus.ok || !stripeStatus.livemode) {
      return json(res, 503, {
        error:
          stripeStatus.error ||
          `Stripe must be live mode for account ${CONFIG.stripeAccountId}`,
        keyMode: stripeStatus.keyMode || stripeKeyMode(),
        livemode: !!stripeStatus.livemode,
      });
    }

    // Amounts: Estimated Subtotal / Deposit Due columns, then Line Items totals, then 50%
    let subtotal = parseMoneyValue(
      body.finalTotal != null && body.finalTotal !== ""
        ? body.finalTotal
        : body.estimatedSubtotal,
    );
    let depositDollars = parseMoneyValue(
      body.depositAmount != null && body.depositAmount !== ""
        ? body.depositAmount
        : body.depositDue,
    );

    const fromLines = extractTotalsFromLineItems(lineSummary);
    if ((!Number.isFinite(subtotal) || subtotal <= 0) && Number.isFinite(fromLines.subtotal)) {
      subtotal = fromLines.subtotal;
    }
    if (
      (!Number.isFinite(depositDollars) || depositDollars <= 0) &&
      Number.isFinite(fromLines.deposit) &&
      fromLines.deposit > 0
    ) {
      depositDollars = fromLines.deposit;
    }

    if ((!Number.isFinite(depositDollars) || depositDollars <= 0) && Number.isFinite(subtotal) && subtotal > 0) {
      depositDollars = Math.round(subtotal * 50) / 100;
    }
    if ((!Number.isFinite(subtotal) || subtotal <= 0) && Number.isFinite(depositDollars) && depositDollars > 0) {
      subtotal = Math.round(depositDollars * 2 * 100) / 100;
    }

    if (!Number.isFinite(depositDollars) || depositDollars < 0.5) {
      return json(res, 400, {
        error:
          "Need a deposit of at least $0.50. Set Estimated Subtotal (or Deposit Due) on the row — values like $0.00 are not charged.",
        parsed: { subtotal, depositDollars, fromLineItems: fromLines },
      });
    }

    const depositCents = Math.round(depositDollars * 100);
    if (depositCents < 50) {
      return json(res, 400, {
        error: `Deposit resolved to $${(depositCents / 100).toFixed(2)} — check Estimated Subtotal / Deposit Due on the row.`,
      });
    }

    const shopUrl = shopPublicUrl(req, baseUrl);
    const oid = orderId || `sheet-${Date.now().toString(36)}`;
    const parsedLineItems = parseSheetLineItems(lineSummary);
    const fullOrderDetails = [
      orderDetails || lineSummary || null,
      customerName ? `Customer: ${customerName}` : null,
      `Email: ${customerEmail}`,
      customerPhone ? `Phone: ${customerPhone}` : null,
      eventDate ? `Event / needed-by: ${eventDate}` : null,
      orderType ? `Order type: ${orderType}` : null,
      allergies ? `Allergies: ${allergies}` : null,
      notes ? `Notes: ${notes}` : null,
      Number.isFinite(subtotal) ? `Est. total: $${subtotal.toFixed(2)}` : null,
      `Deposit due (50%): $${depositDollars.toFixed(2)}`,
    ]
      .filter(Boolean)
      .join("\n");
    const desc = [
      customerName ? `For ${customerName}` : null,
      Number.isFinite(subtotal) ? `Est. total $${subtotal.toFixed(2)}` : null,
      `Deposit due now $${depositDollars.toFixed(2)} (50%)`,
      orderType ? `(${orderType})` : null,
    ]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 500);

    try {
      // Prefer Stripe-native emailed invoice (no Gmail/SMTP required).
      let payUrl = "";
      let sessionId = "";
      let emailResult = { sent: false };
      let paymentMethod = "stripe_invoice_email";
      let lineItemCount = 0;
      let amountDueCents = depositCents;

      try {
        const inv = await stripeSendDepositInvoice({
          orderId: oid,
          customerEmail,
          customerName,
          eventDate,
          amountCents: depositCents,
          subtotalCents: Number.isFinite(subtotal)
            ? Math.round(subtotal * 100)
            : depositCents * 2,
          lineItems: parsedLineItems,
          lineItemsText: lineSummary,
          orderDetails: fullOrderDetails,
          productName: "Sweet Tooth Cravings — 50% deposit",
          description: desc,
          footer: [
            `Emailed only to row Email: ${customerEmail}`,
            eventDate ? `Event: ${eventDate}` : null,
            `Order ${oid}`,
            customerPhone ? `Phone: ${customerPhone}` : null,
            "Remaining 50% due before pickup/delivery.",
          ]
            .filter(Boolean)
            .join(" · ")
            .slice(0, 500),
        });
        if (
          String(inv.emailedTo || "")
            .trim()
            .toLowerCase() !== customerEmail
        ) {
          throw new Error(
            `Invoice sent to wrong address (${inv.emailedTo}); expected row Email ${customerEmail}`,
          );
        }
        payUrl = inv.url;
        sessionId = inv.invoiceId;
        lineItemCount = inv.lineItemCount || parsedLineItems.length || 1;
        amountDueCents = inv.amountDueCents || depositCents;
        emailResult = {
          sent: true,
          ok: true,
          to: customerEmail,
          method: "stripe_invoice_email",
          from: "Stripe",
          sheetRowEmail: customerEmail,
        };
        console.log(
          `[sheet/send-deposit-invoice] LIVE invoice ${inv.invoiceId} $${(amountDueCents / 100).toFixed(2)} → ONLY ${customerEmail} (${lineItemCount} lines)`,
        );
      } catch (invErr) {
        console.warn(
          "[sheet/send-deposit-invoice] Stripe invoice email failed, falling back to Checkout + notify:",
          invErr.message,
        );
        paymentMethod = "checkout_plus_notify";
        const session = await stripeCheckout({
          orderId: oid,
          customerEmail,
          amountCents: depositCents,
          shopUrl,
          paymentType: "sheet_deposit_invoice",
          depositCents,
          estimatedSubtotalCents: Number.isFinite(subtotal)
            ? Math.round(subtotal * 100)
            : depositCents * 2,
          productName: "Sweet Tooth Cravings — 50% deposit",
          description: desc,
        });
        payUrl = session.url;
        sessionId = session.id;

        try {
          const mail = await notify.sendDepositInvoiceToCustomer({
            customerName,
            customerEmail,
            orderId: oid,
            depositDollars,
            estimatedSubtotal: Number.isFinite(subtotal) ? subtotal : null,
            checkoutUrl: session.url,
            lineSummary: fullOrderDetails || lineSummary,
            eventDate,
            bakeryCopy: false,
          });
          const toAddr = String((mail && mail.to) || "")
            .trim()
            .toLowerCase();
          if (toAddr && toAddr !== customerEmail) {
            emailResult = {
              sent: false,
              ok: false,
              error: `Email went to ${toAddr} instead of row Email ${customerEmail}`,
            };
          } else if (isBakeryInboxEmail(toAddr)) {
            emailResult = {
              sent: false,
              ok: false,
              error: "Email was not delivered to the customer address",
            };
          } else {
            emailResult = {
              sent: !!(mail && mail.ok !== false),
              ok: !!(mail && mail.ok !== false),
              to: customerEmail,
              sheetRowEmail: customerEmail,
              method: mail && mail.method,
              from: mail && mail.from,
              error: mail && mail.error ? String(mail.error) : null,
            };
          }
        } catch (e) {
          const msg = (e && e.message) || String(e) || "email_failed";
          console.error("[sheet/send-deposit-invoice] notify email failed:", msg);
          emailResult = { sent: false, ok: false, error: msg };
        }
      }

      if (!payUrl) {
        return json(res, 500, {
          error: "Stripe did not return a payment URL",
        });
      }

      // Persist on local orders.json when we know the order id
      if (orderId) {
        const list = loadOrders();
        let order = list.find((o) => o.id === orderId);
        if (!order) {
          order = {
            id: orderId,
            createdAt: new Date().toISOString(),
            orderType: "sheet",
            customerName,
            customerEmail,
            customerPhone: customerPhone || null,
            eventDate: eventDate || null,
            lineItemsDetail: lineSummary,
            estimatedSubtotal: Number.isFinite(subtotal) ? subtotal : null,
          };
          list.push(order);
        }
        order.stripePaymentUrl = payUrl;
        order.stripeSessionId = sessionId;
        order.depositCents = depositCents;
        order.status = "deposit_invoice_sent";
        order.updatedAt = new Date().toISOString();
        if (Number.isFinite(subtotal)) {
          order.finalPriceCents = Math.round(subtotal * 100);
        }
        saveOrders(list);
      }

      // Final guard: success with email only if recipient is the row Email
      if (
        emailResult.sent &&
        String(emailResult.to || "")
          .trim()
          .toLowerCase() !== customerEmail
      ) {
        emailResult = {
          sent: false,
          ok: false,
          error: `Refusing success: recipient ${emailResult.to} ≠ row Email ${customerEmail}`,
          to: emailResult.to,
        };
      }

      return json(res, 200, {
        success: true,
        orderId: oid,
        checkoutUrl: payUrl,
        paymentUrl: payUrl,
        sessionId,
        paymentMethod,
        livemode: true,
        keyMode: "live",
        depositDollars: amountDueCents / 100,
        depositCents: amountDueCents,
        estimatedSubtotal: Number.isFinite(subtotal) ? subtotal : null,
        lineItems: parsedLineItems.map((it) => ({
          description: it.description,
          amountCents: it.amountCents,
        })),
        lineItemCount,
        emailedTo: emailResult.sent ? customerEmail : null,
        sheetRowEmail: customerEmail,
        email: emailResult,
        sheetStatus: emailResult.sent
          ? "Deposit invoice sent"
          : "Deposit link created (email failed)",
        message: emailResult.sent
          ? `Live $${(amountDueCents / 100).toFixed(2)} deposit invoice emailed only to ${customerEmail}`
          : `Payment link created but email failed: ${emailResult.error || "unknown"}. Share this link manually: ${payUrl}`,
      });
    } catch (e) {
      console.error("[sheet/send-deposit-invoice]", e);
      return json(res, 500, { error: e.message });
    }
  }

  if (method === "POST" && pathname === "/api/cart-submit") {
    // Hard pin targets on every request (no stale process.env from old deploys)
    google.forceProductionTargets();
    if (
      google.getSheetId() !== EXPECTED_SHEET_ID ||
      google.getDriveFolderId() !== EXPECTED_DRIVE_ID
    ) {
      return json(res, 500, {
        error: "Order targets misconfigured",
        expectedSheetId: EXPECTED_SHEET_ID,
        expectedDriveFolderId: EXPECTED_DRIVE_ID,
        gotSheetId: google.getSheetId(),
        gotDriveFolderId: google.getDriveFolderId(),
        deployBuild: DEPLOY_BUILD,
      });
    }

    let body;
    let photoFiles = [];
    try {
      ({ body, photoFiles } = await parseCartSubmitRequest(req));
    } catch (e) {
      return json(res, 400, { error: e.message });
    }

    const name = (body.customerName || "").trim();
    const email = (body.customerEmail || "").trim();
    if (!name || !email) return json(res, 400, { error: "Name and email required" });
    if (!Array.isArray(body.items) || !body.items.length) {
      return json(res, 400, { error: "Cart is empty" });
    }

    const clientRequestId = normalizeClientRequestId(
      body.clientRequestId || body.idempotencyKey || body.requestId,
    );

    // Replay a successful prior submit with the same key (no second sheet row / Drive upload).
    const cached = getCachedCartSubmit(clientRequestId);
    if (cached) {
      return json(res, 200, { ...cached, idempotentReplay: true });
    }

    // Concurrent double-submit with the same key: wait for the first and reuse its result.
    if (clientRequestId && cartSubmitInflight.has(clientRequestId)) {
      try {
        const shared = await cartSubmitInflight.get(clientRequestId);
        return json(res, 200, { ...shared, idempotentReplay: true });
      } catch (e) {
        return json(res, 500, { error: e.message || "Order submit failed" });
      }
    }

    const runCartSubmit = async () => {
      // Disk-level replay if memory cache was lost (e.g. after restart) but order was stored.
      if (clientRequestId) {
        const existing = loadOrders().find((o) => o.clientRequestId === clientRequestId);
        if (existing) {
          const replay = {
            success: true,
            orderId: existing.id,
            savedTo: "google_sheets",
            photoLinks: (() => {
              try {
                return JSON.parse(existing.inspirationImages || "[]");
              } catch {
                return [];
              }
            })(),
            photoErrors: [],
            emailNotification: { sent: false },
            // No Stripe on form submit — deposit only via Sheet "Send Deposit Invoice"
            checkoutUrl: null,
            paymentUrl: null,
            estimatedSubtotal: existing.estimatedSubtotal,
            stripe: { ok: false, skipped: true, reason: "deposit_after_review_only" },
            idempotentReplay: true,
            googleSheetId: google.getSheetId(),
            googleDriveFolderId: google.getDriveFolderId(),
            clientRequestId,
          };
          setCachedCartSubmit(clientRequestId, replay);
          return replay;
        }
      }

      const orderId = await nextOrderId();
      const now = new Date().toISOString();
      let lineDetail = "";
      let subtotal = 0;
      body.items.forEach((item, i) => {
        const qty = Number(item.quantity) || 1;
        const unit = Number(item.price) || 0;
        const line = unit * qty;
        subtotal += line;
        const c = item.customizations || {};
        const bits = [`${i + 1}. ${qty}× ${item.name || "Item"}`];
        if (c.tier) bits.push(`Size/Tier: ${c.tier}`);
        if (c.flavor) bits.push(`Flavor: ${c.flavor}`);
        if (c.fillings?.length) bits.push(`Filling: ${c.fillings.join(", ")}`);
        if (c.notes) bits.push(`Item notes: ${c.notes}`);
        bits.push(`Line total: $${line.toFixed(2)}`);
        lineDetail += `${bits.join(" | ")}\n`;
      });

      const hasCustomCake = body.items.some((item) =>
        /custom cake/i.test(item.name || ""),
      );

      const phone = String(body.customerPhone || body.phone || "").trim();
      const eventDate = String(body.eventDate || body.date || "").trim();
      const allergies = String(body.allergies || "").trim();
      const orderNotes = String(
        body.orderNotes || body.notes || body.decorationNotes || "",
      ).trim();

      // Form submit = Sheets + Drive only (full contact + cart → correct columns).
      // 50% deposit is created later via Sheet "Send Deposit Invoice".
      // Guaranteed sheet write: saveOrder throws if Sheets API fails.
      google.forceProductionTargets();
      const saved = await google.saveOrder({
        orderId,
        submittedAt: now,
        orderType: hasCustomCake ? "Custom Cake Order" : "Menu Order",
        status: "Pending Review",
        customerName: name,
        customerEmail: email,
        customerPhone: phone,
        eventDate,
        product: hasCustomCake ? "Custom cake (see line items)" : "Menu items (see line items)",
        size: "",
        flavor: "",
        filling: "",
        decorationNotes: orderNotes,
        allergies,
        additionalNotes: "",
        lineItemsDetail: lineDetail.trim(),
        estimatedSubtotal: subtotal,
        photoFiles: photoFiles.length ? photoFiles : undefined,
        inspirationImages: photoFiles.length ? undefined : body.inspirationImages,
      });

      if (!saved || !saved.ok || !saved.orderId) {
        throw new Error("Sheet write did not confirm success");
      }
      if (saved.sheetId && saved.sheetId !== EXPECTED_SHEET_ID) {
        throw new Error(`Sheet write used wrong spreadsheet: ${saved.sheetId}`);
      }

      const drivePhotos = (saved.photoLinks || []).filter((p) => isDrivePhotoLink(p));

      const order = {
        id: orderId,
        createdAt: now,
        updatedAt: now,
        status: "pending_review",
        orderType: "menu",
        customerName: name,
        customerEmail: email,
        customerPhone: phone || null,
        eventDate: eventDate || null,
        lineItemsDetail: lineDetail,
        estimatedSubtotal: subtotal,
        inspirationImages: JSON.stringify(drivePhotos),
        clientRequestId: clientRequestId || null,
        stripePaymentUrl: null,
        stripeSessionId: null,
        depositCents: null,
      };
      const list = loadOrders();
      list.push(order);
      saveOrders(list);

      const responseBody = {
        success: true,
        orderId,
        savedTo: "google_sheets",
        sheetWriteConfirmed: true,
        insertedAtRow: saved.insertedAtRow || 2,
        deployBuild: DEPLOY_BUILD,
        photoLinks: drivePhotos,
        photoErrors: saved.photoErrors || [],
        emailNotification: saved.emailNotification || { sent: false },
        checkoutUrl: null,
        paymentUrl: null,
        depositCents: null,
        depositDollars: null,
        estimatedSubtotal: subtotal,
        depositDue: subtotal > 0 ? Math.round(subtotal * 50) / 100 : null,
        stripe: { ok: false, skipped: true, reason: "deposit_after_review_only" },
        googleSheetId: EXPECTED_SHEET_ID,
        googleDriveFolderId: EXPECTED_DRIVE_ID,
        clientRequestId: clientRequestId || null,
        columnsWritten: saved.columns || null,
      };
      setCachedCartSubmit(clientRequestId, responseBody);
      console.log(
        `[cart-submit] ${DEPLOY_BUILD} order=${orderId} sheet=${EXPECTED_SHEET_ID} drive=${EXPECTED_DRIVE_ID} photos=${drivePhotos.length}`,
      );
      return responseBody;
    };

    const work = runCartSubmit();
    if (clientRequestId) cartSubmitInflight.set(clientRequestId, work);

    try {
      const responseBody = await work;
      return json(res, 200, responseBody);
    } catch (e) {
      console.error("[cart-submit]", e);
      return json(res, 500, { error: e.message });
    } finally {
      if (clientRequestId) cartSubmitInflight.delete(clientRequestId);
    }
  }

  if (method === "POST" && pathname === "/api/orders") {
    const ct = req.headers["content-type"] || "";
    if (!ct.includes("application/json")) {
      return json(res, 400, { error: "Expected JSON body" });
    }
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    const name = (body.customerName || "").trim();
    const email = (body.customerEmail || "").trim();
    const notes = (body.decorationNotes || "").trim();

    if (!body.cakeProductId || !body.sizeLabel || !name || !email) {
      return json(res, 400, { error: "Missing required fields" });
    }
    if (!notes) return json(res, 400, { error: "Decoration notes required" });

    const orderId = await nextOrderId();
    const now = new Date().toISOString();
    const subtotal = body.sizePriceHint ? Number(body.sizePriceHint) : 0;

    try {
      // Custom cake form path: Sheets + Drive only (no Stripe until Sheet Send Deposit Invoice).
      const saved = await google.saveOrder({
        orderId,
        submittedAt: now,
        orderType: "Custom Cake Request",
        status: "Pending Review",
        customerName: name,
        customerEmail: email,
        customerPhone: body.customerPhone || "",
        eventDate: body.eventDate || "",
        product: body.cakeName,
        size: body.sizeLabel,
        flavor: body.flavor || "",
        filling: body.filling || "",
        decorationNotes: notes,
        allergies: body.allergies || "",
        additionalNotes: body.additionalNotes || "",
        lineItemsDetail: [
          body.cakeName,
          body.sizeLabel,
          body.flavor,
          body.filling,
          notes,
        ]
          .filter(Boolean)
          .join(" | "),
        estimatedSubtotal: subtotal,
        inspirationImages: body.inspirationImages,
      });

      const drivePhotos = (saved.photoLinks || []).filter((p) => isDrivePhotoLink(p));
      const order = {
        id: orderId,
        createdAt: now,
        updatedAt: now,
        status: "pending_review",
        orderType: "custom_cake",
        customerName: name,
        customerEmail: email,
        customerPhone: body.customerPhone || null,
        cakeProductId: String(body.cakeProductId),
        cakeName: body.cakeName,
        sizeLabel: body.sizeLabel,
        sizePriceHint: subtotal || null,
        flavor: body.flavor || null,
        filling: body.filling || null,
        decorationNotes: notes,
        eventDate: body.eventDate || null,
        allergies: body.allergies || null,
        additionalNotes: body.additionalNotes || null,
        inspirationImages: JSON.stringify(drivePhotos),
        stripePaymentUrl: null,
        stripeSessionId: null,
        depositCents: null,
      };
      const list = loadOrders();
      list.push(order);
      saveOrders(list);

      return json(res, 200, {
        success: true,
        orderId,
        savedTo: "google_sheets",
        photoErrors: saved.photoErrors || [],
        emailNotification: saved.emailNotification || { sent: false },
        checkoutUrl: null,
        paymentUrl: null,
        depositCents: null,
        depositDollars: null,
        estimatedSubtotal: subtotal,
        stripe: { ok: false, skipped: true, reason: "deposit_after_review_only" },
        googleSheetId: google.getSheetId(),
        googleDriveFolderId: google.getDriveFolderId(),
      });
    } catch (e) {
      console.error("[orders]", e);
      return json(res, 500, { error: e.message });
    }
  }

  if (pathname === "/api/cart-submit") {
    return json(res, 405, {
      error: "Method not allowed. Submit orders with POST.",
      allowed: ["POST", "OPTIONS"],
    });
  }

  return json(res, 404, { error: "Not found" });
}

// ─── HTTP handler ──────────────────────────────────────────────────────────

function makeHandler(getBaseUrl) {
  return async (req, res) => {
    try {
      const baseUrl = getBaseUrl();
      const url = new URL(req.url, baseUrl);
      let pathname = decodeURIComponent(url.pathname);

      if (pathname.startsWith("/api/")) {
        return await api(req, res, pathname, baseUrl);
      }

      if (pathname.startsWith("/uploads/")) {
        const file = safePath(pathname);
        return sendFile(res, file);
      }

      if (pathname === "/") pathname = "/index.html";
      return sendFile(res, safePath(pathname));
    } catch (err) {
      console.error("[error]", err);
      json(res, 500, { error: "Server error" });
    }
  };
}

function tryListen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", (err) => reject(err));
    server.listen(port, HOST, () => {
      server.removeListener("error", reject);
      resolve(port);
    });
  });
}

async function start() {
  let port = PREFERRED_PORT;
  let server;

  for (let attempt = 0; attempt < 15; attempt++) {
    const tryPort = port + attempt;
    server = http.createServer(makeHandler(() => `http://localhost:${tryPort}`));
    try {
      await tryListen(server, tryPort);
      port = tryPort;
      break;
    } catch (err) {
      if (err.code !== "EADDRINUSE" || attempt === 14) throw err;
    }
  }

  const base = `http://localhost:${port}`;
  fs.writeFileSync(
    path.join(ROOT, ".server-url"),
    base + "\n",
    "utf8",
  );

  const nets = os.networkInterfaces();
  const lan = [];
  for (const list of Object.values(nets)) {
    for (const ni of list || []) {
      if (ni.family === "IPv4" && !ni.internal) lan.push(ni.address);
    }
  }

  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║     Sweet Tooth Cravings — server is ON          ║");
  console.log("╠══════════════════════════════════════════════════╣");
  console.log(`║  Website   ${base.padEnd(33)}║`);
  console.log(`║  Admin     ${(base + "/admin.html").padEnd(33)}║`);
  console.log(`║  Health    ${(base + "/api/health").padEnd(33)}║`);
  console.log("╠══════════════════════════════════════════════════╣");
  const gs = google.isConfigured() ? "connected" : "NOT configured";
  const st = stripeConfigured() ? "connected" : "NOT configured";
  console.log(`║  Google Sheets: ${gs.padEnd(29)}║`);
  console.log(`║  Stripe deposit: ${st.padEnd(28)}║`);
  if (!google.isConfigured()) {
    console.log("║  See GOOGLE-SHEETS-SETUP.md                      ║");
  }
  if (!stripeConfigured()) {
    console.log("║  Set STRIPE_SECRET_KEY for 50% deposit Checkout  ║");
  }
  console.log(`║  Admin password: ${CONFIG.adminPassword.padEnd(26)}║`);
  console.log("║  Press Ctrl+C to stop                            ║");
  console.log("╚══════════════════════════════════════════════════╝\n");
  if (lan.length) {
    console.log("  On your phone (same Wi‑Fi):");
    for (const ip of lan) console.log(`    http://${ip}:${port}`);
    console.log("");
  }
}

if (google.isConfigured()) {
  google.ensureHeaders().catch((e) => console.warn("[google] header setup:", e.message));
}

start().catch((err) => {
  console.error("\nCould not start server:", err.message);
  console.error("\nTry:  PORT=9000 node serve.js\n");
  process.exit(1);
});