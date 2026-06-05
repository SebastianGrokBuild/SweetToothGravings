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

const CONFIG = {
  adminPassword: process.env.ADMIN_PASSWORD || "sweettooth-admin",
  sessionSecret: process.env.SESSION_SECRET || "sweettooth-local-secret",
  stripeKey: process.env.STRIPE_SECRET_KEY || "",
};

ensureDirs();

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

/** Up to 6 photos × 10MB raw + multipart overhead */
const MAX_UPLOAD_BODY_BYTES = 80 * 1024 * 1024;

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
      if (photoFiles.length >= 6) break;
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

function stripeCheckout(order, cents, baseUrl) {
  return new Promise((resolve, reject) => {
    if (!CONFIG.stripeKey) {
      reject(new Error("Add STRIPE_SECRET_KEY to .env to create payment links"));
      return;
    }
    const p = new URLSearchParams();
    p.set("mode", "payment");
    p.set("customer_email", order.customerEmail);
    p.set("success_url", `${baseUrl}/?payment=success`);
    p.set("cancel_url", `${baseUrl}/?payment=cancelled`);
    p.set("metadata[orderId]", order.id);
    p.set("line_items[0][quantity]", "1");
    p.set("line_items[0][price_data][currency]", "usd");
    p.set("line_items[0][price_data][unit_amount]", String(cents));
    p.set("line_items[0][price_data][product_data][name]", "Sweet Tooth Cravings — Custom Cake");
    p.set(
      "line_items[0][price_data][product_data][description]",
      `${order.cakeName} · ${order.sizeLabel}`,
    );
    const body = p.toString();
    const req = https.request(
      {
        hostname: "api.stripe.com",
        path: "/v1/checkout/sessions",
        method: "POST",
        headers: {
          Authorization: `Bearer ${CONFIG.stripeKey}`,
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

// ─── CORS (live shop on GitHub Pages → API on another host) ───────────────

const LIVE_ORIGINS = new Set([
  "https://sweettoothcravings.shop",
  "https://www.sweettoothcravings.shop",
]);

function corsHeaders(req) {
  const origin = req.headers.origin || "";
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  const allow =
    LIVE_ORIGINS.has(origin) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  if (origin && allow) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
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
    return json(res, 200, {
      ok: true,
      time: new Date().toISOString(),
      googleSheets: google.isConfigured(),
      googleDriveOAuth: google.isDriveOAuthReady(),
      orderEmail,
      photoStorage: "google_drive",
      uploadMode: "multipart",
      maxPhotoMb: Math.round(google.MAX_PHOTO_BYTES / (1024 * 1024)),
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
      const session = await stripeCheckout(order, cents, baseUrl);
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

  if (method === "POST" && pathname === "/api/cart-submit") {
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

    const orderId = id();
    const now = new Date().toISOString();
    let lineDetail = "";
    let subtotal = 0;
    body.items.forEach((item, i) => {
      const line = (Number(item.price) || 0) * (Number(item.quantity) || 1);
      subtotal += line;
      lineDetail += `${i + 1}. ${item.quantity}× ${item.name}`;
      const c = item.customizations || {};
      if (c.tier) lineDetail += ` | ${c.tier}`;
      if (c.flavor) lineDetail += ` | ${c.flavor}`;
      if (c.fillings?.length) lineDetail += ` | ${c.fillings.join(", ")}`;
      if (c.notes) lineDetail += ` | Notes: ${c.notes}`;
      lineDetail += ` | $${line}\n`;
    });

    const hasCustomCake = body.items.some((item) =>
      /custom cake/i.test(item.name || ""),
    );

    try {
      const saved = await google.saveOrder({
        orderId,
        submittedAt: now,
        orderType: hasCustomCake ? "Custom Cake Order" : "Menu Order",
        status: "Pending Review",
        customerName: name,
        customerEmail: email,
        customerPhone: body.customerPhone || "",
        eventDate: body.eventDate || "",
        product: "Menu items (see line items)",
        size: "",
        flavor: "",
        filling: "",
        decorationNotes: body.orderNotes || "",
        allergies: body.allergies || "",
        additionalNotes: "",
        lineItemsDetail: lineDetail.trim(),
        estimatedSubtotal: subtotal,
        photoFiles: photoFiles.length ? photoFiles : undefined,
        inspirationImages: photoFiles.length ? undefined : body.inspirationImages,
      });

      const drivePhotos = (saved.photoLinks || []).filter((p) => isDrivePhotoLink(p));

      const order = {
        id: orderId,
        createdAt: now,
        updatedAt: now,
        status: "pending_review",
        orderType: "menu",
        customerName: name,
        customerEmail: email,
        lineItemsDetail: lineDetail,
        estimatedSubtotal: subtotal,
        inspirationImages: JSON.stringify(drivePhotos),
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
      });
    } catch (e) {
      console.error("[cart-submit]", e);
      return json(res, 500, { error: e.message });
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
        lineItemsDetail: "",
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
  console.log(`║  Google Sheets: ${gs.padEnd(29)}║`);
  if (!google.isConfigured()) {
    console.log("║  See GOOGLE-SHEETS-SETUP.md                      ║");
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