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
const DEPLOY_BUILD = "2026-07-27-force-sheet-v4";
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
    `forced=${google.getSheetId() === EXPECTED_SHEET_ID && google.getDriveFolderId() === EXPECTED_DRIVE_ID}`,
);

/** Cache of Stripe /v1/account probe (id must match EXPECTED_STRIPE_ACCOUNT_ID). */
let stripeAccountCache = null;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
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

function isAdmin(req) {
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
  const expected = sheetActionsSecret();
  if (!expected) return false;
  const auth = req.headers.authorization || "";
  let provided = "";
  if (/^Bearer\s+/i.test(auth)) {
    provided = auth.replace(/^Bearer\s+/i, "").trim();
  } else if (req.headers["x-sheet-secret"]) {
    provided = String(req.headers["x-sheet-secret"]).trim();
  }
  if (!provided) return false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Parse "$45.00" / "45" / "45,00" style values from the sheet. */
function parseMoneyValue(raw) {
  if (raw == null || raw === "") return NaN;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  let s = String(raw).trim();
  if (!s) return NaN;
  s = s.replace(/[^0-9.,-]/g, "");
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

function stripeConfigured() {
  return /^sk_(live|test)_/.test(String(CONFIG.stripeKey || "").trim());
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
    const ok = id === CONFIG.stripeAccountId;
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
      livemode: !!acct.livemode,
      error: ok
        ? null
        : `Stripe key is for ${id || "unknown"}, expected ${CONFIG.stripeAccountId}`,
    };
    stripeAccountCache = { at: now, status };
    return status;
  } catch (e) {
    const status = {
      configured: true,
      ok: false,
      expectedAccountId: CONFIG.stripeAccountId,
      error: e.message || String(e),
    };
    stripeAccountCache = { at: now, status };
    return status;
  }
}

/**
 * Create a Stripe Checkout Session on the Sweet Tooth account.
 * @param {object} opts
 * @param {string} opts.orderId
 * @param {string} opts.customerEmail
 * @param {number} opts.amountCents — charge amount in cents
 * @param {string} opts.shopUrl — success/cancel base
 * @param {string} [opts.productName]
 * @param {string} [opts.description]
 * @param {object} [opts.metadata]
 */
function stripeCheckout(opts) {
  return new Promise((resolve, reject) => {
    if (!stripeConfigured()) {
      reject(
        new Error(
          "Add STRIPE_SECRET_KEY for Sweet Tooth Stripe account acct_1TcrMNHTYIZb4z2l on Render",
        ),
      );
      return;
    }
    const amountCents = Math.round(Number(opts.amountCents) || 0);
    if (amountCents < 50) {
      reject(new Error("Stripe amount must be at least $0.50"));
      return;
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

    const p = new URLSearchParams();
    p.set("mode", "payment");
    if (email) p.set("customer_email", email);
    p.set("success_url", `${shopUrl}/?payment=success&order=${encodeURIComponent(orderId)}`);
    p.set("cancel_url", `${shopUrl}/?payment=cancelled&order=${encodeURIComponent(orderId)}`);
    p.set("metadata[orderId]", orderId);
    p.set("metadata[paymentType]", opts.paymentType || "payment");
    p.set("metadata[stripeAccountId]", CONFIG.stripeAccountId);
    p.set("metadata[source]", "sweet_tooth_order_log");
    if (opts.depositCents != null) {
      p.set("metadata[depositCents]", String(opts.depositCents));
    }
    if (opts.estimatedSubtotalCents != null) {
      p.set("metadata[estimatedSubtotalCents]", String(opts.estimatedSubtotalCents));
    }
    p.set("line_items[0][quantity]", "1");
    p.set("line_items[0][price_data][currency]", "usd");
    p.set("line_items[0][price_data][unit_amount]", String(amountCents));
    p.set("line_items[0][price_data][product_data][name]", productName.slice(0, 120));
    p.set("line_items[0][price_data][product_data][description]", description);
    // Show a clear receipt-style description on the Checkout page
    p.set("payment_intent_data[description]", `${productName} · order ${orderId}`.slice(0, 1000));
    p.set("payment_intent_data[metadata][orderId]", orderId);
    p.set("payment_intent_data[metadata][stripeAccountId]", CONFIG.stripeAccountId);

    const body = p.toString();
    const req = https.request(
      {
        hostname: "api.stripe.com",
        path: "/v1/checkout/sessions",
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
            if (j.error) reject(new Error(j.error.message));
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
    const stripeOk = stripeConfigured() && stripeStatus.ok;
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
    if (body.password !== CONFIG.adminPassword) {
      return json(res, 401, { error: "Wrong password" });
    }
    return json(
      res,
      200,
      { success: true },
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
    const customerEmail = String(
      body.customerEmail || body.email || "",
    ).trim();
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
    const orderType = String(body.orderType || body.order_type || "Order").trim();

    if (!customerEmail || !customerEmail.includes("@")) {
      return json(res, 400, { error: "Customer email is required on this row" });
    }
    if (!stripeConfigured()) {
      return json(res, 503, {
        error:
          "Stripe is not configured. On Render set STRIPE_SECRET_KEY to the Secret key for Sweet Tooth account acct_1TcrMNHTYIZb4z2l (Stripe Dashboard → Developers → API keys).",
      });
    }

    const stripeStatus = await getStripeAccountStatus();
    if (!stripeStatus.ok) {
      return json(res, 503, {
        error:
          stripeStatus.error ||
          `Stripe key must belong to account ${CONFIG.stripeAccountId}`,
      });
    }

    // After review: prefer explicit finalTotal, else deposit amount column, else 50% of subtotal
    let subtotal = parseMoneyValue(
      body.finalTotal != null ? body.finalTotal : body.estimatedSubtotal,
    );
    let depositDollars = parseMoneyValue(body.depositAmount ?? body.depositDue);

    if ((!Number.isFinite(depositDollars) || depositDollars <= 0) && Number.isFinite(subtotal) && subtotal > 0) {
      depositDollars = Math.round(subtotal * 50) / 100;
    }
    if ((!Number.isFinite(subtotal) || subtotal <= 0) && Number.isFinite(depositDollars) && depositDollars > 0) {
      subtotal = Math.round(depositDollars * 2 * 100) / 100;
    }

    if (!Number.isFinite(depositDollars) || depositDollars < 0.5) {
      return json(res, 400, {
        error:
          "Need a deposit of at least $0.50. Set Estimated Subtotal (or Deposit Due 50%) on the row after review.",
      });
    }

    const depositCents = Math.round(depositDollars * 100);
    const shopUrl = shopPublicUrl(req, baseUrl);
    const oid = orderId || `sheet-${Date.now().toString(36)}`;

    try {
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
        description: [
          customerName ? `For ${customerName}` : null,
          Number.isFinite(subtotal) ? `Est. total $${subtotal.toFixed(2)}` : null,
          `Deposit $${depositDollars.toFixed(2)} (50%)`,
          lineSummary.replace(/\s+/g, " ").slice(0, 280),
          orderType ? `(${orderType})` : null,
        ]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 500),
      });

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
        order.stripePaymentUrl = session.url;
        order.stripeSessionId = session.id;
        order.depositCents = depositCents;
        order.status = "deposit_invoice_sent";
        order.updatedAt = new Date().toISOString();
        if (Number.isFinite(subtotal)) {
          order.finalPriceCents = Math.round(subtotal * 100);
        }
        saveOrders(list);
      }

      let emailResult = { sent: false };
      try {
        emailResult = await notify.sendDepositInvoiceToCustomer({
          customerName,
          customerEmail,
          orderId: oid,
          depositDollars,
          estimatedSubtotal: Number.isFinite(subtotal) ? subtotal : null,
          checkoutUrl: session.url,
          lineSummary,
          eventDate,
        });
        emailResult = { sent: true, ...emailResult };
      } catch (e) {
        console.error("[sheet/send-deposit-invoice] email failed:", e.message);
        emailResult = { sent: false, error: e.message };
      }

      return json(res, 200, {
        success: true,
        orderId: oid,
        checkoutUrl: session.url,
        paymentUrl: session.url,
        sessionId: session.id,
        depositDollars,
        depositCents,
        estimatedSubtotal: Number.isFinite(subtotal) ? subtotal : null,
        email: emailResult,
        sheetStatus: "Deposit invoice sent",
        message: emailResult.sent
          ? `Deposit invoice emailed to ${customerEmail}`
          : `Checkout created but email failed: ${emailResult.error || "unknown"}. Share this link manually: ${session.url}`,
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

      const orderId = id();
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
      // 50% deposit Checkout is created later via Sheet "Send Deposit Invoice".
      // Guaranteed sheet write: saveOrder throws if Sheets API fails — we never return success without it.
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

    const orderId = id();
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