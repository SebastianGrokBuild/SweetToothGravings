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
const FEEDBACK = path.join(DATA, "feedback.json");
const REVIEWS = path.join(DATA, "reviews.json");

loadEnv(path.join(ROOT, ".env"));

// Always pin Order Log + Drive folder — never write to a wrong spreadsheet.
if (typeof google.forceProductionTargets === "function") {
  google.forceProductionTargets();
}

/** Bump on every force-redeploy so health/cart-submit prove the new binary is live. */
const DEPLOY_BUILD = "2026-08-01-admin-delete-orders-v1";
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
  if (!fs.existsSync(FEEDBACK)) fs.writeFileSync(FEEDBACK, "[]\n");
  if (!fs.existsSync(REVIEWS)) {
    saveReviews(seedDefaultReviews());
  }
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

function loadFeedback() {
  try {
    const list = JSON.parse(fs.readFileSync(FEEDBACK, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveFeedback(list) {
  fs.writeFileSync(FEEDBACK, JSON.stringify(list, null, 2) + "\n");
}

/** Seed public cake reviews (published) so the shop never starts empty. */
function seedDefaultReviews() {
  const seeds = [
    { name: "Diana R", dateLabel: "2 months ago", rating: 5, text: "Best desserts you will ever have." },
    { name: "Jenny", dateLabel: "2 months ago", rating: 5, text: "Ashley is an absolute sweetheart. She offers a variety of different delicious desserts. Everything she makes is amazing. I've ordered her pistachio coquito which was phenomenal! Her chocoflan was creamy and full of flavor. Her cakes are the best! She will exceed your expectations. I truly recommend her, you will not be disappointed." },
    { name: "Jenny", dateLabel: "2 months ago", rating: 5, text: "The best!!" },
    { name: "Joey Gonzalez", dateLabel: "2 months ago", rating: 5, text: "Great products and service! Highly recommended. Great service, prompt replies. Excellent custom cakes and other party items. Very tasty! Place your orders with confidence!" },
    { name: "Pam", dateLabel: "2 months ago", rating: 5, text: "Great desserts. I ordered a party package and everything was gone in minutes! My family loved it and the design was so perfect. Thanks!" },
    { name: "Claudia Rodriguez", dateLabel: "2 months ago", rating: 5, text: "Simply the best! She is truly the best! She knows exactly what I like and always brings my ideas to life perfectly. Every order is made exactly how I ask and somehow she still manages to exceed my expectations every single time. Her attention to detail, creativity, and consistency are unmatched. I wouldn't trust anyone else with my cakes!" },
    { name: "Adriana R", dateLabel: "2 months ago", rating: 5, text: "Amazing service & delicious desserts! Ashley is such a joy to work with and made my ideas come to life with such ease. The cake was gorgeous and tasted so good ♡ Thank you for making my birthday extra sweet!" },
    { name: "Betty", dateLabel: "2 months ago", rating: 5, text: "Great taste. Super good tasting cakes. I found her on Instagram and she didn't disappoint! Will be booking her again!" },
    { name: "Katherine Galeano", dateLabel: "12 months ago", rating: 5, text: "Unforgettable Sweets. Sweet Tooth Cravings truly lives up to the name. These are hands down the best sweets I've ever had! The chocolate they use for their chocolate-covered strawberries is rich and luxurious. Their cakes are just as incredible. I'm obsessed with the guava-filled cake. The flan is also a must-try—so smooth and creamy.", verified: true },
    { name: "Pamela", dateLabel: "12 months ago", rating: 5, text: "Two cake customer. Ok I have ordered two cakes, one for my bridal proposal brunch and the other for my best friend's birthday and both not only have been so freaking adorable and well put together but the flavors are so delicious and moist! I will forever be a lifelong customer.", verified: true },
    { name: "Elizabeth", dateLabel: "12 months ago", rating: 5, text: "Catering. The best for catering — we hire her for every event. Honestly every craving me and my family have, she never disappoints us.", verified: true },
    { name: "neilyn P", dateLabel: "1 year ago", rating: 5, text: "Cupcakes and chocolate covered strawberries. The strawberries were fresh and the cupcakes were flavorful and decorated nicely. I highly recommend sweettoothcravings." },
    { name: "Marlyn Peguero", dateLabel: "1 year ago", rating: 5, text: "Best cake and flancocho. I'm glad I chose you. The cake and the flancocho were delicious. I will 100% recommend you to everyone I know. You're the best. Guests were very excited about tasting everything." },
    { name: "Zenaida", dateLabel: "1 year ago", rating: 5, text: "Amazing 🤩. Starting with the baker — she is very sweet, overall reliable (super on time) and honest. What you request is what you get. She makes sure to go over and beyond what you imagine. Then the treats are amazing — my orders have always been the hits of the party." },
    { name: "Cami Gonzalez", dateLabel: "1 year ago", rating: 5, text: "Delicioso. Muy bueno los cakes y la decoración bella." },
    { name: "Nicklas Boscan", dateLabel: "1 year ago", rating: 5, text: "The best desserts! These desserts are one better than the other. I don't think you can go wrong with any choice. The tres leches, the coquito and the flan are my favorite items." },
    { name: "Kasey Bonilla", dateLabel: "1 year ago", rating: 5, text: "Amazing! The most amazing treats I've ever tried!" },
  ];
  const now = Date.now();
  return seeds.map((s, i) => ({
    id: `rv_seed_${i + 1}`,
    name: s.name,
    rating: s.rating,
    text: s.text,
    dateLabel: s.dateLabel || "",
    verified: !!s.verified,
    status: "published",
    source: "seed",
    createdAt: new Date(now - (seeds.length - i) * 86400000).toISOString(),
  }));
}

function loadReviews() {
  try {
    if (!fs.existsSync(REVIEWS)) {
      const seeded = seedDefaultReviews();
      saveReviews(seeded);
      return seeded;
    }
    const list = JSON.parse(fs.readFileSync(REVIEWS, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return seedDefaultReviews();
  }
}

function saveReviews(list) {
  fs.writeFileSync(REVIEWS, JSON.stringify(list, null, 2) + "\n");
}

function normalizeReviewStatus(s) {
  const v = String(s || "").toLowerCase().trim();
  if (v === "published" || v === "approved" || v === "live") return "published";
  if (v === "rejected" || v === "hidden" || v === "spam") return "rejected";
  return "pending";
}

function publicReviewShape(r) {
  return {
    id: r.id,
    name: r.name,
    rating: r.rating,
    text: r.text,
    date: r.dateLabel || formatReviewDate(r.createdAt),
    dateLabel: r.dateLabel || formatReviewDate(r.createdAt),
    verified: !!r.verified,
  };
}

function formatReviewDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
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
  // Already invoiced / paid / declined — not pending
  if (
    s.includes("invoice sent") ||
    s.includes("deposit invoice sent") ||
    s.includes("deposit_invoice_sent") ||
    s === "paid" ||
    s === "completed" ||
    s === "complete" ||
    s.includes("declined") ||
    s.includes("✓ sent")
  ) {
    return false;
  }
  return (
    s === "pending review" ||
    s === "pending_review" ||
    s === "needs review" ||
    s === "new" ||
    s.indexOf("pending") === 0
  );
}

function isInvoiceSentStatus(status) {
  const s = String(status || "")
    .trim()
    .toLowerCase();
  // Exclude final-balance invoices from the deposit "Invoice Sent" bucket
  if (s.includes("balance")) return false;
  return (
    s === "invoice sent" ||
    s.includes("invoice sent") ||
    s === "deposit_invoice_sent" ||
    s.includes("deposit invoice sent")
  );
}

function isPaidOrCompletedStatus(status) {
  const s = String(status || "")
    .trim()
    .toLowerCase();
  return (
    s === "paid" ||
    s === "completed" ||
    s === "complete" ||
    s === "paid / completed" ||
    s.startsWith("paid") ||
    s.startsWith("completed")
  );
}

function summarizeOrderStatuses(orders) {
  let pending = 0;
  let invoiceSent = 0;
  let paidCompleted = 0;
  let other = 0;
  for (const o of orders || []) {
    if (isPendingReviewStatus(o.status)) pending += 1;
    else if (isPaidOrCompletedStatus(o.status)) paidCompleted += 1;
    else if (isInvoiceSentStatus(o.status)) invoiceSent += 1;
    else other += 1;
  }
  return {
    pendingReview: pending,
    invoiceSent,
    paidCompleted,
    other,
    total: (orders || []).length,
  };
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
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
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
   * Public website feedback — stored for admin only (not emailed to the customer).
   * POST /api/feedback  { name?: string, message: string }
   */
  if (method === "POST" && pathname === "/api/feedback") {
    let body = {};
    try {
      body = JSON.parse((await readBody(req, 64 * 1024)).toString() || "{}");
    } catch {
      return json(res, 400, { error: "Invalid JSON" });
    }
    const message = String(body.message || body.feedback || body.text || "").trim();
    const name = String(body.name || "").trim().slice(0, 80);
    if (!message || message.length < 3) {
      return json(res, 400, { error: "Please enter your feedback (at least a few characters)." });
    }
    if (message.length > 4000) {
      return json(res, 400, { error: "Feedback is too long (max 4000 characters)." });
    }
    const entry = {
      id: `fb_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`,
      name: name || "Anonymous",
      message,
      createdAt: new Date().toISOString(),
      userAgent: String(req.headers["user-agent"] || "").slice(0, 200),
    };
    try {
      const list = loadFeedback();
      list.unshift(entry);
      // Keep last 500 entries
      if (list.length > 500) list.length = 500;
      saveFeedback(list);
      console.log("[feedback] saved", entry.id, "from", entry.name);

      // Optional private alert to bakery inbox only (never to the customer)
      try {
        if (notify.notifyEnabled && notify.notifyEnabled() && notify.sendEmail) {
          const to = (notify.notifyTo && notify.notifyTo()) || "sweettoothcravingsorder@gmail.com";
          notify
            .sendEmail({
              to,
              subject: `Website Feedback — ${entry.name}`,
              text: [
                "New website feedback (private — Admin only).",
                "",
                `From: ${entry.name}`,
                `When: ${entry.createdAt}`,
                `Id: ${entry.id}`,
                "",
                "— Message —",
                entry.message,
                "",
                "View all feedback in Admin → Feedback.",
              ].join("\n"),
            })
            .then((r) => {
              if (r && r.ok) console.log("[feedback] owner email ok");
              else console.warn("[feedback] owner email:", r && (r.error || r.reason));
            })
            .catch((e) => console.warn("[feedback] owner email failed:", e.message));
        }
      } catch (mailErr) {
        console.warn("[feedback] owner email skipped:", mailErr.message);
      }

      return json(res, 200, { ok: true, id: entry.id });
    } catch (e) {
      console.error("[feedback] save failed:", e.message);
      return json(res, 500, { error: "Could not save feedback. Please try again." });
    }
  }

  /**
   * Admin-only: list website feedback (newest first).
   * GET /api/admin/feedback
   * DELETE /api/admin/feedback?id=…  — remove one entry
   * DELETE /api/admin/feedback?all=1 — clear all (test cleanup)
   */
  if (method === "GET" && pathname === "/api/admin/feedback") {
    if (!isAdmin(req) && !isSheetActionAuthorized(req)) {
      return json(res, 401, { error: "Unauthorized" });
    }
    const list = loadFeedback();
    return json(res, 200, { ok: true, count: list.length, feedback: list });
  }

  if (method === "DELETE" && pathname === "/api/admin/feedback") {
    if (!isAdmin(req) && !isSheetActionAuthorized(req)) {
      return json(res, 401, { error: "Unauthorized" });
    }
    const urlObj = new URL(req.url, "http://localhost");
    const clearAll =
      urlObj.searchParams.get("all") === "1" ||
      urlObj.searchParams.get("all") === "true";
    if (clearAll) {
      const before = loadFeedback().length;
      saveFeedback([]);
      console.log("[feedback] admin cleared all", before);
      return json(res, 200, { ok: true, deleted: before, cleared: true });
    }
    const id = String(urlObj.searchParams.get("id") || "").trim();
    if (!id) return json(res, 400, { error: "Feedback id required (or all=1 to clear)." });
    const list = loadFeedback();
    const next = list.filter((f) => String(f.id) !== id);
    if (next.length === list.length) return json(res, 404, { error: "Feedback not found." });
    saveFeedback(next);
    console.log("[feedback] admin delete", id);
    return json(res, 200, { ok: true, deleted: id });
  }

  /**
   * Public cake reviews (published only).
   * GET /api/reviews
   */
  if (method === "GET" && pathname === "/api/reviews") {
    const all = loadReviews();
    const published = all.filter((r) => normalizeReviewStatus(r.status) === "published");
    const avg =
      published.length === 0
        ? 5
        : Math.round(
            (published.reduce((s, r) => s + (Number(r.rating) || 5), 0) / published.length) * 10,
          ) / 10;
    return json(res, 200, {
      ok: true,
      count: published.length,
      average: avg,
      reviews: published.map(publicReviewShape),
    });
  }

  /**
   * Customer submits a cake review → pending until admin approves.
   * POST /api/reviews  { name, text/message, rating }
   */
  if (method === "POST" && pathname === "/api/reviews") {
    let body = {};
    try {
      body = JSON.parse((await readBody(req, 64 * 1024)).toString() || "{}");
    } catch {
      return json(res, 400, { error: "Invalid JSON" });
    }
    const name = String(body.name || "").trim().slice(0, 80);
    const text = String(body.text || body.message || body.review || "").trim();
    let rating = parseInt(body.rating, 10);
    if (!Number.isFinite(rating) || rating < 1) rating = 5;
    if (rating > 5) rating = 5;
    if (!name) return json(res, 400, { error: "Please enter your name." });
    if (!text || text.length < 3) {
      return json(res, 400, { error: "Please write a short review." });
    }
    if (text.length > 4000) {
      return json(res, 400, { error: "Review is too long (max 4000 characters)." });
    }
    const entry = {
      id: `rv_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`,
      name,
      rating,
      text,
      dateLabel: "Just now",
      verified: false,
      status: "pending",
      source: "customer",
      createdAt: new Date().toISOString(),
    };
    const list = loadReviews();
    list.unshift(entry);
    if (list.length > 1000) list.length = 1000;
    saveReviews(list);
    console.log("[reviews] pending", entry.id, "from", entry.name);

    // Private owner alert (not customer)
    try {
      if (notify.notifyEnabled && notify.notifyEnabled() && notify.sendEmail) {
        const to = (notify.notifyTo && notify.notifyTo()) || "sweettoothcravingsorder@gmail.com";
        notify
          .sendEmail({
            to,
            subject: `New cake review pending — ${entry.name}`,
            text: [
              "A customer left a cake review (not public yet).",
              "",
              `From: ${entry.name}`,
              `Rating: ${entry.rating}/5`,
              `Id: ${entry.id}`,
              "",
              entry.text,
              "",
              "Approve it in Admin → Reviews to show it on the website.",
            ].join("\n"),
          })
          .catch((e) => console.warn("[reviews] owner email failed:", e.message));
      }
    } catch (_) { /* ignore */ }

    return json(res, 200, {
      ok: true,
      id: entry.id,
      status: "pending",
      message: "Thanks! Your review was submitted and will appear after approval.",
    });
  }

  /**
   * Admin: list all cake reviews (pending / published / rejected).
   * GET /api/admin/reviews
   */
  if (method === "GET" && pathname === "/api/admin/reviews") {
    if (!isAdmin(req) && !isSheetActionAuthorized(req)) {
      return json(res, 401, { error: "Unauthorized" });
    }
    const list = loadReviews();
    const pending = list.filter((r) => normalizeReviewStatus(r.status) === "pending").length;
    const published = list.filter((r) => normalizeReviewStatus(r.status) === "published").length;
    return json(res, 200, {
      ok: true,
      count: list.length,
      pending,
      published,
      reviews: list,
    });
  }

  /**
   * Admin: add a review (defaults to published so it shows on the site).
   * POST /api/admin/reviews  { name, text, rating, status?, verified? }
   */
  if (method === "POST" && pathname === "/api/admin/reviews") {
    if (!isAdmin(req) && !isSheetActionAuthorized(req)) {
      return json(res, 401, { error: "Unauthorized" });
    }
    let body = {};
    try {
      body = JSON.parse((await readBody(req, 64 * 1024)).toString() || "{}");
    } catch {
      return json(res, 400, { error: "Invalid JSON" });
    }
    const name = String(body.name || "").trim().slice(0, 80);
    const text = String(body.text || body.message || "").trim();
    let rating = parseInt(body.rating, 10);
    if (!Number.isFinite(rating) || rating < 1) rating = 5;
    if (rating > 5) rating = 5;
    if (!name || !text) return json(res, 400, { error: "Name and review text are required." });
    const status = body.status != null ? normalizeReviewStatus(body.status) : "published";
    const entry = {
      id: `rv_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`,
      name,
      rating,
      text,
      dateLabel: String(body.dateLabel || body.date || "Recently").slice(0, 40),
      verified: !!body.verified,
      status,
      source: "admin",
      createdAt: new Date().toISOString(),
    };
    const list = loadReviews();
    list.unshift(entry);
    saveReviews(list);
    console.log("[reviews] admin add", entry.id, entry.status);
    return json(res, 200, { ok: true, review: entry });
  }

  /**
   * Admin: approve / reject / update a review.
   * PATCH /api/admin/reviews  { id, status?, name?, text?, rating?, verified? }
   * DELETE /api/admin/reviews?id=…
   */
  if (method === "PATCH" && pathname === "/api/admin/reviews") {
    if (!isAdmin(req) && !isSheetActionAuthorized(req)) {
      return json(res, 401, { error: "Unauthorized" });
    }
    let body = {};
    try {
      body = JSON.parse((await readBody(req, 64 * 1024)).toString() || "{}");
    } catch {
      return json(res, 400, { error: "Invalid JSON" });
    }
    const id = String(body.id || "").trim();
    if (!id) return json(res, 400, { error: "Review id required." });
    const list = loadReviews();
    const idx = list.findIndex((r) => String(r.id) === id);
    if (idx < 0) return json(res, 404, { error: "Review not found." });
    const cur = { ...list[idx] };
    if (body.status != null) cur.status = normalizeReviewStatus(body.status);
    if (body.name != null) cur.name = String(body.name).trim().slice(0, 80) || cur.name;
    if (body.text != null) cur.text = String(body.text).trim().slice(0, 4000) || cur.text;
    if (body.rating != null) {
      let rating = parseInt(body.rating, 10);
      if (Number.isFinite(rating)) cur.rating = Math.min(5, Math.max(1, rating));
    }
    if (body.verified != null) cur.verified = !!body.verified;
    if (body.dateLabel != null) cur.dateLabel = String(body.dateLabel).slice(0, 40);
    cur.updatedAt = new Date().toISOString();
    list[idx] = cur;
    saveReviews(list);
    console.log("[reviews] admin patch", id, cur.status);
    return json(res, 200, { ok: true, review: cur });
  }

  if (method === "DELETE" && pathname === "/api/admin/reviews") {
    if (!isAdmin(req) && !isSheetActionAuthorized(req)) {
      return json(res, 401, { error: "Unauthorized" });
    }
    const urlObj = new URL(req.url, "http://localhost");
    const id = String(urlObj.searchParams.get("id") || "").trim();
    if (!id) return json(res, 400, { error: "Review id required." });
    const list = loadReviews();
    const next = list.filter((r) => String(r.id) !== id);
    if (next.length === list.length) return json(res, 404, { error: "Review not found." });
    saveReviews(next);
    console.log("[reviews] admin delete", id);
    return json(res, 200, { ok: true, deleted: id });
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
        const rawPhotos = Array.isArray(o.photoLinks)
          ? o.photoLinks
          : [];
        const photos =
          typeof google.normalizeSheetPhotoLinks === "function"
            ? google.normalizeSheetPhotoLinks(rawPhotos)
            : rawPhotos
                .filter(Boolean)
                .map((url, i) => ({
                  url,
                  thumb: url,
                  label: `Photo ${i + 1}`,
                }));
        const lineItemsDetail = o.lineItemsDetail || "";
        const parsed =
          typeof google.parseLineItemsDetail === "function"
            ? google.parseLineItemsDetail(lineItemsDetail)
            : {
                cartLines: [],
                cartText: lineItemsDetail,
                allergies: o.allergies || "",
                notes: o.decorationNotes || o.notes || "",
                additionalNotes: o.additionalNotes || "",
                specialRequests: o.decorationNotes || "",
              };
        return {
          id: o.id,
          orderNumber: o.id,
          sheetRow: null,
          status: o.status || "pending_review",
          customerName: o.customerName || "",
          customerEmail: o.customerEmail || "",
          customerPhone: o.customerPhone || "",
          eventDate: o.eventDate || "",
          lineItemsDetail,
          cartLines: parsed.cartLines,
          cartText: parsed.cartText,
          allergies: parsed.allergies || o.allergies || "",
          notes: parsed.notes || o.decorationNotes || o.notes || "",
          additionalNotes: parsed.additionalNotes || o.additionalNotes || "",
          specialRequests:
            parsed.specialRequests || o.decorationNotes || o.notes || "",
          estimatedSubtotal: sub,
          depositAmount: deposit,
          depositDue: deposit,
          orderType: o.orderType || "",
          createdAt: o.createdAt || null,
          photo1: rawPhotos[0] || "",
          photo2: rawPhotos[1] || "",
          photo3: rawPhotos[2] || "",
          photos,
          photoLinks: rawPhotos.filter(Boolean),
          // Payment links for Admin “Copy Payment Link”
          paymentUrl:
            o.stripePaymentUrl ||
            o.paymentUrl ||
            o.checkoutUrl ||
            null,
          stripePaymentUrl: o.stripePaymentUrl || null,
          stripeBalancePaymentUrl: o.stripeBalancePaymentUrl || null,
          source: "local",
        };
      });

      // Prefer sheet rows; merge local-only orders not already in sheet
      // (and fill missing photos / payment links from local when sheet row has none)
      const byId = new Map();
      for (const o of sheetOrders) {
        byId.set(String(o.orderNumber || o.id), o);
      }
      for (const o of local) {
        const key = String(o.orderNumber || o.id);
        if (!byId.has(key)) {
          byId.set(key, o);
        } else {
          const existing = byId.get(key);
          const hasPhotos =
            Array.isArray(existing.photos) && existing.photos.length > 0;
          if (!hasPhotos && Array.isArray(o.photos) && o.photos.length > 0) {
            existing.photos = o.photos;
            existing.photoLinks = o.photoLinks;
            existing.photo1 = o.photo1;
            existing.photo2 = o.photo2;
            existing.photo3 = o.photo3;
          }
          if (!existing.paymentUrl && o.paymentUrl) {
            existing.paymentUrl = o.paymentUrl;
          }
          if (!existing.stripePaymentUrl && o.stripePaymentUrl) {
            existing.stripePaymentUrl = o.stripePaymentUrl;
            existing.paymentUrl = existing.paymentUrl || o.stripePaymentUrl;
          }
          if (!existing.stripeBalancePaymentUrl && o.stripeBalancePaymentUrl) {
            existing.stripeBalancePaymentUrl = o.stripeBalancePaymentUrl;
          }
        }
      }

      const all = [...byId.values()].sort((a, b) => {
        const ta = new Date(a.createdAt || 0).getTime() || 0;
        const tb = new Date(b.createdAt || 0).getTime() || 0;
        if (tb !== ta) return tb - ta;
        return (b.sheetRow || 0) - (a.sheetRow || 0);
      });
      const summary = summarizeOrderStatuses(all);
      const pending = all.filter(
        (o) =>
          isPendingReviewStatus(o.status) &&
          o.customerEmail &&
          String(o.customerEmail).includes("@"),
      );

      return json(res, 200, {
        success: true,
        // Full recent list so Admin can filter by dashboard cards
        orders: all,
        pending,
        count: pending.length,
        summary,
        sheetError,
      });
    } catch (e) {
      console.error("[admin/pending-orders]", e);
      return json(res, 500, { error: e.message || String(e) });
    }
  }

  /**
   * Delete order(s) — Admin cleanup for test orders.
   * DELETE /api/admin/orders?orderNumber=ST-…&row=12
   * DELETE /api/admin/orders?pending=1  — remove all Pending Review orders
   */
  if (method === "DELETE" && pathname === "/api/admin/orders") {
    if (!isAdmin(req) && !isSheetActionAuthorized(req)) {
      return json(res, 401, { error: "Unauthorized" });
    }
    const urlObj = new URL(req.url, "http://localhost");
    const clearPending =
      urlObj.searchParams.get("pending") === "1" ||
      urlObj.searchParams.get("pending") === "true" ||
      urlObj.searchParams.get("allPending") === "1";
    const orderNumber = String(
      urlObj.searchParams.get("orderNumber") ||
        urlObj.searchParams.get("orderId") ||
        urlObj.searchParams.get("id") ||
        "",
    ).trim();
    const sheetRowRaw = urlObj.searchParams.get("row") || urlObj.searchParams.get("sheetRow");
    const sheetRow =
      sheetRowRaw != null && sheetRowRaw !== "" ? Number(sheetRowRaw) : null;

    try {
      google.forceProductionTargets();

      if (clearPending) {
        // Build list of pending orders (sheet + local)
        let sheetOrders = [];
        try {
          if (typeof google.listRecentOrdersFromSheet === "function") {
            const listed = await google.listRecentOrdersFromSheet({ limit: 200 });
            if (listed.ok) sheetOrders = listed.orders || [];
          }
        } catch (e) {
          console.warn("[admin/delete-orders] sheet list failed:", e.message);
        }
        const local = loadOrders();
        const pendingSheet = sheetOrders.filter((o) =>
          isPendingReviewStatus(o.status),
        );
        // Delete sheet rows bottom-up so indexes stay valid
        const rows = pendingSheet
          .map((o) => ({
            orderNumber: o.orderNumber || o.id,
            sheetRow: o.sheetRow != null ? Number(o.sheetRow) : null,
          }))
          .filter((r) => r.orderNumber || (r.sheetRow && r.sheetRow >= 2))
          .sort((a, b) => (b.sheetRow || 0) - (a.sheetRow || 0));

        const deleted = [];
        const errors = [];
        for (const r of rows) {
          try {
            if (typeof google.deleteOrderFromSheet === "function") {
              await google.deleteOrderFromSheet({
                orderNumber: r.orderNumber,
                sheetRow: r.sheetRow,
              });
            }
            deleted.push(r.orderNumber || `row:${r.sheetRow}`);
          } catch (e) {
            errors.push({
              order: r.orderNumber,
              error: e.message || String(e),
            });
            console.warn("[admin/delete-orders] sheet delete failed:", e.message);
          }
        }

        // Remove pending from local file
        const localBefore = local.length;
        const localNext = local.filter((o) => !isPendingReviewStatus(o.status));
        saveOrders(localNext);
        const localRemoved = localBefore - localNext.length;

        console.log(
          "[admin/delete-orders] cleared pending sheet=",
          deleted.length,
          "local=",
          localRemoved,
          "errors=",
          errors.length,
        );
        return json(res, 200, {
          ok: true,
          clearedPending: true,
          deletedSheet: deleted,
          deletedLocal: localRemoved,
          errors,
        });
      }

      if (!orderNumber && !(sheetRow >= 2)) {
        return json(res, 400, {
          error: "Provide orderNumber (and optional row) or pending=1 to clear all pending.",
        });
      }

      let sheetDeleted = false;
      let sheetError = null;
      try {
        if (typeof google.deleteOrderFromSheet === "function") {
          await google.deleteOrderFromSheet({
            orderNumber: orderNumber || undefined,
            sheetRow: sheetRow >= 2 ? sheetRow : undefined,
          });
          sheetDeleted = true;
        }
      } catch (e) {
        sheetError = e.message || String(e);
        // Still try local delete — order may be local-only
        console.warn("[admin/delete-orders] sheet:", sheetError);
      }

      const local = loadOrders();
      const want = String(orderNumber || "").trim().toLowerCase();
      const localNext = local.filter((o) => {
        const id = String(o.id || o.orderId || "").trim().toLowerCase();
        return !want || id !== want;
      });
      const localDeleted = local.length - localNext.length;
      if (localDeleted > 0) saveOrders(localNext);

      if (!sheetDeleted && localDeleted === 0) {
        return json(res, 404, {
          error: sheetError || "Order not found in sheet or local store.",
        });
      }

      return json(res, 200, {
        ok: true,
        orderNumber: orderNumber || null,
        sheetDeleted,
        localDeleted,
        sheetError,
      });
    } catch (e) {
      console.error("[admin/delete-orders]", e);
      return json(res, 500, { error: e.message || String(e) });
    }
  }

  /**
   * Update order Status in Google Sheet (and local orders.json when present).
   * POST /api/admin/update-order-status
   * Body: { orderNumber, row?, status: "Paid" | "Completed" | "Invoice Sent" | ... }
   */
  if (method === "POST" && pathname === "/api/admin/update-order-status") {
    if (!isAdmin(req) && !isSheetActionAuthorized(req)) {
      return json(res, 401, { error: "Unauthorized" });
    }
    let body = {};
    try {
      body = JSON.parse((await readBody(req)).toString() || "{}");
    } catch {
      return json(res, 400, { error: "Invalid JSON body" });
    }

    const orderNumber = String(
      body.orderNumber || body.orderId || body.order || "",
    ).trim();
    const sheetRow =
      body.row != null && body.row !== ""
        ? body.row
        : body.sheetRow != null
          ? body.sheetRow
          : null;
    let status = String(body.status || "").trim();
    // Normalize common labels / aliases from Admin UI
    const statusKey = status.toLowerCase().replace(/[_-]+/g, " ").trim();
    if (
      statusKey === "mark as paid" ||
      statusKey === "paid" ||
      statusKey === "payment received"
    ) {
      status = "Paid";
    } else if (
      statusKey === "mark as completed" ||
      statusKey === "completed" ||
      statusKey === "complete" ||
      statusKey === "done"
    ) {
      status = "Completed";
    } else if (
      statusKey === "invoice sent" ||
      statusKey === "deposit invoice sent" ||
      statusKey === "balance invoice sent"
    ) {
      status = "Invoice Sent";
    } else if (
      statusKey === "pending review" ||
      statusKey === "pending" ||
      statusKey === "review" ||
      statusKey === "new" ||
      statusKey === "move back to pending" ||
      statusKey === "revert"
    ) {
      status = "Pending Review";
    } else if (statusKey === "declined" || statusKey === "decline") {
      status = "Declined";
    }

    if (!orderNumber && (sheetRow == null || sheetRow === "")) {
      return json(res, 400, { error: "orderNumber or row is required" });
    }
    if (!status) {
      return json(res, 400, { error: "status is required" });
    }

    const allowed = new Set([
      "Pending Review",
      "Invoice Sent",
      "Paid",
      "Completed",
      "Declined",
    ]);
    if (!allowed.has(status)) {
      return json(res, 400, {
        error: `Unsupported status "${status}". Use: ${[...allowed].join(", ")}`,
      });
    }

    try {
      google.forceProductionTargets();
      // Only update Stripe Deposit column for forward-looking paid/sent states.
      // Leaving null on Pending Review keeps any prior deposit note intact.
      const stripeDepositLabel =
        status === "Invoice Sent"
          ? "✓ Sent"
          : status === "Paid" || status === "Completed"
            ? "✓ Paid"
            : null;

      const sheetUpdate = await google.updateOrderStatusInSheet({
        orderNumber,
        sheetRow,
        status,
        stripeDepositLabel,
      });

      // Mirror onto local orders.json when we know the id
      if (orderNumber) {
        const list = loadOrders();
        const order = list.find((o) => o.id === orderNumber);
        if (order) {
          order.status = status;
          order.updatedAt = new Date().toISOString();
          saveOrders(list);
        }
      }

      return json(res, 200, {
        success: true,
        orderNumber,
        status,
        sheetUpdate,
      });
    } catch (e) {
      console.error("[admin/update-order-status]", e);
      return json(res, 500, { error: e.message || String(e) });
    }
  }

  /**
   * Edit customer / order fields from Admin (writes Google Sheet).
   * POST /api/admin/update-order-fields
   * Body: { orderNumber, row?, customerName?, customerEmail?, customerPhone?,
   *         eventDate?, allergies?, notes?, additionalNotes?, estimatedSubtotal? }
   */
  if (method === "POST" && pathname === "/api/admin/update-order-fields") {
    if (!isAdmin(req) && !isSheetActionAuthorized(req)) {
      return json(res, 401, { error: "Unauthorized" });
    }
    let body = {};
    try {
      body = JSON.parse((await readBody(req)).toString() || "{}");
    } catch {
      return json(res, 400, { error: "Invalid JSON body" });
    }

    const orderNumber = String(
      body.orderNumber || body.orderId || body.order || "",
    ).trim();
    const sheetRow =
      body.row != null && body.row !== ""
        ? body.row
        : body.sheetRow != null
          ? body.sheetRow
          : null;

    if (!orderNumber && (sheetRow == null || sheetRow === "")) {
      return json(res, 400, { error: "orderNumber or row is required" });
    }

    const fields = {};
    if (body.customerName !== undefined) {
      fields.customerName = String(body.customerName || "").trim();
    }
    if (body.customerEmail !== undefined) {
      fields.customerEmail = String(body.customerEmail || "").trim();
    }
    if (body.customerPhone !== undefined) {
      fields.customerPhone = String(body.customerPhone || "").trim();
    }
    if (body.eventDate !== undefined) {
      fields.eventDate = String(body.eventDate || "").trim();
    }
    if (body.allergies !== undefined) {
      fields.allergies = String(body.allergies || "").trim();
    }
    if (body.notes !== undefined) {
      fields.notes = String(body.notes || "").trim();
    }
    if (body.decorationNotes !== undefined && body.notes === undefined) {
      fields.notes = String(body.decorationNotes || "").trim();
    }
    if (body.additionalNotes !== undefined) {
      fields.additionalNotes = String(body.additionalNotes || "").trim();
    }
    if (body.estimatedSubtotal !== undefined && body.estimatedSubtotal !== "") {
      fields.estimatedSubtotal = body.estimatedSubtotal;
    }
    if (body.lineItemsDetail !== undefined) {
      fields.lineItemsDetail = String(body.lineItemsDetail || "");
    }

    if (!Object.keys(fields).length) {
      return json(res, 400, { error: "No fields to update" });
    }

    if (
      fields.customerEmail !== undefined &&
      fields.customerEmail &&
      !fields.customerEmail.includes("@")
    ) {
      return json(res, 400, { error: "Invalid email address" });
    }

    try {
      google.forceProductionTargets();
      if (typeof google.updateOrderFieldsInSheet !== "function") {
        throw new Error("Sheet field update not available on this deploy");
      }
      const sheetUpdate = await google.updateOrderFieldsInSheet({
        orderNumber,
        sheetRow,
        fields,
      });

      // Mirror onto local orders.json when present
      if (orderNumber) {
        const list = loadOrders();
        const order = list.find((o) => o.id === orderNumber);
        if (order) {
          if (fields.customerName !== undefined) {
            order.customerName = fields.customerName;
          }
          if (fields.customerEmail !== undefined) {
            order.customerEmail = fields.customerEmail;
          }
          if (fields.customerPhone !== undefined) {
            order.customerPhone = fields.customerPhone || null;
          }
          if (fields.eventDate !== undefined) {
            order.eventDate = fields.eventDate || null;
          }
          if (fields.allergies !== undefined) {
            order.allergies = fields.allergies || null;
          }
          if (fields.notes !== undefined) {
            order.decorationNotes = fields.notes || null;
            order.notes = fields.notes || null;
          }
          if (fields.additionalNotes !== undefined) {
            order.additionalNotes = fields.additionalNotes || null;
          }
          if (fields.lineItemsDetail !== undefined) {
            order.lineItemsDetail = fields.lineItemsDetail;
          } else if (sheetUpdate.updated && sheetUpdate.updated.lineItemsDetail) {
            order.lineItemsDetail = sheetUpdate.updated.lineItemsDetail;
          }
          if (
            fields.estimatedSubtotal !== undefined &&
            Number.isFinite(Number(fields.estimatedSubtotal))
          ) {
            order.estimatedSubtotal = Number(fields.estimatedSubtotal);
          }
          order.updatedAt = new Date().toISOString();
          saveOrders(list);
        }
      }

      return json(res, 200, {
        success: true,
        orderNumber,
        sheetUpdate,
        updated: (sheetUpdate && sheetUpdate.updated) || fields,
      });
    } catch (e) {
      console.error("[admin/update-order-fields]", e);
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
          order.status = "Invoice Sent";
          order.updatedAt = new Date().toISOString();
          saveOrders(list);
        }
      }

      // Update Google Sheet Status → "Invoice Sent" (Admin + sheet stay in sync)
      let sheetUpdate = null;
      try {
        if (typeof google.updateOrderStatusInSheet === "function") {
          sheetUpdate = await google.updateOrderStatusInSheet({
            orderNumber,
            sheetRow: row,
            status: "Invoice Sent",
            stripeDepositLabel: "✓ Sent",
          });
        }
      } catch (sheetErr) {
        console.warn(
          "[send-deposit-invoice] sheet status update failed:",
          sheetErr.message,
        );
        sheetUpdate = { ok: false, error: sheetErr.message };
      }

      console.log(
        `[send-deposit-invoice] LIVE ${inv.invoiceId} $${((inv.amountDueCents || depositCents) / 100).toFixed(2)} → ${email} order=${orderNumber} sheet=${sheetUpdate && sheetUpdate.ok ? "Invoice Sent" : "status-update-failed"}`,
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
        sheetStatus: "Invoice Sent",
        sheetUpdate,
      });
    } catch (e) {
      console.error("[send-deposit-invoice]", e);
      return json(res, 500, { error: e.message || String(e) });
    }
  }

  /**
   * Final balance invoice (remaining 50% after deposit).
   * POST /api/send-final-balance-invoice
   * Body: { orderNumber, email, estimatedSubtotal?, depositAmount?, row?, customerName?, ... }
   */
  if (method === "POST" && pathname === "/api/send-final-balance-invoice") {
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
        error: "email cannot be the bakery inbox — use the customer address",
      });
    }
    if (!stripeLiveConfigured()) {
      return json(res, 503, {
        error:
          "Stripe is not in live mode. On Render set STRIPE_SECRET_KEY to sk_live_…",
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
      });
    }

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
      body.depositAmount ?? body.depositDollars ?? body.deposit,
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

    if ((!Number.isFinite(depositDollars) || depositDollars <= 0) && Number.isFinite(subtotal) && subtotal > 0) {
      depositDollars = Math.round(subtotal * 50) / 100;
    }
    if ((!Number.isFinite(subtotal) || subtotal <= 0) && Number.isFinite(depositDollars) && depositDollars > 0) {
      subtotal = Math.round(depositDollars * 2 * 100) / 100;
    }

    // Optional explicit balance amount
    let balanceDollars = parseMoneyValue(
      body.balanceAmount ?? body.finalBalance ?? body.remainingBalance,
    );
    if (!Number.isFinite(balanceDollars) || balanceDollars <= 0) {
      if (Number.isFinite(subtotal) && Number.isFinite(depositDollars)) {
        balanceDollars = Math.round((subtotal - depositDollars) * 100) / 100;
      }
    }
    if (!Number.isFinite(balanceDollars) || balanceDollars < 0.5) {
      return json(res, 400, {
        error:
          "Need a remaining balance of at least $0.50. Pass estimatedSubtotal and depositAmount (or balanceAmount).",
      });
    }

    const balanceCents = Math.round(balanceDollars * 100);
    const customerName = String(
      body.customerName || body.name || (saved && saved.customerName) || "",
    ).trim();
    const eventDate = String(
      body.eventDate || (saved && saved.eventDate) || "",
    ).trim();
    const lineSummary = String(
      body.lineItemsDetail ||
        body.lineItems ||
        (saved && saved.lineItemsDetail) ||
        "",
    ).trim();
    const parsedLineItems = parseSheetLineItems(lineSummary);
    const desc = [
      customerName ? `For ${customerName}` : null,
      Number.isFinite(subtotal) ? `Order total $${subtotal.toFixed(2)}` : null,
      Number.isFinite(depositDollars)
        ? `Deposit paid $${depositDollars.toFixed(2)}`
        : null,
      `Final balance due $${balanceDollars.toFixed(2)}`,
      `Order ${orderNumber}`,
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
        amountCents: balanceCents,
        subtotalCents: Number.isFinite(subtotal)
          ? Math.round(subtotal * 100)
          : balanceCents * 2,
        lineItems: parsedLineItems,
        lineItemsText: lineSummary,
        orderDetails: [
          `Order: ${orderNumber}`,
          `Final balance (after deposit)`,
          customerName ? `Customer: ${customerName}` : null,
          `Email: ${email}`,
          Number.isFinite(subtotal) ? `Est. total: $${subtotal.toFixed(2)}` : null,
          Number.isFinite(depositDollars)
            ? `Deposit: $${depositDollars.toFixed(2)}`
            : null,
          `Balance due: $${balanceDollars.toFixed(2)}`,
          lineSummary || null,
        ]
          .filter(Boolean)
          .join(" · "),
        description: desc,
        footer: [
          `Final balance invoice · emailed only to: ${email}`,
          `Order ${orderNumber}`,
          eventDate ? `Event: ${eventDate}` : null,
        ]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 500),
      });

      const invoiceUrl = inv.url || "";
      if (!invoiceUrl) {
        return json(res, 500, { error: "Stripe did not return an invoice URL" });
      }

      if (saved) {
        const list = loadOrders();
        const order = list.find((o) => o.id === saved.id);
        if (order) {
          order.stripeBalancePaymentUrl = invoiceUrl;
          order.stripeBalanceInvoiceId = inv.invoiceId;
          order.balanceCents = inv.amountDueCents || balanceCents;
          order.status = "Balance Invoice Sent";
          order.updatedAt = new Date().toISOString();
          saveOrders(list);
        }
      }

      let sheetUpdate = null;
      try {
        if (typeof google.updateOrderStatusInSheet === "function") {
          sheetUpdate = await google.updateOrderStatusInSheet({
            orderNumber,
            sheetRow: row,
            status: "Balance Invoice Sent",
            stripeDepositLabel: "Balance sent",
          });
        }
      } catch (sheetErr) {
        console.warn(
          "[send-final-balance-invoice] sheet status update failed:",
          sheetErr.message,
        );
        sheetUpdate = { ok: false, error: sheetErr.message };
      }

      console.log(
        `[send-final-balance-invoice] LIVE ${inv.invoiceId} $${balanceDollars.toFixed(2)} → ${email} order=${orderNumber}`,
      );

      return json(res, 200, {
        success: true,
        invoiceUrl,
        orderNumber,
        email,
        row,
        invoiceId: inv.invoiceId,
        balanceDollars: (inv.amountDueCents || balanceCents) / 100,
        depositDollars: Number.isFinite(depositDollars) ? depositDollars : null,
        estimatedSubtotal: Number.isFinite(subtotal) ? subtotal : null,
        livemode: true,
        keyMode: "live",
        sheetStatus: "Balance Invoice Sent",
        sheetUpdate,
        paymentType: "final_balance",
      });
    } catch (e) {
      console.error("[send-final-balance-invoice]", e);
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
        order.status = emailResult.sent ? "Invoice Sent" : order.status;
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

      let sheetUpdate = null;
      if (emailResult.sent) {
        try {
          if (typeof google.updateOrderStatusInSheet === "function") {
            sheetUpdate = await google.updateOrderStatusInSheet({
              orderNumber: oid,
              status: "Invoice Sent",
              stripeDepositLabel: "✓ Sent",
            });
          }
        } catch (sheetErr) {
          console.warn(
            "[sheet/send-deposit-invoice] status update failed:",
            sheetErr.message,
          );
          sheetUpdate = { ok: false, error: sheetErr.message };
        }
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
          ? "Invoice Sent"
          : "Deposit link created (email failed)",
        sheetUpdate,
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

      // Owner new-order email (primary send is inside google.saveOrder; retry once if needed)
      let emailNotification = saved.emailNotification || { sent: false };
      if (!emailNotification.sent && !emailNotification.skipped) {
        try {
          console.warn(
            `[cart-submit] Owner notify missing for ${orderId} — retrying…`,
            emailNotification.error || "",
          );
          const retry = await notify.sendNewOrderEmail(
            {
              orderId,
              submittedAt: now,
              orderType: hasCustomCake ? "Custom Cake Order" : "Menu Order",
              status: "Pending Review",
              customerName: name,
              customerEmail: email,
              customerPhone: phone,
              eventDate,
              decorationNotes: orderNotes,
              allergies,
              lineItemsDetail: lineDetail.trim(),
              estimatedSubtotal: subtotal,
              depositAmount:
                subtotal > 0 ? Math.round(subtotal * 50) / 100 : null,
            },
            drivePhotos,
            saved.photoErrors || [],
          );
          if (retry && retry.ok) {
            emailNotification = {
              sent: true,
              to: retry.to,
              method: retry.method,
              from: retry.from,
              retried: true,
            };
          } else if (retry && retry.skipped) {
            emailNotification = {
              sent: false,
              skipped: true,
              reason: retry.reason,
            };
          } else {
            emailNotification = {
              sent: false,
              error:
                (retry && (retry.error || retry.reason)) ||
                emailNotification.error ||
                "email_failed",
            };
          }
        } catch (e) {
          console.error(
            "[cart-submit] Owner notify retry failed:",
            e.message,
          );
          emailNotification = {
            sent: false,
            error: e.message || String(e),
          };
        }
      }
      if (emailNotification.sent) {
        console.log(
          `[cart-submit] Owner notified ${emailNotification.to} for ${orderId} via ${emailNotification.method || "?"}`,
        );
      } else {
        console.error(
          `[cart-submit] Owner NOT notified for ${orderId}:`,
          emailNotification.error || emailNotification.reason || "unknown",
        );
      }

      // Confirmation email to the customer (separate from bakery new-order notify)
      let customerEmailNotification = { sent: false };
      try {
        const conf = await notify.sendCustomerOrderConfirmation({
          customerName: name,
          customerEmail: email,
          orderId,
          eventDate,
          lineItemsDetail: lineDetail.trim(),
          estimatedSubtotal: subtotal,
          allergies,
          orderNotes,
        });
        customerEmailNotification = {
          sent: !!(conf && conf.ok !== false && !conf.skipped),
          to: email,
          method: conf && conf.method,
          error: conf && conf.error ? String(conf.error) : null,
        };
      } catch (e) {
        console.warn("[cart-submit] customer confirmation email failed:", e.message);
        customerEmailNotification = {
          sent: false,
          to: email,
          error: e.message || String(e),
        };
      }

      const responseBody = {
        success: true,
        orderId,
        savedTo: "google_sheets",
        sheetWriteConfirmed: true,
        insertedAtRow: saved.insertedAtRow || 2,
        deployBuild: DEPLOY_BUILD,
        photoLinks: drivePhotos,
        photoErrors: saved.photoErrors || [],
        emailNotification,
        customerEmailNotification,
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

      // Ensure owner gets “New Order Received” for custom cake path too
      let emailNotification = saved.emailNotification || { sent: false };
      if (!emailNotification.sent && !emailNotification.skipped) {
        try {
          const retry = await notify.sendNewOrderEmail(
            {
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
              depositAmount:
                subtotal > 0 ? Math.round(subtotal * 50) / 100 : null,
            },
            drivePhotos,
            saved.photoErrors || [],
          );
          if (retry && retry.ok) {
            emailNotification = {
              sent: true,
              to: retry.to,
              method: retry.method,
              from: retry.from,
              retried: true,
            };
          }
        } catch (e) {
          console.error("[orders] Owner notify retry failed:", e.message);
          emailNotification = {
            sent: false,
            error: e.message || String(e),
          };
        }
      }

      return json(res, 200, {
        success: true,
        orderId,
        savedTo: "google_sheets",
        photoErrors: saved.photoErrors || [],
        emailNotification,
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