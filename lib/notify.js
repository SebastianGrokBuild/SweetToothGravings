/**
 * Order notification emails — Gmail API (OAuth) with optional SMTP fallback.
 */
const tls = require("tls");
const { getUserAccessToken, httpsRequest } = require("./google");

const DEFAULT_NOTIFY_TO = "sweettoothcravingsorder@gmail.com";

function notifyEnabled() {
  if (process.env.ORDER_NOTIFY_ENABLED === "false") return false;
  return !!(process.env.ORDER_NOTIFY_EMAIL || DEFAULT_NOTIFY_TO);
}

function notifyTo() {
  return (process.env.ORDER_NOTIFY_EMAIL || DEFAULT_NOTIFY_TO).trim();
}

function smtpConfigured() {
  return !!(
    process.env.ORDER_SMTP_USER?.trim() && process.env.ORDER_SMTP_PASS?.trim()
  );
}

function base64UrlEncode(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function formatMoney(n) {
  if (n == null || Number.isNaN(n)) return "";
  return `$${Number(n).toFixed(2)}`;
}

function buildOrderEmailText(record, photoLinks) {
  const lines = [
    "New order request — Sweet Tooth Cravings",
    "",
    `Order ID: ${record.orderId}`,
    `Order type: ${record.orderType || "Order"}`,
    `Submitted: ${record.submittedAt || new Date().toISOString()}`,
    `Status: ${record.status || "Pending Review"}`,
    "",
    "— Customer —",
    `Name: ${record.customerName || ""}`,
    `Email: ${record.customerEmail || ""}`,
    `Phone: ${record.customerPhone || "(not provided)"}`,
    `Event date: ${record.eventDate || "(not provided)"}`,
    "",
  ];

  if (record.product) lines.push(`Product / cake: ${record.product}`);
  if (record.size) lines.push(`Size / tier: ${record.size}`);
  if (record.flavor) lines.push(`Flavor: ${record.flavor}`);
  if (record.filling) lines.push(`Filling: ${record.filling}`);
  if (record.decorationNotes) {
    lines.push("", "Decoration & notes:", record.decorationNotes);
  }
  if (record.allergies) lines.push("", `Allergies: ${record.allergies}`);
  if (record.additionalNotes) lines.push(`Additional notes: ${record.additionalNotes}`);

  if (record.lineItemsDetail) {
    lines.push("", "— Line items —", record.lineItemsDetail);
  }

  const subtotal = formatMoney(record.estimatedSubtotal);
  if (subtotal) {
    lines.push("", `Estimated subtotal: ${subtotal}`);
    if (Number(record.estimatedSubtotal) > 0) {
      lines.push(`Deposit due (50%): ${formatMoney(Number(record.estimatedSubtotal) * 0.5)}`);
    }
  }

  const photos = (photoLinks || []).filter(
    (p) => p && String(p).startsWith("https://drive.google.com/"),
  );
  if (photos.length) {
    lines.push("", "— Inspiration photos (Google Drive) —");
    photos.forEach((url, i) => lines.push(`Photo ${i + 1}: ${url}`));
    lines.push("", `Search Drive for files starting with: ${record.orderId}`);
  }

  if (record.photoErrors?.length) {
    lines.push("", "— Photo upload notes —", ...record.photoErrors);
  }

  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (sheetId) {
    lines.push(
      "",
      `Spreadsheet: https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
    );
  }

  return lines.join("\n");
}

function isCustomOrder(record) {
  const type = String(record.orderType || "");
  if (/custom/i.test(type)) return true;
  if (/custom cake/i.test(String(record.product || ""))) return true;
  if (/custom cake/i.test(String(record.lineItemsDetail || ""))) return true;
  return false;
}

/** RFC 5322 message — omit From so Gmail API uses the signed-in account. */
function buildMimeMessage({ to, subject, body, from }) {
  const headers = [`To: ${to}`, `Subject: ${subject}`, "MIME-Version: 1.0"];
  if (from && from.includes("@")) {
    headers.splice(1, 0, `From: ${from}`);
  }
  headers.push(
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    body,
  );
  return headers.join("\r\n");
}

async function getGmailProfile(accessToken) {
  return httpsRequest({
    hostname: "gmail.googleapis.com",
    path: "/gmail/v1/users/me/profile",
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

async function sendViaGmailApi(accessToken, { to, subject, text, from }) {
  const mime = buildMimeMessage({ to, subject, body: text, from });
  const raw = base64UrlEncode(Buffer.from(mime, "utf8"));
  const payload = JSON.stringify({ raw });

  return httpsRequest(
    {
      hostname: "gmail.googleapis.com",
      path: "/gmail/v1/users/me/messages/send",
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    },
    payload,
  );
}

function smtpCommand(socket, cmd) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes("\r\n")) {
        socket.removeListener("data", onData);
        socket.removeListener("error", reject);
        const code = parseInt(buf.slice(0, 3), 10);
        if (code >= 400) {
          reject(new Error(`SMTP error: ${buf.trim()}`));
        } else {
          resolve(buf);
        }
      }
    };
    socket.on("data", onData);
    socket.on("error", reject);
    if (cmd) socket.write(cmd);
  });
}

/** Gmail App Password SMTP (port 465) — use ORDER_SMTP_USER + ORDER_SMTP_PASS in .env */
function sendViaSmtp({ from, to, subject, text }) {
  const user = process.env.ORDER_SMTP_USER.trim();
  const pass = process.env.ORDER_SMTP_PASS.trim();
  const host = process.env.ORDER_SMTP_HOST?.trim() || "smtp.gmail.com";
  const port = Number(process.env.ORDER_SMTP_PORT) || 465;

  const message = [
    `From: ${from || user}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    text,
  ].join("\r\n");

  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host, port, servername: host, rejectUnauthorized: true },
      async () => {
        try {
          await smtpCommand(socket, null);
          await smtpCommand(socket, `EHLO sweettooth\r\n`);
          await smtpCommand(socket, "AUTH LOGIN\r\n");
          await smtpCommand(
            socket,
            `${Buffer.from(user).toString("base64")}\r\n`,
          );
          await smtpCommand(
            socket,
            `${Buffer.from(pass).toString("base64")}\r\n`,
          );
          await smtpCommand(socket, `MAIL FROM:<${user}>\r\n`);
          await smtpCommand(socket, `RCPT TO:<${to}>\r\n`);
          await smtpCommand(socket, "DATA\r\n");
          await smtpCommand(socket, `${message}\r\n.\r\n`);
          await smtpCommand(socket, "QUIT\r\n");
          socket.end();
          resolve({ method: "smtp", from: user });
        } catch (e) {
          socket.destroy();
          reject(e);
        }
      },
    );
    socket.on("error", reject);
  });
}

/**
 * Check whether order emails can be sent (for /api/health).
 */
async function checkEmailReady() {
  const to = notifyTo();
  if (!notifyEnabled()) {
    return { ready: false, to, error: "ORDER_NOTIFY_ENABLED is false" };
  }

  if (smtpConfigured()) {
    return {
      ready: true,
      to,
      method: "smtp",
      from: process.env.ORDER_SMTP_USER.trim(),
    };
  }

  const accessToken = await getUserAccessToken();
  if (!accessToken) {
    return {
      ready: false,
      to,
      error: "Gmail not connected — run: node scripts/google-drive-auth.js",
    };
  }

  try {
    const profile = await getGmailProfile(accessToken);
    return {
      ready: true,
      to,
      method: "gmail_api",
      from: profile.emailAddress,
    };
  } catch (e) {
    const msg = e.message || String(e);
    const needsReauth =
      /insufficient|scope|403|401|forbidden/i.test(msg) ||
      /Gmail API/i.test(msg);
    return {
      ready: false,
      to,
      from: process.env.ORDER_NOTIFY_FROM || null,
      error: needsReauth
        ? `${msg} — Enable Gmail API in Cloud Console, then run: node scripts/google-drive-auth.js`
        : msg,
    };
  }
}

/**
 * Send notification email for a new order.
 */
async function sendNewOrderEmail(record, photoLinks = [], photoErrors = []) {
  if (!notifyEnabled()) return { skipped: true, reason: "disabled" };

  const to = notifyTo();
  const subject = isCustomOrder(record)
    ? `New Custom Order — ${record.orderId}`
    : `New Order Request — ${record.orderId}`;
  const text = buildOrderEmailText({ ...record, photoErrors }, photoLinks);

  if (smtpConfigured()) {
    const from = process.env.ORDER_NOTIFY_FROM?.trim() || process.env.ORDER_SMTP_USER.trim();
    await sendViaSmtp({ from, to, subject, text });
    console.log("[notify] Order email sent via SMTP to", to, "for", record.orderId);
    return { ok: true, to, method: "smtp" };
  }

  const accessToken = await getUserAccessToken();
  if (!accessToken) {
    throw new Error(
      "Gmail not connected — run: node scripts/google-drive-auth.js (or set ORDER_SMTP_USER + ORDER_SMTP_PASS for App Password SMTP)",
    );
  }

  let from = process.env.ORDER_NOTIFY_FROM?.trim() || "";
  if (!from) {
    try {
      const profile = await getGmailProfile(accessToken);
      from = profile.emailAddress || "";
    } catch (e) {
      const hint =
        /insufficient|scope|403|forbidden/i.test(e.message || "")
          ? " Missing gmail.send scope — revoke app at https://myaccount.google.com/permissions and re-run: node scripts/google-drive-auth.js"
          : "";
      throw new Error(`Gmail profile check failed: ${e.message}.${hint}`);
    }
  }

  try {
    await sendViaGmailApi(accessToken, { to, subject, text, from });
    console.log("[notify] Order email sent via Gmail API to", to, "from", from, "for", record.orderId);
    return { ok: true, to, method: "gmail_api", from };
  } catch (e) {
    const hint =
      /insufficient|scope|403|forbidden/i.test(e.message || "")
        ? " Re-run: node scripts/google-drive-auth.js after enabling Gmail API. Or set ORDER_SMTP_USER + ORDER_SMTP_PASS in .env."
        : "";
    throw new Error(`${e.message}.${hint}`);
  }
}

module.exports = {
  sendNewOrderEmail,
  checkEmailReady,
  isCustomOrder,
  notifyEnabled,
  smtpConfigured,
};