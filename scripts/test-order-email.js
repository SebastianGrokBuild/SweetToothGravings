#!/usr/bin/env node
/**
 * Test order notification email — run: node scripts/test-order-email.js
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const envPath = path.join(ROOT, ".env");

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
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

const notify = require("../lib/notify");

async function main() {
  console.log("Notify to:", process.env.ORDER_NOTIFY_EMAIL);
  console.log("SMTP configured:", notify.smtpConfigured());

  const status = await notify.checkEmailReady();
  console.log("Email ready check:", JSON.stringify(status, null, 2));

  if (!status.ready) {
    console.error("\nFAIL:", status.error);
    process.exit(1);
  }

  const testOrder = {
    orderId: `email-test-${Date.now()}`,
    submittedAt: new Date().toISOString(),
    orderType: "Custom Cake Order",
    status: "Pending Review",
    customerName: "Email Test",
    customerEmail: "test@example.com",
    customerPhone: "555-0100",
    eventDate: "2026-06-15",
    product: "Custom Cakes",
    lineItemsDetail: "1× Custom Cakes | Test",
    estimatedSubtotal: 65,
    decorationNotes: "Test notification from scripts/test-order-email.js",
  };

  console.log("\nSending test email...");
  const result = await notify.sendNewOrderEmail(testOrder, [], []);
  console.log("Result:", result);
  console.log("\nOK — check inbox:", process.env.ORDER_NOTIFY_EMAIL);
}

main().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});