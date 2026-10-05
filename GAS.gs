// Google Apps Script - Customer Pinpoint Location
// Paste this whole file into the Apps Script editor.
// Deploy as Web App: Execute as Me, Access: Anyone.
//
// This file is pure ASCII so nothing corrupts on paste.
//
// SHEET CONTRACT
//   Tab 'Customers'   header row 1: BP_ID, Customer_Name, Street_Address,
//                     Status, Invite_Token       (Status must be 'Active')
//   Tab 'Submissions'  headers written automatically on first write
//
// RESPONSE CONTRACT
//   Apps Script ContentService always answers HTTP 200 and cannot set a
//   status code. Success is signalled ONLY by success:true / valid:true in
//   the body. The frontend checks those flags, never response.ok.
//   Errors carry a stable errorCode; `error` is English text for logs.

const SHEET_CUSTOMERS = 'Customers';
const SHEET_SUBMISSIONS = 'Submissions';

// Kept in step with CONFIG.ACCURACY_THRESHOLD in the frontend config.js.
const ACCURACY_THRESHOLD_M = 150;

// Rough bounding box for Bangladesh. Readings outside it are still stored
// (the raw value matters more than dropping it) but flagged for review,
// because a silently discarded fix is worse than a bad row a human sees.
const BD_LAT_MIN = 20, BD_LAT_MAX = 27;
const BD_LON_MIN = 88, BD_LON_MAX = 93;

const SUBMISSION_HEADERS = [
  'Submission_ID', 'Local_ID', 'BP_ID', 'Customer_Name', 'Captured_At',
  'Submitted_At', 'Lat', 'Lon', 'Accuracy_m', 'Accuracy_Flag', 'Device_ID',
  'Consent', 'Status', 'Reject_Reason', 'Source', 'Invite_Token_Used'
];


// ---------------------------------------------------------------- routing

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'health';
  return jsonResponse({
    success: true,
    message: 'Customer Pinpoint Location backend is live.',
    health: health()
  });
}

// Browser preflight for the JSON POST the app sends. Without this the
// browser blocks every request before it ever reaches doPost.
function doOptions(e) {
  return jsonResponse({ success: true });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);

    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ success: false, errorCode: 'EMPTY_BODY',
                            error: 'Empty request body' });
    }

    var body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return jsonResponse({ success: false, errorCode: 'BAD_JSON',
                            error: 'Malformed JSON: ' + parseErr.message });
    }

    if (body.action === 'validateBP') {
      return jsonResponse(validateBP(body.bpId, body.token));
    }
    if (body.action === 'submit') {
      return jsonResponse(submitLocation(body));
    }
    return jsonResponse({ success: false, errorCode: 'BAD_ACTION',
                          error: 'Unknown action: ' + body.action });
  } catch (err) {
    return jsonResponse({
      success: false,
      errorCode: 'SERVER_ERROR',
      error: (err && err.message) ? err.message : String(err),
      stack: (err && err.stack) ? String(err.stack).split('\n').slice(0, 4).join(' | ') : ''
    });
  } finally {
    try { lock.releaseLock(); } catch (relErr) {}
  }
}


// ------------------------------------------------------------ diagnostics

// Lets the user tell "sheet is empty" apart from "sheet is missing" apart
// from "this script is not bound to the spreadsheet" without guessing.
function health() {
  var out = { sheets: [], customers: null, submissions: null, activeCount: 0 };
  var ss;
  try {
    ss = SpreadsheetApp.getActive();
  } catch (e) {
    out.fatal = 'getActive() failed - this script is not bound to a spreadsheet. ' +
                'Create it via Extensions > Apps Script from inside the sheet.';
    return out;
  }
  out.spreadsheet = ss.getName();

  var all = ss.getSheets();
  for (var i = 0; i < all.length; i++) out.sheets.push(all[i].getName());

  var cust = ss.getSheetByName(SHEET_CUSTOMERS);
  if (cust) {
    out.customers = cust.getLastRow();
    var rows = readTable_(cust);
    if (rows.length) {
      for (var r = 0; r < rows.length; r++) {
        if (isActive_(rows[r].Status)) out.activeCount++;
      }
      out.headers = rows[0];
    } else {
      out.customerProblem = 'Sheet "' + SHEET_CUSTOMERS + '" has no header row.';
    }
  } else {
    out.customerProblem = 'No tab named "' + SHEET_CUSTOMERS + '". Found: ' + out.sheets.join(', ');
  }

  var sub = ss.getSheetByName(SHEET_SUBMISSIONS);
  out.submissions = sub ? sub.getLastRow() : 0;
  return out;
}


// ---------------------------------------------------------------- lookup

function validateBP(bpId, token) {
  var searchBp = bpId === undefined || bpId === null ? '' : String(bpId).trim();
  if (!searchBp) {
    return { valid: false, errorCode: 'BP_REQUIRED', error: 'BP ID is required' };
  }

  var ss = activeSS_();
  var sheet = ss && ss.getSheetByName(SHEET_CUSTOMERS);
  if (!sheet) {
    return { valid: false, errorCode: 'NO_CUSTOMERS_SHEET',
             error: 'Customers sheet not found', health: health() };
  }

  var rows = readTable_(sheet);
  if (rows.length === 0) {
    return { valid: false, errorCode: 'NO_CUSTOMERS_SHEET', error: 'Customers sheet not found' };
  }
  if (rows.length === 1) {
    return { valid: false, errorCode: 'CUSTOMERS_EMPTY',
             error: 'No customer data found - headers exist but zero customer rows',
             health: health() };
  }

  var h = rows[0];
  var found = Object.keys(h).filter(function (k) { return k !== ''; });
  if (found.indexOf('BP_ID') < 0) {
    return { valid: false, errorCode: 'BAD_HEADERS',
             error: 'Customers sheet needs a BP_ID column. Found: ' + found.join(', '),
             health: health() };
  }

  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    if (!bpMatches_(row.BP_ID, searchBp)) continue;

    // A row with no Status column, or a blank Status, counts as active so a
    // bare customer list still works.
    if (!isActive_(row.Status)) {
      return { valid: false, errorCode: 'BP_INACTIVE',
               error: 'BP ID is inactive', bpId: searchBp };
    }

    var stored = cellStr_(row.Invite_Token);
    if (stored) {
      var given = token ? String(token).trim() : '';
      if (!given) {
        return { valid: false, errorCode: 'TOKEN_REQUIRED', requiresToken: true,
                 error: 'Token required for this BP', bpId: searchBp };
      }
      if (stored !== given) {
        return { valid: false, errorCode: 'TOKEN_INVALID', requiresToken: true,
                 error: 'Invalid token', bpId: searchBp };
      }
    }

    return {
      valid: true,
      bpId: searchBp,
      customerName: cellStr_(row.Customer_Name),
      address: cellStr_(row.Street_Address)
    };
  }

  return { valid: false, errorCode: 'BP_NOT_FOUND', error: 'BP ID not found', bpId: searchBp };
}


// --------------------------------------------------------------- submit

function submitLocation(body) {
  var required = ['localId', 'bpId', 'lat', 'lon', 'accuracy', 'capturedAt', 'deviceId', 'consent'];
  for (var i = 0; i < required.length; i++) {
    var v = body[required[i]];
    if (v === undefined || v === null || v === '') {
      return { success: false, errorCode: 'MISSING_FIELD',
               error: 'Missing required field: ' + required[i] };
    }
  }
  if (!body.consent) {
    return { success: false, errorCode: 'NO_CONSENT', error: 'Consent is required' };
  }

  // Resolve the customer BEFORE writing, so an unknown BP never creates a row.
  var check = validateBP(body.bpId, body.token);
  if (!check.valid) {
    return { success: false, errorCode: check.errorCode || 'BP_INVALID',
             error: check.error, bpId: body.bpId };
  }

  var ss = activeSS_();
  var sheet = ss.getSheetByName(SHEET_SUBMISSIONS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_SUBMISSIONS);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(SUBMISSION_HEADERS);
    sheet.setFrozenRows(1);
  }

  // Idempotency. The client reuses one localId across every retry, so a
  // repeat submission must be acknowledged, not duplicated.
  var dup = findExisting_(sheet, body.localId);
  if (dup) {
    return { success: true, duplicate: true, message: 'Already received',
             localId: body.localId, submissionId: dup };
  }

  var lat = parseFloat(body.lat);
  var lon = parseFloat(body.lon);
  var acc = parseFloat(body.accuracy);

  var flag = 'OK';
  if (isNaN(lat) || isNaN(lon)) {
    flag = 'INVALID_COORDS';
  } else if (lat < BD_LAT_MIN || lat > BD_LAT_MAX ||
             lon < BD_LON_MIN || lon > BD_LON_MAX) {
    flag = 'OUT_OF_BOUNDS';
  } else if (isNaN(acc) || acc > ACCURACY_THRESHOLD_M) {
    flag = 'HIGH_ACCURACY_ISSUE';
  }

  var submissionId = 'SUB-' + Date.now().toString(36) + '-' +
                     Math.random().toString(36).substr(2, 5).toUpperCase();

  sheet.appendRow([
    submissionId,
    String(body.localId),
    String(body.bpId),
    check.customerName || '',
    String(body.capturedAt),
    new Date().toISOString(),
    lat,
    lon,
    acc,
    flag,
    String(body.deviceId),
    'true',
    'Received',
    '',
    'web/pwa',
    body.token ? String(body.token).trim() : ''
  ]);

  return {
    success: true,
    duplicate: false,
    message: 'Submitted successfully',
    localId: body.localId,
    submissionId: submissionId,
    accuracyFlag: flag
  };
}


// ----------------------------------------------------------------- utils

function activeSS_() {
  var ss = SpreadsheetApp.getActive();
  if (!ss) throw new Error('Not bound to a spreadsheet');
  return ss;
}

// Reads a sheet into an array of plain objects keyed by the header row.
// Trailing blank rows are dropped by getValues() already; this only guards
// the case where row 1 is entirely blank.
function readTable_(sheet) {
  var values = sheet.getDataRange().getValues();
  if (!values.length) return [];
  var headers = values[0];
  var hasHeader = false;
  for (var h = 0; h < headers.length; h++) {
    if (cellStr_(headers[h]) !== '') { hasHeader = true; break; }
  }
  if (!hasHeader) return [];

  var out = [];
  for (var r = 0; r < values.length; r++) {
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      obj[cellStr_(headers[c])] = values[r][c];
    }
    out.push(obj);
  }
  return out;
}

// Column lookup against a raw header row. Returns the index, or -1.
function headerIndex_(headers, name) {
  for (var i = 0; i < headers.length; i++) {
    if (cellStr_(headers[i]) === name) return i;
  }
  return -1;
}

// Google Sheets turns numeric-looking text into numbers, and a BP ID with a
// leading zero comes back as 844 not '00844'. Both formats are accepted so a
// customer who types the ID either way still matches.
function cellStr_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : String(v);
  }
  return String(v).trim();
}

function bpMatches_(cellValue, searchBp) {
  var a = cellStr_(cellValue);
  if (a === searchBp) return true;
  // Tolerate a leading zero typed or lost on either side: 00844 vs 844.
  var na = parseInt(a, 10);
  var nb = parseInt(searchBp, 10);
  return !isNaN(na) && !isNaN(nb) && na === nb;
}

function isActive_(statusCell) {
  if (statusCell === undefined || statusCell === null || statusCell === '') return true;
  var s = String(statusCell).trim().toLowerCase();
  return s === 'active' || s === '1' || s === 'true' || s === 'yes';
}

// Returns the Submission_ID of a matching Local_ID row, or null.
function findExisting_(sheet, localId) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return null;

  var headers = values[0];
  var localIdx = headerIndex_(headers, 'Local_ID');
  var subIdx = headerIndex_(headers, 'Submission_ID');
  var statusIdx = headerIndex_(headers, 'Status');
  if (localIdx < 0) return null;

  for (var i = 1; i < values.length; i++) {
    if (cellStr_(values[i][localIdx]) !== String(localId)) continue;

    var status = statusIdx >= 0 ? cellStr_(values[i][statusIdx]) : 'Received';
    if (status === 'Received' || status === 'Duplicate' || status === '') {
      return subIdx >= 0 ? cellStr_(values[i][subIdx]) : 'UNKNOWN';
    }
    return null;  // rejected row - let it through as a fresh submission
  }
  return null;
}


// --------------------------------------------------------------- output

// Apps Script has no setHttpHeader on TextOutput (calling it throws a
// TypeError and breaks every response). setHeaders is the method that
// exists, and it is required: without it the browser refuses the request
// with "TypeError: Failed to fetch" and the app queues forever.
function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON)
    .setHeaders({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
}