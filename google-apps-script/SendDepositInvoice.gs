/**
 * Sweet Tooth Cravings — Send Deposit Invoice (Stripe Deposit column)
 *
 * Column: "Stripe Deposit" (narrow ~120px)
 * Dropdown options: only "Send Deposit Invoice" (no checkbox, no Sent option)
 * After success the cell text becomes "✓ Sent" (not a dropdown choice)
 *
 * Reads Email (and name/subtotal/etc.) from the SAME row.
 * Calls Render API → Stripe invoices the customer 50% deposit.
 *
 * SETUP (one time)
 * 1. Extensions → Apps Script → paste this file → Save
 * 2. Reload spreadsheet
 * 3. Sweet Tooth → Install Send Deposit Invoice button + trigger
 * 4. Authorize when prompted
 *
 * API secret defaults to ADMIN_PASSWORD on Render (sweettooth-admin).
 * Stripe secret key lives only on Render (never in this script).
 */

var DEFAULT_API_BASE = "https://sweettooth-cravings-api.onrender.com";
var DEFAULT_SHEET_SECRET = "sweettooth-admin";

var COLUMN_HEADER = "Stripe Deposit";
var BUTTON_LABEL = "Send Deposit Invoice";
var SENT_LABEL = "✓ Sent";
var SENDING_LABEL = "…";
var COLUMN_WIDTH = 120;

var INSTALLABLE_HANDLER = "onSendDepositButtonEdit";

var HEADER_MAP = {
  orderId: ["Order", "Order ID", "Order Id", "order id"],
  status: ["Status"],
  customerName: ["Customer Name", "Name"],
  email: ["Email", "Customer Email", "E-mail"],
  phone: ["Phone", "Customer Phone"],
  eventDate: ["Event Date"],
  product: ["Product / Cake", "Product"],
  size: ["Size / Tier", "Size"],
  flavor: ["Flavor"],
  filling: ["Filling"],
  notes: ["Decoration & Custom Notes", "Decoration Notes", "Notes"],
  allergies: ["Allergies"],
  additionalNotes: ["Additional Notes"],
  lineItems: ["Line Items", "Line Items (full detail)", "Items"],
  estimatedSubtotal: [
    "Estimated Subtotal",
    "Est. Subtotal",
    "Subtotal",
    "Final Total",
    "Final Price",
    "Order Total",
  ],
  depositDue: [
    "Deposit Due",
    "Deposit Due (50%)",
    "Deposit",
    "50% Deposit",
    "Deposit Amount",
  ],
  orderType: ["Order Type"],
  sendDeposit: [
    "Stripe Deposit",
    "Send Deposit Invoice",
    "Invoice",
    "Send Deposit",
    "Send Invoice",
  ],
};

/** Never use bakery inboxes as the customer invoice recipient. */
var BAKERY_EMAIL_BLOCKLIST = [
  "sweettoothcravingsorder@gmail.com",
  "sweettoothcravings@gmail.com",
];

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
    "Render API (no trailing slash):\nCurrent: " + currentBase,
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
  if (base.indexOf("sweettooth-cravings.onrender.com") >= 0 && base.indexOf("-api") < 0) {
    base = DEFAULT_API_BASE;
  }

  var secretRes = ui.prompt(
    "Sheet actions secret",
    "ADMIN_PASSWORD on Render (default sweettooth-admin).\nLeave blank to keep existing.",
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
  ui.alert("Saved.\n\nAPI: " + base);
}

function showSetupHelp() {
  SpreadsheetApp.getUi().alert(
    "Send Deposit Invoice\n\n" +
      "1) Install Send Deposit Invoice button + trigger\n" +
      "2) Authorize the script\n" +
      "3) Review Estimated Subtotal on a row\n" +
      "4) Stripe Deposit column → dropdown → Send Deposit Invoice\n\n" +
      "Uses that row’s Email column. Stripe emails the 50% deposit link.\n" +
      "API: " +
      DEFAULT_API_BASE
  );
}

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

  // Rename old Invoice / Send Deposit Invoice header → Stripe Deposit
  headers = getHeaderRow_(sheet);
  for (var hi = 0; hi < headers.length; hi++) {
    var hn = String(headers[hi] || "")
      .trim()
      .toLowerCase();
    if (
      hn === "invoice" ||
      hn === "send deposit invoice" ||
      hn === "send deposit"
    ) {
      sheet.getRange(1, hi + 1).setValue(COLUMN_HEADER);
    }
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

  var headerCell = sheet.getRange(1, col);
  headerCell.setValue(COLUMN_HEADER);
  headerCell.setFontWeight("bold");
  headerCell.setFontSize(8);
  headerCell.setBackground("#7B4DB8");
  headerCell.setFontColor("#ffffff");
  headerCell.setHorizontalAlignment("center");
  headerCell.setWrap(false);
  headerCell.setNote(
    "Choose “Send Deposit Invoice” to email a 50% Stripe deposit to this row’s Email address."
  );

  sheet.setColumnWidth(col, COLUMN_WIDTH);

  var lastRow = Math.max(sheet.getLastRow(), 80);
  if (lastRow >= 2) {
    var range = sheet.getRange(2, col, lastRow - 1, 1);
    range.clearDataValidations();
    range.setWrap(false);
    range.setHorizontalAlignment("center");
    range.setFontSize(8);

    var values = range.getValues();
    for (var r = 0; r < values.length; r++) {
      var cell = sheet.getRange(r + 2, col);
      var v = values[r][0];
      var s = String(v == null ? "" : v).trim();

      if (s.indexOf("✓") === 0 || s === SENT_LABEL) {
        styleSentCell_(cell);
        continue;
      }

      // Strip checkboxes / TRUE / FALSE / old labels
      if (
        v === true ||
        v === false ||
        s === "TRUE" ||
        s === "FALSE" ||
        s === "" ||
        s === "Send" ||
        s === SENDING_LABEL ||
        s.toLowerCase() === "send deposit invoice"
      ) {
        cell.setValue("");
      }
      styleButtonCell_(cell);
    }

    // ONLY the action label in the dropdown (no Sent, no checkbox)
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList([BUTTON_LABEL], true)
      .setAllowInvalid(true)
      .setHelpText("Send Deposit Invoice — emails 50% deposit to this row’s Email.")
      .build();
    range.setDataValidation(rule);
  }

  ensureInstallableOnEditTrigger_();

  try {
    UrlFetchApp.fetch(DEFAULT_API_BASE + "/api/health", {
      muteHttpExceptions: true,
      method: "get",
    });
  } catch (e) {
    /* ignore */
  }

  ui.alert(
    "Stripe Deposit column ready (width " +
      COLUMN_WIDTH +
      "px).\n\n" +
      "1. Review Estimated Subtotal\n" +
      "2. Open dropdown → Send Deposit Invoice\n" +
      "3. Stripe emails that row’s Email\n" +
      "4. Cell shows ✓ Sent\n\n" +
      "Authorize if Google asks."
  );
}

function styleButtonCell_(cell) {
  cell.setBackground("#7B4DB8");
  cell.setFontColor("#ffffff");
  cell.setFontWeight("bold");
  cell.setFontSize(8);
  cell.setHorizontalAlignment("center");
  cell.setVerticalAlignment("middle");
  cell.setWrap(false);
  cell.setNote("Send Deposit Invoice — uses Email on this row.");
}

function styleSentCell_(cell) {
  cell.setBackground("#E8F5E9");
  cell.setFontColor("#1B5E20");
  cell.setFontWeight("bold");
  cell.setFontSize(8);
  cell.setHorizontalAlignment("center");
  cell.setWrap(false);
  cell.clearDataValidations();
}

function ensureInstallableOnEditTrigger_() {
  var triggers = ScriptApp.getProjectTriggers();
  var found = false;
  for (var i = 0; i < triggers.length; i++) {
    var fn = triggers[i].getHandlerFunction();
    if (
      fn === INSTALLABLE_HANDLER ||
      fn === "onStripeDepositEdit" ||
      fn === "onSendDepositButtonEdit"
    ) {
      if (fn !== INSTALLABLE_HANDLER) {
        ScriptApp.deleteTrigger(triggers[i]);
      } else {
        found = true;
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

function onSendDepositButtonEdit(e) {
  handleSendDepositEdit_(e);
}

function onStripeDepositEdit(e) {
  handleSendDepositEdit_(e);
}

function onEdit(e) {
  /* simple trigger cannot UrlFetch — installable handler does the work */
}

function handleSendDepositEdit_(e) {
  var lock = LockService.getDocumentLock();
  try {
    if (!lock.tryLock(8000)) return;
    if (!e || !e.range) return;

    var sheet = e.range.getSheet();
    var row = e.range.getRow();
    var col = e.range.getColumn();
    if (row < 2) return;
    if (e.range.getNumRows() > 1 || e.range.getNumColumns() > 1) return;

    var headers = getHeaderRow_(sheet);
    var sendCol = findHeaderIndex_(headers, HEADER_MAP.sendDeposit);
    if (sendCol < 0 || col !== sendCol + 1) return;

    var val = String(e.range.getValue() == null ? "" : e.range.getValue()).trim();
    var trigger =
      val === BUTTON_LABEL ||
      val.toLowerCase() === "send deposit invoice" ||
      val === "Send" ||
      val.toLowerCase() === "send" ||
      val === true ||
      val === "TRUE";

    if (!trigger) return;
    if (val.indexOf("✓") === 0 || val === SENT_LABEL || val === SENDING_LABEL) return;

    e.range.setValue(SENDING_LABEL);
    styleButtonCell_(e.range);
    SpreadsheetApp.flush();

    var result = sendDepositInvoiceForRow_(sheet, row, false);
    applyResultToCell_(e.range, result);

    if (result && result.ok) {
      SpreadsheetApp.getActiveSpreadsheet().toast(
        "50% deposit emailed to " + (result.emailedTo || "customer") + ".",
        "Send Deposit Invoice",
        8
      );
    } else if (result && result.error !== "cancelled") {
      SpreadsheetApp.getActiveSpreadsheet().toast(
        String(result.error || "Send failed").slice(0, 150),
        "Send failed",
        12
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
  } finally {
    try {
      lock.releaseLock();
    } catch (e3) {
      /* ignore */
    }
  }
}

function applyResultToCell_(cell, result) {
  if (!cell) return;
  if (result && result.ok) {
    cell.clearDataValidations();
    cell.setValue(SENT_LABEL);
    styleSentCell_(cell);
    var note = "Deposit invoice sent " + new Date().toLocaleString();
    if (result.emailedTo) note += "\nTo: " + result.emailedTo;
    if (result.data && result.data.checkoutUrl) note += "\n" + result.data.checkoutUrl;
    cell.setNote(note);
  } else if (result && result.error === "cancelled") {
    cell.setValue("");
    styleButtonCell_(cell);
  } else {
    cell.setValue("");
    styleButtonCell_(cell);
    // restore dropdown only
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList([BUTTON_LABEL], true)
      .setAllowInvalid(true)
      .build();
    cell.setDataValidation(rule);
    cell.setNote("Failed: " + ((result && result.error) || "unknown"));
  }
}

function formatCellValue_(v) {
  if (v == null || v === "") return "";
  if (Object.prototype.toString.call(v) === "[object Date]" && !isNaN(v.getTime())) {
    return Utilities.formatDate(
      v,
      Session.getScriptTimeZone() || "America/New_York",
      "yyyy-MM-dd"
    );
  }
  return String(v).trim();
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

  if (base.indexOf("sweettooth-cravings.onrender.com") >= 0 && base.indexOf("-api") < 0) {
    base = DEFAULT_API_BASE;
    props.setProperty("API_BASE_URL", base);
  }

  if (!base || !secret) {
    if (showAlerts) ui.alert("API not configured.\nSweet Tooth → Configure API connection…");
    return { ok: false, error: "not_configured" };
  }

  // Wake API (Render free tier)
  try {
    UrlFetchApp.fetch(base + "/api/health", {
      muteHttpExceptions: true,
      method: "get",
    });
  } catch (wakeErr) {
    /* continue */
  }

  var headers = getHeaderRow_(sheet);
  var record = readRowAsObject_(sheet, row, headers);

  // Email MUST come from this row’s Email column only (never bakery defaults)
  var email = String(record.email || "")
    .trim()
    .toLowerCase();
  if (!email || email.indexOf("@") < 0) {
    if (showAlerts) {
      ui.alert(
        "No valid Email on this row.\n\nAdd the customer email in the Email column for this row, then try again."
      );
    }
    return { ok: false, error: "no_email on this row" };
  }
  if (isBakeryEmail_(email)) {
    if (showAlerts) {
      ui.alert(
        "The Email column is the bakery inbox (" +
          email +
          ").\n\nPut the customer’s email in the Email column of this row."
      );
    }
    return { ok: false, error: "email is bakery inbox, not customer" };
  }

  var statusStr = String(record.status || "").toLowerCase();
  if (statusStr.indexOf("deposit invoice sent") >= 0 && showAlerts) {
    var again = ui.alert(
      "Already sent",
      "Status is already “Deposit invoice sent”. Send another to " + email + "?",
      ui.ButtonSet.YES_NO
    );
    if (again !== ui.Button.YES) return { ok: false, error: "cancelled" };
  }

  // Prefer numeric cell values; fall back to display text and Line Items totals
  var subtotal = parseMoney_(record.estimatedSubtotal);
  var deposit = parseMoney_(record.depositDue);
  var lineText = String(record.lineItems || "").trim();
  if ((!isPositiveMoney_(subtotal) || !isPositiveMoney_(deposit)) && lineText) {
    var fromLines = extractTotalsFromLineItems_(lineText);
    if (!isPositiveMoney_(subtotal) && isPositiveMoney_(fromLines.subtotal)) {
      subtotal = fromLines.subtotal;
    }
    if (!isPositiveMoney_(deposit) && isPositiveMoney_(fromLines.deposit)) {
      deposit = fromLines.deposit;
    }
  }
  if (!isPositiveMoney_(deposit) && isPositiveMoney_(subtotal)) {
    deposit = Math.round(subtotal * 50) / 100;
  }
  if (!isPositiveMoney_(subtotal) && isPositiveMoney_(deposit)) {
    subtotal = Math.round(deposit * 2 * 100) / 100;
  }

  if (!isPositiveMoney_(deposit) || deposit < 0.5) {
    if (showAlerts) {
      ui.alert(
        "Need at least $0.50 deposit.\n\n" +
          "Set Estimated Subtotal (or Deposit Due) on this row.\n" +
          "Read subtotal: " +
          (isPositiveMoney_(subtotal) ? "$" + subtotal.toFixed(2) : "(empty/0)") +
          "\nRead deposit: " +
          (isPositiveMoney_(deposit) ? "$" + deposit.toFixed(2) : "(empty/0)")
      );
    }
    return { ok: false, error: "no_amount — set Estimated Subtotal first" };
  }

  var lineBits = [];
  if (lineText) lineBits.push(lineText);
  else {
    if (record.product) lineBits.push(record.product);
    if (record.size) lineBits.push("Size: " + record.size);
    if (record.flavor) lineBits.push("Flavor: " + record.flavor);
    if (record.filling) lineBits.push("Filling: " + record.filling);
    if (record.notes) lineBits.push(record.notes);
  }

  var payload = {
    orderId: record.orderId || "",
    customerName: record.customerName || "",
    customerEmail: email,
    email: email,
    customerPhone: record.phone || "",
    eventDate: record.eventDate || "",
    orderType: record.orderType || "",
    product: record.product || "",
    lineItemsDetail: lineBits.join("\n"),
    lineItems: lineBits.join("\n"),
    estimatedSubtotal: isPositiveMoney_(subtotal) ? subtotal : "",
    depositAmount: deposit,
    depositDue: deposit,
    finalTotal: isPositiveMoney_(subtotal) ? subtotal : "",
  };

  if (showAlerts) {
    var confirm = ui.alert(
      "Send 50% deposit invoice?",
      "To (this row’s Email only):\n" +
        email +
        "\nName: " +
        (record.customerName || "(none)") +
        "\nOrder total: $" +
        (isPositiveMoney_(subtotal) ? subtotal.toFixed(2) : "?") +
        "\nDeposit now: $" +
        deposit.toFixed(2) +
        " (50%)" +
        "\nOrder: " +
        (record.orderId || "(none)") +
        "\n\nStripe will email a real live invoice with full line items to that customer.",
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
      followRedirects: true,
    });
  } catch (err) {
    var em = String(err.message || err);
    if (showAlerts) {
      ui.alert(
        "Could not reach API.\n\n" +
          em +
          "\n\nWait 30s if Render is waking up.\n" +
          DEFAULT_API_BASE
      );
    }
    return { ok: false, error: em };
  }

  var code = response.getResponseCode();
  var text = response.getContentText();
  var data = {};
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = { error: text || "Invalid API response" };
  }

  if (code < 200 || code >= 300 || !data.success) {
    var msg = (data && data.error) || text || "HTTP " + code;
    if (code === 401) {
      msg =
        "Unauthorized — Configure API connection; secret should be sweettooth-admin (or your ADMIN_PASSWORD).";
    } else if (code === 502 || code === 503 || code === 504) {
      msg = "API starting up. Wait 30 seconds and choose Send Deposit Invoice again.";
    }
    if (showAlerts) ui.alert("Send failed\n\n" + msg);
    setStatusIfPossible_(sheet, row, headers, "Deposit send failed");
    return { ok: false, error: msg };
  }

  // Email is required for a full success — Stripe invoice email or notify fallback
  var emailSent = !!(data.email && data.email.sent);
  var payUrl = data.checkoutUrl || data.paymentUrl || "";

  setStatusIfPossible_(
    sheet,
    row,
    headers,
    data.sheetStatus ||
      (emailSent ? "Deposit invoice sent" : "Deposit link created (email failed)")
  );

  var depCol = findHeaderIndex_(headers, HEADER_MAP.depositDue);
  if (depCol >= 0 && data.depositDollars != null) {
    var depCell = sheet.getRange(row, depCol + 1);
    if (!String(depCell.getValue() || "").trim()) {
      depCell.setValue(Number(data.depositDollars));
    }
  }

  if (!emailSent) {
    var failMsg =
      "Payment link was created but email did not send to " +
      email +
      ".\n\n" +
      (data.email && data.email.error ? data.email.error + "\n\n" : "") +
      "Share this link manually:\n" +
      payUrl;
    if (showAlerts) ui.alert("Email failed\n\n" + failMsg);
    return {
      ok: false,
      error: "email_not_sent — share link manually: " + payUrl,
      data: data,
      emailedTo: email,
    };
  }

  if (showAlerts) {
    ui.alert(
      "Deposit invoice ready\n\n" +
        "Amount: $" +
        Number(data.depositDollars).toFixed(2) +
        "\nEmailed to " +
        email +
        "\n\n" +
        payUrl
    );
  }

  return { ok: true, data: data, emailedTo: email };
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
  var range = sheet.getRange(row, 1, 1, lastCol);
  var values = range.getValues()[0];
  var displays = range.getDisplayValues()[0];

  function col(key) {
    var idx = findHeaderIndex_(headers, HEADER_MAP[key] || []);
    if (idx < 0) return "";
    return formatCellValue_(values[idx]);
  }

  /** Money: prefer raw number, else display text like "$120.00" */
  function colMoney(key) {
    var idx = findHeaderIndex_(headers, HEADER_MAP[key] || []);
    if (idx < 0) return "";
    var raw = values[idx];
    if (typeof raw === "number" && isFinite(raw)) return raw;
    var disp = displays[idx];
    if (disp != null && String(disp).trim() !== "") return String(disp).trim();
    return formatCellValue_(raw);
  }

  /** Email: prefer display, strip spaces */
  function colEmail() {
    var idx = findHeaderIndex_(headers, HEADER_MAP.email);
    if (idx < 0) return "";
    var disp = String(displays[idx] != null ? displays[idx] : "").trim();
    if (disp.indexOf("@") >= 0) return disp;
    return formatCellValue_(values[idx]);
  }

  /** Line items: multi-line display text */
  function colLineItems() {
    var idx = findHeaderIndex_(headers, HEADER_MAP.lineItems);
    if (idx < 0) return "";
    var disp = String(displays[idx] != null ? displays[idx] : "").trim();
    if (disp) return disp;
    return formatCellValue_(values[idx]);
  }

  return {
    orderId: col("orderId"),
    status: col("status"),
    customerName: col("customerName"),
    email: colEmail(),
    phone: col("phone"),
    eventDate: col("eventDate"),
    product: col("product"),
    size: col("size"),
    flavor: col("flavor"),
    filling: col("filling"),
    notes: col("notes"),
    allergies: col("allergies"),
    additionalNotes: col("additionalNotes"),
    lineItems: colLineItems(),
    estimatedSubtotal: colMoney("estimatedSubtotal"),
    depositDue: colMoney("depositDue"),
    orderType: col("orderType"),
  };
}

function isPositiveMoney_(n) {
  return typeof n === "number" && isFinite(n) && n > 0;
}

function isBakeryEmail_(email) {
  var e = String(email || "")
    .trim()
    .toLowerCase();
  if (!e) return false;
  for (var i = 0; i < BAKERY_EMAIL_BLOCKLIST.length; i++) {
    if (e === BAKERY_EMAIL_BLOCKLIST[i]) return true;
  }
  if (e.indexOf("sweettoothcravingsorder@") === 0) return true;
  if (e.indexOf("@sweettoothcravings.shop") > 0) return true;
  return false;
}

function parseMoney_(raw) {
  if (raw == null || raw === "") return NaN;
  if (typeof raw === "number" && isFinite(raw)) return raw;
  var s = String(raw).trim();
  if (!s || s === "-" || s.toLowerCase() === "n/a") return NaN;
  // Prefer $amount match
  var m = s.match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/);
  if (m) {
    var fromDollar = Number(String(m[1]).replace(/,/g, ""));
    if (isFinite(fromDollar)) return fromDollar;
  }
  s = s.replace(/[^0-9.,-]/g, "");
  if (!s) return NaN;
  if (s.indexOf(",") >= 0 && s.indexOf(".") >= 0) s = s.replace(/,/g, "");
  else if (s.indexOf(",") >= 0) s = s.replace(",", ".");
  var n = Number(s);
  return isFinite(n) ? n : NaN;
}

/** Pull totals embedded in the Line Items cell when amount columns are blank/$0. */
function extractTotalsFromLineItems_(text) {
  var raw = String(text || "");
  var subtotal = NaN;
  var deposit = NaN;
  var subM = raw.match(/Estimated\s+subtotal:\s*(\$?[0-9.,]+)/i);
  if (subM) subtotal = parseMoney_(subM[1]);
  var depM = raw.match(/Deposit\s+due(?:\s*\(50%\))?:\s*(\$?[0-9.,]+)/i);
  if (depM) deposit = parseMoney_(depM[1]);
  if (!isPositiveMoney_(subtotal)) {
    var re = /Line total:\s*(\$?[0-9.,]+)/gi;
    var sum = 0;
    var hit = false;
    var mm;
    while ((mm = re.exec(raw)) !== null) {
      var v = parseMoney_(mm[1]);
      if (isPositiveMoney_(v)) {
        sum += v;
        hit = true;
      }
    }
    if (hit && sum > 0) subtotal = Math.round(sum * 100) / 100;
  }
  if (!isPositiveMoney_(deposit) && isPositiveMoney_(subtotal)) {
    deposit = Math.round(subtotal * 50) / 100;
  }
  return { subtotal: subtotal, deposit: deposit };
}

function setStatusIfPossible_(sheet, row, headers, statusText) {
  var idx = findHeaderIndex_(headers, HEADER_MAP.status);
  if (idx < 0) return;
  sheet.getRange(row, idx + 1).setValue(statusText);
}
