/**
 * Sweet Tooth Cravings — Google Sheet: one-click "Send Deposit Invoice"
 *
 * After you review a row in the Order Log, select it and run:
 *   Sweet Tooth → Send Deposit Invoice
 *
 * That calls your Render API, creates a Stripe Checkout session for 50% deposit
 * (Sweet Tooth Stripe account via STRIPE_SECRET_KEY on the server), emails the
 * customer the pay link, and updates Status on the row.
 *
 * SETUP (one time) — see GOOGLE-SHEETS-SETUP.md section "Send Deposit Invoice"
 * 1. Extensions → Apps Script → paste this file
 * 2. Run menu: Sweet Tooth → Configure API connection…
 * 3. Authorize when prompted
 *
 * Does NOT change website → Sheets/Drive submission. Read-only use of order rows.
 */

var HEADER_MAP = {
  orderId: ["Order ID", "Order Id", "order id"],
  status: ["Status"],
  customerName: ["Customer Name", "Name"],
  email: ["Email", "Customer Email"],
  phone: ["Phone", "Customer Phone"],
  eventDate: ["Event Date"],
  product: ["Product / Cake", "Product"],
  size: ["Size / Tier", "Size"],
  flavor: ["Flavor"],
  filling: ["Filling"],
  notes: ["Decoration & Custom Notes", "Decoration Notes", "Notes"],
  allergies: ["Allergies"],
  additionalNotes: ["Additional Notes"],
  lineItems: ["Line Items (full detail)", "Line Items"],
  estimatedSubtotal: ["Estimated Subtotal", "Subtotal", "Final Total", "Final Price"],
  depositDue: ["Deposit Due (50%)", "Deposit Due", "Deposit"],
  orderType: ["Order Type"],
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Sweet Tooth")
    .addItem("Send Deposit Invoice (selected row)", "sendDepositInvoiceForActiveRow")
    .addItem("Configure API connection…", "configureApiConnection")
    .addSeparator()
    .addItem("Show setup help", "showSetupHelp")
    .addToUi();
}

function configureApiConnection() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();

  var currentBase =
    props.getProperty("API_BASE_URL") ||
    "https://sweettooth-cravings.onrender.com";
  var baseRes = ui.prompt(
    "API base URL",
    "Render order API (no trailing slash):\nCurrent: " + currentBase,
    ui.ButtonSet.OK_CANCEL
  );
  if (baseRes.getSelectedButton() !== ui.Button.OK) return;
  var base = String(baseRes.getResponseText() || currentBase)
    .trim()
    .replace(/\/$/, "");
  if (!base) {
    ui.alert("API base URL is required.");
    return;
  }

  var secretRes = ui.prompt(
    "Sheet actions secret",
    "Same value as SHEET_ACTIONS_SECRET on Render (or ADMIN_PASSWORD if you did not set SHEET_ACTIONS_SECRET).\nLeave blank to keep the existing secret.",
    ui.ButtonSet.OK_CANCEL
  );
  if (secretRes.getSelectedButton() !== ui.Button.OK) return;
  var secret = String(secretRes.getResponseText() || "").trim();

  props.setProperty("API_BASE_URL", base);
  if (secret) props.setProperty("SHEET_ACTIONS_SECRET", secret);

  if (!props.getProperty("SHEET_ACTIONS_SECRET")) {
    ui.alert(
      "Saved API URL, but no secret is stored yet.\nRun Configure again and enter SHEET_ACTIONS_SECRET or ADMIN_PASSWORD."
    );
    return;
  }

  ui.alert(
    "Saved.\n\nAPI: " +
      base +
      "\n\nSelect an order row → Sweet Tooth → Send Deposit Invoice."
  );
}

function showSetupHelp() {
  SpreadsheetApp.getUi().alert(
    "Send Deposit Invoice\n\n" +
      "1) Review the order row (edit Estimated Subtotal if the final price changed).\n" +
      "2) Click any cell in that row.\n" +
      "3) Menu: Sweet Tooth → Send Deposit Invoice.\n\n" +
      "Creates a Stripe 50% deposit Checkout link and emails the customer.\n" +
      "Website → Sheets + Drive submit is unchanged.\n\n" +
      "Full guide: GOOGLE-SHEETS-SETUP.md in the website project."
  );
}

function sendDepositInvoiceForActiveRow() {
  var sheet = SpreadsheetApp.getActiveSheet();
  var row = sheet.getActiveCell().getRow();
  if (row < 2) {
    SpreadsheetApp.getUi().alert("Select a data row (not the header).");
    return;
  }
  sendDepositInvoiceForRow_(sheet, row, true);
}

/**
 * Optional: put a checkbox in a free column (e.g. AA). When checked, sends invoice.
 * Install: Edit → Current project's triggers → onEditDepositCheckbox → On edit
 * Or rely on simple trigger name onEdit (may be limited).
 */
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    var row = e.range.getRow();
    var col = e.range.getColumn();
    if (row < 2) return;

    var headers = getHeaderRow_(sheet);
    var sendCol = findHeaderIndex_(headers, [
      "Send Deposit Invoice",
      "Send Deposit",
      "Send Invoice",
    ]);
    if (sendCol < 0) return;
    if (col !== sendCol + 1) return;

    var val = e.range.getValue();
    var checked = val === true || val === "TRUE" || val === "Yes" || val === "yes";
    if (!checked) return;

    sendDepositInvoiceForRow_(sheet, row, false);
    // Clear checkbox after attempt so it is one-click again next time
    e.range.setValue(false);
  } catch (err) {
    // Avoid noisy failures on unrelated edits
    console.error(err);
  }
}

function sendDepositInvoiceForRow_(sheet, row, showAlerts) {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var base = (props.getProperty("API_BASE_URL") || "").replace(/\/$/, "");
  var secret = props.getProperty("SHEET_ACTIONS_SECRET") || "";

  if (!base || !secret) {
    if (showAlerts) {
      ui.alert(
        "API not configured.\n\nSweet Tooth → Configure API connection…\n\nUse your Render URL and SHEET_ACTIONS_SECRET (or ADMIN_PASSWORD)."
      );
    }
    return { ok: false, error: "not_configured" };
  }

  var headers = getHeaderRow_(sheet);
  var record = readRowAsObject_(sheet, row, headers);

  if (!record.email) {
    if (showAlerts) ui.alert("This row has no Email. Add the customer email first.");
    return { ok: false, error: "no_email" };
  }

  var subtotal = parseMoney_(record.estimatedSubtotal);
  var deposit = parseMoney_(record.depositDue);
  if ((!deposit || deposit <= 0) && subtotal > 0) deposit = Math.round(subtotal * 50) / 100;
  if ((!subtotal || subtotal <= 0) && deposit > 0) subtotal = Math.round(deposit * 2 * 100) / 100;

  if (!deposit || deposit < 0.5) {
    if (showAlerts) {
      ui.alert(
        "Need at least $0.50 deposit.\n\nSet Estimated Subtotal (final reviewed total) on this row, then try again.\nDeposit is 50% of that amount."
      );
    }
    return { ok: false, error: "no_amount" };
  }

  var lineBits = [];
  if (record.lineItems) lineBits.push(record.lineItems);
  else {
    if (record.product) lineBits.push(record.product);
    if (record.size) lineBits.push(record.size);
    if (record.flavor) lineBits.push("Flavor: " + record.flavor);
    if (record.filling) lineBits.push("Filling: " + record.filling);
    if (record.notes) lineBits.push(record.notes);
  }

  var payload = {
    orderId: record.orderId || "",
    customerName: record.customerName || "",
    customerEmail: record.email,
    customerPhone: record.phone || "",
    eventDate: record.eventDate || "",
    orderType: record.orderType || "",
    product: record.product || "",
    lineItemsDetail: lineBits.join("\n"),
    estimatedSubtotal: subtotal || "",
    depositAmount: deposit,
    finalTotal: subtotal || "",
  };

  if (showAlerts) {
    var confirm = ui.alert(
      "Send 50% deposit invoice?",
      "Customer: " +
        (record.customerName || "(no name)") +
        "\nEmail: " +
        record.email +
        "\nDeposit: $" +
        deposit.toFixed(2) +
        (subtotal ? " (50% of $" + subtotal.toFixed(2) + ")" : "") +
        "\nOrder ID: " +
        (record.orderId || "(none)") +
        "\n\nStripe Checkout will be created and emailed to the customer.",
      ui.ButtonSet.YES_NO
    );
    if (confirm !== ui.Button.YES) return { ok: false, error: "cancelled" };
  }

  var url = base + "/api/sheet/send-deposit-invoice";
  var response;
  try {
    response = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      headers: {
        Authorization: "Bearer " + secret,
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
  } catch (err) {
    if (showAlerts) {
      ui.alert(
        "Could not reach the API.\n\n" +
          err.message +
          "\n\nCheck API_BASE_URL and that Render is awake."
      );
    }
    return { ok: false, error: String(err.message || err) };
  }

  var code = response.getResponseCode();
  var text = response.getContentText();
  var data = {};
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = { error: text };
  }

  if (code < 200 || code >= 300 || !data.success) {
    var msg = (data && data.error) || text || "Request failed (" + code + ")";
    if (showAlerts) ui.alert("Send failed\n\n" + msg);
    // Status note on failure (optional)
    setStatusIfPossible_(sheet, row, headers, "Deposit send failed");
    return { ok: false, error: msg };
  }

  setStatusIfPossible_(sheet, row, headers, data.sheetStatus || "Deposit invoice sent");

  // Optional: write deposit amount if empty
  var depCol = findHeaderIndex_(headers, HEADER_MAP.depositDue);
  if (depCol >= 0 && data.depositDollars != null) {
    var cell = sheet.getRange(row, depCol + 1);
    if (!String(cell.getValue() || "").trim()) {
      cell.setValue(Number(data.depositDollars));
    }
  }

  if (showAlerts) {
    var emailNote = data.email && data.email.sent
      ? "Emailed to " + record.email
      : "Checkout created, but email may have failed — copy the link:\n" +
        (data.checkoutUrl || "");
    ui.alert(
      "Deposit invoice sent\n\n" +
        "Amount: $" +
        Number(data.depositDollars).toFixed(2) +
        "\n" +
        emailNote +
        "\n\nStripe:\n" +
        (data.checkoutUrl || "")
    );
  }

  return { ok: true, data: data };
}

function getHeaderRow_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 26);
  var values = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  return values.map(function (h) {
    return String(h || "").trim();
  });
}

function findHeaderIndex_(headers, names) {
  var list = names instanceof Array ? names : [names];
  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i] || "")
      .trim()
      .toLowerCase();
    for (var j = 0; j < list.length; j++) {
      if (h === String(list[j]).trim().toLowerCase()) return i;
    }
  }
  return -1;
}

function readRowAsObject_(sheet, row, headers) {
  var lastCol = Math.max(headers.length, sheet.getLastColumn());
  var values = sheet.getRange(row, 1, 1, lastCol).getValues()[0];
  function col(key) {
    var idx = findHeaderIndex_(headers, HEADER_MAP[key] || []);
    if (idx < 0) return "";
    var v = values[idx];
    return v == null ? "" : v;
  }
  return {
    orderId: String(col("orderId") || "").trim(),
    status: col("status"),
    customerName: String(col("customerName") || "").trim(),
    email: String(col("email") || "").trim(),
    phone: String(col("phone") || "").trim(),
    eventDate: col("eventDate"),
    product: String(col("product") || "").trim(),
    size: String(col("size") || "").trim(),
    flavor: String(col("flavor") || "").trim(),
    filling: String(col("filling") || "").trim(),
    notes: String(col("notes") || "").trim(),
    allergies: String(col("allergies") || "").trim(),
    additionalNotes: String(col("additionalNotes") || "").trim(),
    lineItems: String(col("lineItems") || "").trim(),
    estimatedSubtotal: col("estimatedSubtotal"),
    depositDue: col("depositDue"),
    orderType: String(col("orderType") || "").trim(),
  };
}

function parseMoney_(raw) {
  if (raw == null || raw === "") return NaN;
  if (typeof raw === "number" && isFinite(raw)) return raw;
  var s = String(raw).replace(/[^0-9.,-]/g, "");
  if (!s) return NaN;
  if (s.indexOf(",") >= 0 && s.indexOf(".") >= 0) s = s.replace(/,/g, "");
  else if (s.indexOf(",") >= 0) s = s.replace(",", ".");
  var n = Number(s);
  return isFinite(n) ? n : NaN;
}

function setStatusIfPossible_(sheet, row, headers, statusText) {
  var idx = findHeaderIndex_(headers, HEADER_MAP.status);
  if (idx < 0) return;
  sheet.getRange(row, idx + 1).setValue(statusText);
}
