#!/usr/bin/env node
/**
 * One-time setup: sign in with your Gmail so photos upload to YOUR Drive folder.
 * Run from project root:  node scripts/google-drive-auth.js
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");
const CLIENT_PATH = path.join(ROOT, "credentials", "oauth-client.json");
const TOKEN_PATH = path.join(ROOT, "credentials", "google-drive-token.json");
const PORT = 3333;
const REDIRECT = `http://127.0.0.1:${PORT}/oauth2callback`;
const SCOPE = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
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

function loadClient() {
  if (fs.existsSync(CLIENT_PATH)) {
    const j = JSON.parse(fs.readFileSync(CLIENT_PATH, "utf8"));
    const c = j.installed || j.web;
    if (c?.client_id && c?.client_secret) {
      return { id: c.client_id, secret: c.client_secret };
    }
  }
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (id && secret) return { id, secret };
  return null;
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
              reject(new Error(json.error_description || json.error || data));
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

function openBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

async function main() {
  loadEnv();
  const client = loadClient();
  if (!client) {
    console.error(`
Missing OAuth client credentials.

1. Google Cloud Console → APIs & Services → Credentials
2. Create OAuth client ID → Application type: Desktop app
3. Download JSON → save as:
   ${CLIENT_PATH}

Or add to .env:
   GOOGLE_OAUTH_CLIENT_ID=...
   GOOGLE_OAUTH_CLIENT_SECRET=...
`);
    process.exit(1);
  }

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: client.id,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
    }).toString();

  console.log("\nSweet Tooth — connect Gmail (Drive photos + order emails)\n");
  console.log("Scopes: Drive upload, Gmail send, profile email");
  console.log("Opening browser to sign in (use the same Gmail as your Drive folder)...\n");
  console.log(
    "If you connected before, revoke 'Sweet Tooth' at https://myaccount.google.com/permissions first so new permissions apply.\n",
  );

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT);
      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const err = url.searchParams.get("error");
      if (err) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>Authorization failed</h1><p>${err}</p>`);
        reject(new Error(err));
        server.close();
        return;
      }
      const c = url.searchParams.get("code");
      if (!c) {
        res.writeHead(400);
        res.end("Missing code");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<h1>Success!</h1><p>You can close this tab and return to Terminal.</p>",
      );
      resolve(c);
      server.close();
    });

    server.listen(PORT, "127.0.0.1", () => {
      openBrowser(authUrl);
      console.log("If the browser did not open, paste this URL:\n");
      console.log(authUrl + "\n");
    });

    server.on("error", reject);
  });

  const tokens = await httpsForm("oauth2.googleapis.com", "/token", {
    code,
    client_id: client.id,
    client_secret: client.secret,
    redirect_uri: REDIRECT,
    grant_type: "authorization_code",
  });

  if (!tokens.refresh_token) {
    console.warn(
      "Warning: no refresh_token returned. Revoke app access at https://myaccount.google.com/permissions and run this script again.",
    );
  }

  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(
    TOKEN_PATH,
    JSON.stringify(
      {
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token,
        obtained_at: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );

  console.log("Saved:", TOKEN_PATH);
  console.log("\nTesting Gmail send permission...");
  try {
    const notify = require("../lib/notify");
    const status = await notify.checkEmailReady();
    if (status.ready) {
      console.log("Email notifications: OK (" + status.method + ", from " + status.from + ")");
    } else {
      console.warn("Email notifications:", status.error);
    }
  } catch (e) {
    console.warn("Email check:", e.message);
  }
  console.log("\nDone! Restart the server:  node serve.js\n");
}

main().catch((e) => {
  console.error("Failed:", e.message);
  process.exit(1);
});