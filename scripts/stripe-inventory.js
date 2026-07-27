#!/usr/bin/env node
/** One-off Stripe inventory — prints IDs/names only, never secrets. */
const fs = require("fs");
const https = require("https");
const path = require("path");
const ROOT = path.join(__dirname, "..");
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'")) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv(path.join(ROOT, ".env"));
const key = process.env.STRIPE_SECRET_KEY || "";
if (!/^sk_(live|test)_/.test(key)) {
  console.log("STRIPE_AUDIT: STRIPE_SECRET_KEY missing or not sk_live_/sk_test_ — cannot list account");
  process.exit(0);
}
function api(p, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.stripe.com",
      path: "/v1" + p,
      method,
      headers: { Authorization: "Bearer " + key },
    };
    let payload;
    if (body) {
      payload = new URLSearchParams(body).toString();
      opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
      opts.headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = https.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(d) });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
(async () => {
  const acct = await api("/account");
  if (acct.json.error) {
    console.log("STRIPE_AUDIT_ERROR", acct.json.error.message);
    process.exit(1);
  }
  const a = acct.json;
  console.log("ACCOUNT", a.id, "type=" + (a.type || "standard"));
  if (a.controller?.stripe_dashboard?.type) console.log("DASHBOARD_TYPE", a.controller.stripe_dashboard.type);
  if (a.controller?.type) console.log("CONTROLLER_TYPE", a.controller.type);
  const prods = await api("/products?limit=100");
  const prices = await api("/prices?limit=100");
  const pl = await api("/payment_links?limit=100");
  const wh = await api("/webhook_endpoints?limit=50");
  console.log("PRODUCTS_ACTIVE", prods.json.data.filter((p) => p.active).length);
  console.log("PRICES_ACTIVE", prices.json.data.filter((p) => p.active).length);
  console.log("PAYMENT_LINKS_ACTIVE", pl.json.data.filter((l) => l.active).length);
  const names = {};
  for (const p of prods.json.data) {
    if (!p.active) continue;
    const n = p.name || "(unnamed)";
    names[n] = (names[n] || 0) + 1;
  }
  const dupNames = Object.entries(names).filter(([, c]) => c > 1);
  if (dupNames.length) console.log("DUPLICATE_PRODUCT_NAMES", JSON.stringify(dupNames));
  else console.log("DUPLICATE_PRODUCT_NAMES none");
  for (const l of pl.json.data.filter((x) => x.active)) console.log("PAYMENT_LINK", l.id, l.url);
  for (const w of wh.json.data) console.log("WEBHOOK", w.status, w.url, w.enabled_events.join("|"));
  const sessions = await api("/checkout/sessions?limit=10");
  console.log("RECENT_CHECKOUT_SESSIONS", sessions.json.data.length, "(last 10 listed)");
  for (const s of sessions.json.data.slice(0, 5))
    console.log("  SESSION", s.id, "mode=" + s.mode, "status=" + (s.status || "open"), "url=" + (s.url ? "yes" : "no"));
})().catch((e) => {
  console.error("STRIPE_AUDIT_FAIL", e.message);
  process.exit(1);
});