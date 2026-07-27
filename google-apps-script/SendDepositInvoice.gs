/**
 * Sweet Tooth Cravings — Send Deposit Invoice (Stripe Deposit column)
 *
 * IMPORTANT: Checkbox clicks need an *installable* onEdit trigger so UrlFetch
 * (Stripe via your Render API) is allowed. Simple onEdit cannot call external APIs.
 *
 * After reviewing a row (newest orders are at row 2):
 *   1. Confirm Estimated Subtotal / Deposit Due
 *   2. Check the box in **Stripe Deposit**
 *      → Creates Stripe 50% Checkout (acct_1TcrMNHTYIZb4z2l) and emails the customer
 *
 * SETUP (one time — do all steps)
 * 1. Extensions → Apps Script → delete any old code → paste THIS entire file → Save
 * 2. Run menu once from the editor: installStripeDepositColumn (or reload sheet)
 * 3. Reload the spreadsheet → Sweet Tooth menu
 * 4. Sweet Tooth → Install Stripe Deposit button + trigger
 * 5. When Google asks, Authorize the script (required for UrlFetch + Sheets)
 * 6. API defaults to https://sweettooth-cravings-api.onrender.com
 *    Secret defaults to Render ADMIN_PASSWORD (sweettooth-admin)
 *
 * Render must have STRIPE_SECRET_KEY for account acct_1TcrMNHTYIZb4z2l (already set).
 */

var DEFAULT_API_BASE = "https://sweettooth-cravings-api.onrender.com";
var DEFAULT_SHEET_SECRET = "sweettooth-admin";
var STRIPE_DEPOSIT_HEADER = "Stripe Deposit";
var EXPECTED_STRIPE_ACCOUNT = "acct_1TcrMNHTYIZb4z2l";
var INSTALLABLE_HANDLER = "onStripeDepositEdit";

var HEADER_MAP = {
  orderId: ["Order", "Order ID", "Order Id", "order id"],
  status: ["Status"],
  customerName: ["Customer Name", "Name"],
  email: ["Email", "Customer Email"],
  phone: ["Phone", "Customer Phone"],
  eventDate: ["Event Date"],
  product: ["Product / Cake", "Product"],
  size: ["Size / Tier", "Size"],
  flavor: ["Flavor"],
  filling: ["Filling"],
  notes: ["Decoration & Custom Notes", "Decoration Notes", "Notes", "Line Items"],
  allergies: ["Allergies"],
  additionalNotes: ["Additional Notes"],
  lineItems: ["Line Items", "Line Items (full detail)"],
  estimatedSubtotal: ["Estimated Subtotal", "Subtotal", "Final Total", "Final Price"],
  depositDue: ["Deposit Due", "Deposit Due (50%)", "Deposit"],
  orderType: ["Order Type"],
  sendDeposit: [
    "Stripe Deposit",
    "Send Deposit Invoice",
    "Send Deposit",
    "Send Invoice",
  ],
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Sweet Tooth")
    .addItem("Send Deposit Invoice (selected row)", "sendDepositInvoiceForActiveRow")
    .addItem("Install Stripe Deposit button + trigger", "installStripeDepositColumn")
    .addItem("Configure API connection…", "configureApiConnection")
    .addSeparator()
    .addItem("Show setup help", "showSetupHelp")
    .addToUi();

  try {
    ensureDefaultProps_();
  } catch (e) {
    /* ignore */
  }
}

function ensureDefaultProps_() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty("API_BASE_URL")) {
    props.setProperty("API_BASE_URL", DEFAULT_API_BASE);
  }
  if (!props.getProperty("SHEET_ACTIONS_SECRET")) {
    props.setProperty("SHEET_ACTIONS_SECRET", DEFAULT_SHEET_SECRET);
  }
}

function configureApiConnection() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();

  var currentBase = props.getProperty("API_BASE_URL") || DEFAULT_API_BASE;
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
  if (
    base === "https://sweettooth-cravings.onrender.com" ||
    base === "http://sweettooth-cravings.onrender.com"
  ) {
    base = DEFAULT_API_BASE;
  }

  var secretRes = ui.prompt(
    "Sheet actions secret",
    "Same as ADMIN_PASSWORD or SHEET_ACTIONS_SECRET on Render.\nLeave blank to keep existing (default: sweettooth-admin).",
    ui.ButtonSet.OK_CANCEL
  );
  if (secretRes.getSelectedButton() !== ui.Button.OK) return;
  var secret = String(secretRes.getResponseText() || "").trim();

  props.setProperty("API_BASE_URL", base);
  if (secret) props.setProperty("SHEET_ACTIONS_SECRET", secret);
  if (!props.getProperty("SHEET_ACTIONS_SECRET")) {
    props.setProperty("SHEET_ACTIONS_SECRET", DEFAULT_SHEET_SECRET);
  }

  ensureInstallableOnEditTrigger_();

  ui.alert(
    "Saved.\n\nAPI: " +
      base +
      "\n\nInstallable edit trigger is active.\nCheck a Stripe Deposit box after reviewing an order."
  );
}

function showSetupHelp() {
  SpreadsheetApp.getUi().alert(
    "Send Deposit Invoice\n\n" +
      "1) Run: Sweet Tooth → Install Stripe Deposit button + trigger\n" +
      "2) Authorize when Google asks\n" +
      "3) Review Estimated Subtotal on a row\n" +
      "4) Check the Stripe Deposit box\n\n" +
      "Creates a 50% Stripe Checkout on " +
      EXPECTED_STRIPE_ACCOUNT +
      " and emails the customer.\n\n" +
      "API: " +
      DEFAULT_API_BASE
  );
}

/**
 * Creates/refreshes the Stripe Deposit checkbox column AND installs the
 * installable onEdit trigger required for UrlFetch (Stripe send).
 */
function installStripeDepositColumn() {
  var ui = SpreadsheetApp.getUi();
  ensureDefaultProps_();
  var sheet = SpreadsheetApp.getActiveSheet();

  var preferred = [
    "Order",
    "Submit Date",
    "Order Type",
    "Status",
    "Customer Name",
    "Email",
    "Phone",
    "Event Date",
    "Line Items",
    "Estimated Subtotal",
    "Deposit Due",
    "Photo 1",
    "Photo 2",
    "Photo 3",
    "Stripe Deposit",
  ];

  var headers = getHeaderRow_(sheet);
  var first = String(headers[0] || "")
    .trim()
    .toLowerCase();
  if (!first || first === "order id" || first.indexOf("order") !== 0) {
    sheet.getRange(1, 1, 1, preferred.length).setValues([preferred]);
    sheet
      .getRange(1, 1, 1, preferred.length)
      .setFontWeight("bold")
      .setBackground("#C9A9E8");
  }

  headers = getHeaderRow_(sheet);
  var existing = findHeaderIndex_(headers, HEADER_MAP.sendDeposit);
  var photo3 = findHeaderIndex_(headers, ["Photo 3"]);
  var col;

  if (existing >= 0) {
    col = existing + 1;
  } else if (photo3 >= 0) {
    col = photo3 + 2;
    sheet.insertColumnAfter(photo3 + 1);
  } else {
    col = Math.max(headers.filter(Boolean).length, preferred.length - 1) + 1;
    if (col > 1) sheet.insertColumnAfter(col - 1);
  }

  sheet.getRange(1, col).setValue(STRIPE_DEPOSIT_HEADER);
  sheet
    .getRange(1, col)
    .setFontWeight("bold")
    .setBackground("#7B4DB8")
    .setFontColor("#ffffff");
  sheet.setColumnWidth(col, 140);
  sheet
    .getRange(1, col)
    .setNote(
      "Check this box after reviewing the order to email a 50% Stripe deposit invoice."
    );

  var lastRow = Math.max(sheet.getLastRow(), 50);
  if (lastRow >= 2) {
    var range = sheet.getRange(2, col, lastRow - 1, 1);
    // Only put checkboxes on empty / boolean cells — keep "✓ Sent"
    var values = range.getValues();
    for (var r = 0; r < values.length; r++) {
      var cell = sheet.getRange(r + 2, col);
      var v = values[r][0];
      var s = String(v == null ? "" : v).trim();
      if (s.indexOf("✓") === 0 || s.indexOf("Sent") === 0 || s === "Sending…") {
        continue;
      }
      cell.insertCheckboxes();
      cell.setValue(false);
    }
  }

  // CRITICAL: installable trigger so checkbox can call UrlFetchApp
  ensureInstallableOnEditTrigger_();

  ui.alert(
    "Stripe Deposit button is ready (column " +
      columnLetter_(col) +
      ").\n\n" +
      "How to use:\n" +
      "1. Review Estimated Subtotal on the row\n" +
      "2. Check the Stripe Deposit box\n" +
      "3. Customer is emailed the 50% Stripe payment link\n\n" +
      "If Google asked for authorization, allow it so the button can call your API."
  );
}

/**
 * Installable trigger — required for UrlFetchApp from an edit handler.
 * Simple onEdit() cannot call external HTTP services.
 */
function ensureInstallableOnEditTrigger_() {
  var triggers = ScriptApp.getProjectTriggers();
  var found = false;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === INSTALLABLE_HANDLER) {
      found = true;
      break;
    }
  }
  if (!found) {
    ScriptApp.newTrigger(INSTALLABLE_HANDLER)
      .forSpreadsheet(SpreadsheetApp.getActive())
      .onEdit()
      .create();
  }
}

function columnLetter_(col) {
  var s = "";
  var n = col;
  while (n > 0) {
    var m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sendDepositInvoiceForActiveRow() {
  var sheet = SpreadsheetApp.getActiveSheet();
  var row = sheet.getActiveCell().getRow();
  if (row < 2) {
    SpreadsheetApp.getUi().alert("Select a data row (not the header).");
    return;
  }
  var headers = getHeaderRow_(sheet);
  var sendCol = findHeaderIndex_(headers, HEADER_MAP.sendDeposit);
  var cell = sendCol >= 0 ? sheet.getRange(row, sendCol + 1) : null;
  if (cell) cell.setValue("Sending…");

  var result = sendDepositInvoiceForRow_(sheet, row, true);
  if (cell) {
    if (result && result.ok) {
      cell.setValue("✓ Sent");
      if (result.data && result.data.checkoutUrl) {
        cell.setNote(
          "Deposit invoice sent " +
            new Date().toLocaleString() +
            "\n" +
            result.data.checkoutUrl
        );
      }
    } else if (result && result.error !== "cancelled") {
      cell.insertCheckboxes();
      cell.setValue(false);
      cell.setNote("Failed: " + ((result && result.error) || "unknown"));
    } else {
      cell.insertCheckboxes();
      cell.setValue(false);
    }
  }
}

/**
 * Installable onEdit handler (created by installStripeDepositColumn).
 * Do NOT use simple onEdit for UrlFetch — Google blocks it.
 */
function onStripeDepositEdit(e) {
  handleStripeDepositEdit_(e);
}

/**
 * Kept only so accidental simple onEdit does not throw; installable handler does the work.
 */
function onEdit(e) {
  // Intentionally empty for UrlFetch — simple triggers cannot call external APIs.
  // The installable trigger onStripeDepositEdit handles checkbox clicks.
}

function handleStripeDepositEdit_(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    var row = e.range.getRow();
    var col = e.range.getColumn();
    if (row < 2) return;
    if (e.range.getNumRows() > 1 || e.range.getNumColumns() > 1) return;

    var headers = getHeaderRow_(sheet);
    var sendCol = findHeaderIndex_(headers, HEADER_MAP.sendDeposit);
    if (sendCol < 0) return;
    if (col !== sendCol + 1) return;

    var val = e.range.getValue();
    var checked =
      val === true ||
      val === "TRUE" ||
      val === "Yes" ||
      val === "yes" ||
      val === "SEND" ||
      val === "Send";
    if (!checked) return;

    e.range.setValue("Sending…");
    SpreadsheetApp.flush();

    var result = sendDepositInvoiceForRow_(sheet, row, false);
    if (result && result.ok) {
      e.range.setValue("✓ Sent");
      e.range.setNote(
        "Deposit invoice sent " +
          new Date().toLocaleString() +
          (result.data && result.data.checkoutUrl
            ? "\n" + result.data.checkoutUrl
            : "")
      );
      SpreadsheetApp.getActiveSpreadsheet().toast(
        "50% deposit invoice emailed.",
        "Stripe Deposit",
        8
      );
    } else {
      e.range.insertCheckboxes();
      e.range.setValue(false);
      var errMsg = (result && result.error) || "Send failed";
      e.range.setNote("Failed: " + errMsg);
      SpreadsheetApp.getActiveSpreadsheet().toast(
        String(errMsg).slice(0, 140),
        "Stripe Deposit failed",
        10
      );
    }
  } catch (err) {
    console.error(err);
    try {
      e.range.insertCheckboxes();
      e.range.setValue(false);
      e.range.setNote("Failed: " + (err.message || String(err)));
    } catch (e2) {
      /* ignore */
    }
  }
}

function sendDepositInvoiceForRow_(sheet, row, showAlerts) {
  var ui = SpreadsheetApp.getUi();
  ensureDefaultProps_();
  var props = PropertiesService.getScriptProperties();
  var base = (props.getProperty("API_BASE_URL") || DEFAULT_API_BASE).replace(
    /\/$/,
    ""
  );
  var secret =
    props.getProperty("SHEET_ACTIONS_SECRET") || DEFAULT_SHEET_SECRET || "";

  if (
    base === "https://sweettooth-cravings.onrender.com" ||
    base === "http://sweettooth-cravings.onrender.com"
  ) {
    base = DEFAULT_API_BASE;
    props.setProperty("API_BASE_URL", base);
  }

  if (!base || !secret) {
    if (showAlerts) {
      ui.alert(
        "API not configured.\n\nSweet Tooth → Configure API connection…"
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

  var statusStr = String(record.status || "").toLowerCase();
  if (statusStr.indexOf("deposit invoice sent") >= 0 && showAlerts) {
    var again = ui.alert(
      "Already sent",
      "Status is already “Deposit invoice sent”. Send another invoice?",
      ui.ButtonSet.YES_NO
    );
    if (again !== ui.Button.YES) return { ok: false, error: "cancelled" };
  }

  var subtotal = parseMoney_(record.estimatedSubtotal);
  var deposit = parseMoney_(record.depositDue);
  if ((!deposit || deposit <= 0) && subtotal > 0)
    deposit = Math.round(subtotal * 50) / 100;
  if ((!subtotal || subtotal <= 0) && deposit > 0)
    subtotal = Math.round(deposit * 2 * 100) / 100;

  if (!deposit || deposit < 0.5) {
    if (showAlerts) {
      ui.alert(
        "Need at least $0.50 deposit.\n\nSet Estimated Subtotal on this row, then try again."
      );
    }
    return { ok: false, error: "no_amount — set Estimated Subtotal first" };
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
        "\n\nStripe Checkout will be created and emailed.",
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
          "\n\nCheck Render is awake: " +
          DEFAULT_API_BASE
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
    setStatusIfPossible_(sheet, row, headers, "Deposit send failed");
    return { ok: false, error: msg };
  }

  setStatusIfPossible_(
    sheet,
    row,
    headers,
    data.sheetStatus || "Deposit invoice sent"
  );

  var depCol = findHeaderIndex_(headers, HEADER_MAP.depositDue);
  if (depCol >= 0 && data.depositDollars != null) {
    var cell = sheet.getRange(row, depCol + 1);
    if (!String(cell.getValue() || "").trim()) {
      cell.setValue(Number(data.depositDollars));
    }
  }

  if (showAlerts) {
    var emailNote =
      data.email && data.email.sent
        ? "Emailed to " + record.email
        : "Checkout created — if email failed, copy this link:\n" +
          (data.checkoutUrl || "");
    ui.alert(
      "Deposit invoice ready\n\n" +
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
