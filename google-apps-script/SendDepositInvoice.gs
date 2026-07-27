/**
 * Sweet Tooth Cravings — Google Sheet: "Stripe Deposit" one-click invoice
 *
 * Order Log columns (left → right):
 *   Order | Submit Date | Order Type | Status | Customer Name | Email | Phone |
 *   Event Date | Line Items | Estimated Subtotal | Deposit Due |
 *   Photo 1 | Photo 2 | Photo 3 | Stripe Deposit
 *
 * After you review a row:
 *   • Check the box in **Stripe Deposit** (last column), or
 *   • Menu: Sweet Tooth → Send Deposit Invoice (selected row)
 *
 * Calls Render API → Stripe Checkout (Sweet Tooth STRIPE_SECRET_KEY)
 * → emails the customer the 50% deposit link → updates Status.
 *
 * SETUP — see GOOGLE-SHEETS-SETUP.md
 * Website form submission still goes to the same Order Log + Drive folder.
 */

var DEFAULT_API_BASE = "https://sweettooth-cravings-api.onrender.com";
var STRIPE_DEPOSIT_HEADER = "Stripe Deposit";

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
  // Last column — one-click checkbox button
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
    .addItem("Install Stripe Deposit button column", "installStripeDepositColumn")
    .addItem("Configure API connection…", "configureApiConnection")
    .addSeparator()
    .addItem("Show setup help", "showSetupHelp")
    .addToUi();
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
    "Same value as SHEET_ACTIONS_SECRET on Render (or ADMIN_PASSWORD).\nLeave blank to keep the existing secret.",
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
      "\n\nNext: Sweet Tooth → Install Stripe Deposit button column\nThen check a box after reviewing an order."
  );
}

function showSetupHelp() {
  SpreadsheetApp.getUi().alert(
    "Stripe Deposit — one-click invoice\n\n" +
      "1) Review Estimated Subtotal on the order row.\n" +
      "2) Check the box under **Stripe Deposit** on that row\n" +
      "   (or menu: Send Deposit Invoice).\n\n" +
      "Creates a Stripe 50% deposit Checkout and emails the customer.\n" +
      "Form → Sheets/Drive flow is unchanged.\n\n" +
      "API: " +
      DEFAULT_API_BASE +
      "\nRequires STRIPE_SECRET_KEY on Render."
  );
}

/**
 * Ensures "Stripe Deposit" is the last column (after Photo 3) with checkboxes.
 * Checking a box = one-click Send Deposit Invoice.
 */
function installStripeDepositColumn() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSheet();

  // Preferred header order written by the website API
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

  // If row 1 is empty / wrong, write preferred headers for columns A–O
  var headers = getHeaderRow_(sheet);
  var first = String(headers[0] || "").trim().toLowerCase();
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
  sheet.setColumnWidth(col, 130);
  sheet
    .getRange(1, col)
    .setNote(
      "Check after reviewing Estimated Subtotal to email a 50% Stripe deposit invoice (Sweet Tooth Stripe account)."
    );

  var lastRow = Math.max(sheet.getLastRow(), 50);
  if (lastRow >= 2) {
    sheet.getRange(2, col, lastRow - 1, 1).insertCheckboxes();
  }

  clearObsoleteHeaders_(sheet);

  ui.alert(
    '"' +
      STRIPE_DEPOSIT_HEADER +
      '" is ready in column ' +
      columnLetter_(col) +
      ".\n\n" +
      "After review: check the box → 50% deposit invoice is emailed.\n" +
      "Or use menu: Sweet Tooth → Send Deposit Invoice."
  );
}

/** Clear leftover obsolete header labels past the cleaned schema. */
function clearObsoleteHeaders_(sheet) {
  var headers = getHeaderRow_(sheet);
  var obsolete = {
    "photo 4": true,
    "photo 5": true,
    "photo 6": true,
    source: true,
    "tax year": true,
    "product / cake": true,
    "size / tier": true,
    flavor: true,
    filling: true,
    "decoration & custom notes": true,
    "additional notes": true,
    "order id": true,
    "submitted at": true,
    "line items (full detail)": true,
    "deposit due (50%)": true,
  };
  for (var i = 0; i < headers.length; i++) {
    var key = String(headers[i] || "")
      .trim()
      .toLowerCase();
    if (obsolete[key]) {
      sheet.getRange(1, i + 1).setValue("");
    }
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
  sendDepositInvoiceForRow_(sheet, row, true);
}

/**
 * One-click: checking Stripe Deposit on a data row sends the invoice.
 */
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    var row = e.range.getRow();
    var col = e.range.getColumn();
    if (row < 2) return;

    var headers = getHeaderRow_(sheet);
    var sendCol = findHeaderIndex_(headers, HEADER_MAP.sendDeposit);
    if (sendCol < 0) return;
    if (col !== sendCol + 1) return;

    var val = e.range.getValue();
    var checked = val === true || val === "TRUE" || val === "Yes" || val === "yes";
    if (!checked) return;

    sendDepositInvoiceForRow_(sheet, row, false);
    e.range.setValue(false);
  } catch (err) {
    console.error(err);
  }
}

function sendDepositInvoiceForRow_(sheet, row, showAlerts) {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var base = (props.getProperty("API_BASE_URL") || DEFAULT_API_BASE).replace(/\/$/, "");
  var secret = props.getProperty("SHEET_ACTIONS_SECRET") || "";

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
        "API not configured.\n\nSweet Tooth → Configure API connection…\n\nUse:\n" +
          DEFAULT_API_BASE +
          "\nand SHEET_ACTIONS_SECRET (or ADMIN_PASSWORD)."
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
          "\n\nCheck API is " +
          DEFAULT_API_BASE +
          " and Render is awake."
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

  setStatusIfPossible_(sheet, row, headers, data.sheetStatus || "Deposit invoice sent");

  var depCol = findHeaderIndex_(headers, HEADER_MAP.depositDue);
  if (depCol >= 0 && data.depositDollars != null) {
    var cell = sheet.getRange(row, depCol + 1);
    if (!String(cell.getValue() || "").trim()) {
      cell.setValue(Number(data.depositDollars));
    }
  }

  // Optional: write a short note under Stripe Deposit status in a note on the cell
  var stripeCol = findHeaderIndex_(headers, HEADER_MAP.sendDeposit);
  if (stripeCol >= 0 && data.checkoutUrl) {
    try {
      sheet
        .getRange(row, stripeCol + 1)
        .setNote(
          "Deposit invoice sent " +
            new Date().toISOString() +
            "\n" +
            data.checkoutUrl
        );
    } catch (noteErr) {
      /* ignore */
    }
  }

  if (showAlerts) {
    var emailNote =
      data.email && data.email.sent
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
