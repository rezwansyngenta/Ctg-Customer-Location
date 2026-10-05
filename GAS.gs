// Google Apps Script for Customer Pinpoint Location
// Deploy as Web App: Execute as Me, Access: Anyone with the link

const SHEET_CUSTOMERS = 'Customers';
const SHEET_SUBMISSIONS = 'Submissions';

// Matches CONFIG.ACCURACY_THRESHOLD in the frontend config.js.
const ACCURACY_THRESHOLD_M = 150;

function doPost(e) {
  try {
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);

    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    
    if (!action) {
      return jsonResponse({ success: false, error: 'Missing action' });
    }

    if (action === 'validateBP') {
      return jsonResponse(validateBP(body.bpId, body.token));
    } else if (action === 'submit') {
      return jsonResponse(submitLocation(body));
    } else {
      return jsonResponse({ success: false, error: 'Invalid action' });
    }
  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  } finally {
    try {
      LockService.getScriptLock().releaseLock();
    } catch (e) {}
  }
}

function doGet(e) {
  return jsonResponse({ success: false, error: 'GET method not allowed. Use POST.' });
}

function validateBP(bpId, token) {
  if (!bpId || String(bpId).trim() === '') {
    return { valid: false, error: 'BP ID is required' };
  }
  
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_CUSTOMERS);
  if (!sheet) {
    return { valid: false, error: 'Customers sheet not found' };
  }
  
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    return { valid: false, error: 'No customer data found' };
  }
  
  const headers = data[0];
  const bpIndex = headers.indexOf('BP_ID');
  const nameIndex = headers.indexOf('Customer_Name');
  const addressIndex = headers.indexOf('Street_Address');
  const statusIndex = headers.indexOf('Status');
  const tokenIndex = headers.indexOf('Invite_Token');
  
  const searchBp = String(bpId).trim();
  const providedToken = token ? String(token).trim() : '';
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const bpVal = row[bpIndex] !== undefined && row[bpIndex] !== null ? String(row[bpIndex]).trim() : '';
    if (bpVal === searchBp) {
      const status = statusIndex >= 0 ? String(row[statusIndex] || '').toLowerCase() : 'active';
      if (status && status !== 'active' && status !== '1' && status !== 'true') {
        return { valid: false, error: 'BP ID is inactive', bpId: searchBp };
      }
      // Check token if invite token is configured for this BP
      if (tokenIndex >= 0) {
        const storedToken = row[tokenIndex] !== undefined && row[tokenIndex] !== null ? String(row[tokenIndex]).trim() : '';
        if (storedToken) {
          if (!providedToken) {
            return { valid: false, error: 'Token required for this BP', bpId: searchBp, requiresToken: true };
          }
          if (storedToken !== providedToken) {
            return { valid: false, error: 'Invalid token', bpId: searchBp, requiresToken: true };
          }
        }
        // if storedToken is empty, token not required
      }
      return {
        valid: true,
        bpId: searchBp,
        customerName: nameIndex >= 0 ? row[nameIndex] : '',
        address: addressIndex >= 0 ? row[addressIndex] : ''
      };
    }
  }
  
  return { valid: false, error: 'BP ID not found', bpId: searchBp };
}

function submitLocation(body) {
  // Required fields
  const required = ['localId', 'bpId', 'lat', 'lon', 'accuracy', 'capturedAt', 'deviceId', 'consent'];
  for (let i = 0; i < required.length; i++) {
    if (body[required[i]] === undefined || body[required[i]] === null || body[required[i]] === '') {
      return { success: false, error: 'Missing required field: ' + required[i] };
    }
  }
  
  if (!body.consent) {
    return { success: false, error: 'Consent is required' };
  }
  
  // Validate BP
  const bpValidation = validateBP(body.bpId, body.token);
  if (!bpValidation.valid) {
    return { success: false, error: bpValidation.error, bpId: body.bpId };
  }
  
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_SUBMISSIONS);
  if (!sheet) {
    return { success: false, error: 'Submissions sheet not found' };
  }
  
  // Ensure headers exist
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'Submission_ID',
      'Local_ID',
      'BP_ID',
      'Customer_Name',
      'Captured_At',
      'Submitted_At',
      'Lat',
      'Lon',
      'Accuracy_m',
      'Accuracy_Flag',
      'Device_ID',
      'Consent',
      'Status',
      'Reject_Reason',
      'Source',
      'Invite_Token_Used'
    ]);
  }
  
  // Check for duplicate localId (idempotency)
  const existingData = sheet.getDataRange().getValues();
  const localIdIndex = existingData[0].indexOf('Local_ID');
  const statusIndex = existingData[0].indexOf('Status');
  if (localIdIndex >= 0) {
    for (let i = 1; i < existingData.length; i++) {
      if (String(existingData[i][localIdIndex]) === String(body.localId)) {
        const status = statusIndex >= 0 ? existingData[i][statusIndex] : 'Received';
        if (status === 'Received' || status === 'Duplicate') {
          return {
            success: true,
            message: 'Already received',
            localId: body.localId,
            submissionId: existingData[i][0]
          };
        }
      }
    }
  }
  
  // Coordinate sanity check. Out-of-bounds readings are still recorded
  // (the raw value matters more than rejecting it) but flagged for review,
  // since a bad fix here silently corrupts route planning.
  const lat = parseFloat(body.lat);
  const lon = parseFloat(body.lon);
  const acc = parseFloat(body.accuracy);
  const inBangladesh = lat >= 20 && lat <= 27 && lon >= 88 && lon <= 93;
  const accuracyBad = isNaN(acc) || acc > ACCURACY_THRESHOLD_M;

  let flag = 'OK';
  if (isNaN(lat) || isNaN(lon)) flag = 'INVALID_COORDS';
  else if (!inBangladesh) flag = 'OUT_OF_BOUNDS';
  else if (accuracyBad) flag = 'HIGH_ACCURACY_ISSUE';
  
  const submittedAt = new Date().toISOString();
  const submissionId = 'SUB-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 5).toUpperCase();
  
  const providedToken = body.token ? String(body.token).trim() : '';
  sheet.appendRow([
    submissionId,
    body.localId,
    body.bpId,
    bpValidation.customerName || '',
    body.capturedAt,
    submittedAt,
    lat,
    lon,
    acc,
    flag,
    body.deviceId,
    body.consent ? 'true' : 'false',
    'Received',
    '',
    'web/pwa',
    providedToken || ''
  ]);
  
  return {
    success: true,
    message: 'Submitted successfully',
    localId: body.localId,
    submissionId: submissionId
  };
}

// Apps Script ContentService always replies HTTP 200 â€” it cannot set a
// status code. Callers must read the body's `success` flag, not the
// status line. Every caller therefore drops its code argument.
function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON)
    .setHttpHeader('Access-Control-Allow-Origin', '*')
    .setHttpHeader('Access-Control-Allow-Methods', 'POST')
    .setHttpHeader('Access-Control-Allow-Headers', 'Content-Type');
}