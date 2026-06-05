#!/usr/bin/env node
/**
 * Test Drive photo upload — run: node scripts/test-drive-upload.js
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

const google = require("../lib/google");

async function main() {
  if (!google.isDriveOAuthReady()) {
    console.error(
      "Drive OAuth not ready. Set GOOGLE_DRIVE_FOLDER_ID in .env and run:\n  node scripts/google-drive-auth.js",
    );
    process.exit(1);
  }

  const tinyPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  const orderId = `test-${Date.now()}`;
  console.log("Uploading test image to Drive for order", orderId, "...");

  const result = await google.uploadPhotosToDriveFromBuffers(orderId, [
    {
      buf: tinyPng,
      mime: "image/png",
      ext: "png",
      index: 0,
    },
  ]);

  console.log("Photo 1:", result.links[0] || "(empty)");
  if (result.errors.length) {
    console.error("Errors:", result.errors);
    process.exit(1);
  }
  console.log("Drive link:", result.links[0]);
  if (!result.links[0]?.startsWith("https://drive.google.com/")) {
    console.error("Expected a Drive link, got:", result.links[0]);
    process.exit(1);
  }
  console.log(
    "OK — Drive file name pattern:",
    google.drivePhotoFileName(orderId, 1, "png"),
  );
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});