/**
 * Sweet Tooth Cravings — Send Deposit Invoice button column
 *
 * The last column is a purple dropdown “button” (not a checkbox):
 *   Open dropdown → choose “Send Deposit Invoice”
 *   → Stripe emails the customer a 50% deposit invoice (acct_1TcrMNHTYIZb4z2l)
 *
 * Uses an *installable* onEdit trigger (simple onEdit cannot call UrlFetch).
 *
 * SETUP (one time)
 * 1. Extensions → Apps Script → paste this entire file → Save
 * 2. Reload the spreadsheet
 * 3. Menu: Sweet Tooth → Install Send Deposit Invoice button + trigger
 * 4. Authorize when Google asks
 *
 * API: https://sweettooth-cravings-api.onrender.com
 * Secret: ADMIN_PASSWORD on Render (default sweettooth-admin)
 */

var DEFAULT_API_BASE = "https://sweettooth-cravings-api.onrender.com";
var DEFAULT_SHEET_SECRET = "sweettooth-admin";
var BUTTON_LABEL = "Send Deposit Invoice";
var SENT_LABEL = "✓ Sent";
var SENDING_LABEL = "Sending…";
var COLUMN_HEADER = "Send Deposit Invoice";
var EXPECTED_STRIPE_ACCOUNT = "acct_1TcrMNHTYIZb4z2l";
var INSTALLABLE_HANDLER = "onSendDepositButtonEdit";

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
    "Send Deposit Invoice",
    "Stripe Deposit",
    "Send Deposit",
    "Send Invoice",
  ],
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Sweet Tooth")
    .addItem("Send Deposit Invoice (selected row)", "sendDepositInvoiceForActiveRow")
    .addItem("Install Send Deposit Invoice button + trigger", "installSendDepositButton")
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

// Keep old menu name working if someone still has it bookmarked in mind
function installStripeDepositColumn() {
  installSendDepositButton();
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
    "ADMIN_PASSWORD or SHEET_ACTIONS_SECRET on Render.\nLeave blank to keep existing (default: sweettooth-admin).",
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
  ui.alert("Saved.\n\nAPI: " + base + "\n\nDropdown button is ready.");
}

function showSetupHelp() {
  SpreadsheetApp.getUi().alert(
    "Send Deposit Invoice button\n\n" +
      "1) Sweet Tooth → Install Send Deposit Invoice button + trigger\n" +
      "2) Authorize when asked\n" +
      "3) Review Estimated Subtotal on a row\n" +
      "4) In the last column, open the dropdown → choose “Send Deposit Invoice”\n\n" +
      "Stripe emails the customer a 50% deposit invoice (" +
      EXPECTED_STRIPE_ACCOUNT +
      ").\n\nAPI: " +
      DEFAULT_API_BASE
  );
}

/**
 * Install / refresh the purple Send Deposit Invoice dropdown column + trigger.
 * Replaces old checkboxes.
 */
function installSendDepositButton() {
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
    COLUMN_HEADER,
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

  // Header
  var headerCell = sheet.getRange(1, col);
  headerCell.setValue(COLUMN_HEADER);
  headerCell.setFontWeight("bold");
  headerCell.setBackground("#7B4DB8");
  headerCell.setFontColor("#ffffff");
  headerCell.setHorizontalAlignment("center");
  sheet.setColumnWidth(col, 170);
  headerCell.setNote(
    "Open the dropdown on a data row and choose “Send Deposit Invoice” after reviewing Estimated Subtotal."
  );

  var lastRow = Math.max(sheet.getLastRow(), 50);
  if (lastRow >= 2) {
    var range = sheet.getRange(2, col, lastRow - 1, 1);

    // Remove checkbox validation / boolean values
    range.clearDataValidations();
    var values = range.getValues();
    for (var r = 0; r < values.length; r++) {
      var cell = sheet.getRange(r + 2, col);
      var v = values[r][0];
      var s = String(v == null ? "" : v).trim();

      // Keep sent markers
      if (s.indexOf("✓") === 0 || /^sent/i.test(s) || s === SENDING_LABEL) {
        styleSentCell_(cell);
        continue;
      }

      // Convert old checkboxes / TRUE / FALSE to empty button cells
      if (v === true || v === false || s === "TRUE" || s === "FALSE" || s === "TRUE" || s === "") {
        cell.setValue("");
      } else if (s.toLowerCase() === "stripe deposit") {
        cell.setValue("");
      }

      styleButtonCell_(cell);
    }

    // Dropdown action list (the “button”)
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList([BUTTON_LABEL, SENT_LABEL], true)
      .setAllowInvalid(true)
      .setHelpText("Choose “Send Deposit Invoice” to email the 50% deposit.")
      .build();
    range.setDataValidation(rule);
  }

  ensureInstallableOnEditTrigger_();

  ui.alert(
    "Send Deposit Invoice button is ready (column " +
      columnLetter_(col) +
      ").\n\n" +
      "How to use:\n" +
      "1. Review Estimated Subtotal on the row\n" +
      "2. Click the purple cell → choose “Send Deposit Invoice”\n" +
      "3. Customer is emailed the 50% Stripe invoice\n" +
      "4. Cell becomes “✓ Sent”\n\n" +
      "Authorize the script if Google asks (required for the button)."
  );
}

function styleButtonCell_(cell) {
  cell.setBackground("#7B4DB8");
  cell.setFontColor("#ffffff");
  cell.setFontWeight("bold");
  cell.setHorizontalAlignment("center");
  cell.setNote("Choose “Send Deposit Invoice” after reviewing this order.");
}

function styleSentCell_(cell) {
  cell.setBackground("#E8F5E9");
  cell.setFontColor("#1B5E20");
  cell.setFontWeight("bold");
  cell.setHorizontalAlignment("center");
}

function ensureInstallableOnEditTrigger_() {
  var triggers = ScriptApp.getProjectTriggers();
  var found = false;
  for (var i = 0; i < triggers.length; i++) {
    var fn = triggers[i].getHandlerFunction();
    if (fn === INSTALLABLE_HANDLER || fn === "onStripeDepositEdit") {
      found = true;
      // Migrate old handler name
      if (fn === "onStripeDepositEdit") {
        ScriptApp.deleteTrigger(triggers[i]);
        found = false;
      }
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
  if (cell) {
    cell.setValue(SENDING_LABEL);
    styleButtonCell_(cell);
  }

  var result = sendDepositInvoiceForRow_(sheet, row, true);
  applyResultToCell_(cell, result);
}

/** Installable onEdit — required for UrlFetchApp. */
function onSendDepositButtonEdit(e) {
  handleSendDepositEdit_(e);
}

/** Back-compat alias */
function onStripeDepositEdit(e) {
  handleSendDepositEdit_(e);
}

/** Simple onEdit cannot call UrlFetch — leave empty. */
function onEdit(e) {
  /* intentionally empty */
}

function handleSendDepositEdit_(e) {
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

    var val = String(e.range.getValue() == null ? "" : e.range.getValue()).trim();
    var trigger =
      val === BUTTON_LABEL ||
      val.toLowerCase() === "send deposit invoice" ||
      val.toLowerCase() === "send" ||
      val === "SEND" ||
      val === true ||
      val === "TRUE";

    // Ignore when clearing or marking sent
    if (!trigger) return;
    if (val.indexOf("✓") === 0 || val === SENT_LABEL || val === SENDING_LABEL) return;

    e.range.setValue(SENDING_LABEL);
    styleButtonCell_(e.range);
    SpreadsheetApp.flush();

    var result = sendDepositInvoiceForRow_(sheet, row, false);
    applyResultToCell_(e.range, result);

    if (result && result.ok) {
      SpreadsheetApp.getActiveSpreadsheet().toast(
        "50% deposit invoice emailed via Stripe.",
        "Send Deposit Invoice",
        8
      );
    } else {
      SpreadsheetApp.getActiveSpreadsheet().toast(
        String((result && result.error) || "Send failed").slice(0, 140),
        "Send Deposit Invoice failed",
        10
      );
    }
  } catch (err) {
    console.error(err);
    try {
      e.range.setValue("");
      styleButtonCell_(e.range);
      e.range.setNote("Failed: " + (err.message || String(err)));
    } catch (e2) {
      /* ignore */
    }
  }
}

function applyResultToCell_(cell, result) {
  if (!cell) return;
  if (result && result.ok) {
    cell.setValue(SENT_LABEL);
    styleSentCell_(cell);
    if (result.data && result.data.checkoutUrl) {
      cell.setNote(
        "Deposit invoice sent " +
          new Date().toLocaleString() +
          "\n" +
          result.data.checkoutUrl
      );
    }
  } else if (result && result.error === "cancelled") {
    cell.setValue("");
    styleButtonCell_(cell);
  } else {
    cell.setValue("");
    styleButtonCell_(cell);
    cell.setNote("Failed: " + ((result && result.error) || "unknown"));
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
      ui.alert("API not configured.\n\nSweet Tooth → Configure API connection…");
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
      "Status is already “Deposit invoice sent”. Send another?",
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
        "Need at least $0.50 deposit.\nSet Estimated Subtotal on this row, then try again."
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
        "\n\nStripe will email the customer the payment invoice.",
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
      headers: { Authorization: "Bearer " + secret },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
  } catch (err) {
    if (showAlerts) {
      ui.alert(
        "Could not reach the API.\n\n" +
          err.message +
          "\n\n" +
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
    var depCell = sheet.getRange(row, depCol + 1);
    if (!String(depCell.getValue() || "").trim()) {
      depCell.setValue(Number(data.depositDollars));
    }
  }

  if (showAlerts) {
    var emailNote =
      data.email && data.email.sent
        ? "Emailed to " + record.email + " via " + (data.email.method || "Stripe")
        : "Link created — if email failed, copy:\n" + (data.checkoutUrl || "");
    ui.alert(
      "Deposit invoice ready\n\n" +
        "Amount: $" +
        Number(data.depositDollars).toFixed(2) +
        "\n" +
        emailNote +
        "\n\n" +
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
