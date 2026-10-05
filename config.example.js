// Copy this file to config.js and fill in the values.
const CONFIG = {
  // Google Apps Script Web App URL (execute as Me, access "Anyone with the link").
  // Verify the deployment is public from a signed-out browser before sharing it;
  // a restricted deployment shows customers a Google sign-in page instead of the app.
  GAS_URL: 'https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec',

  // Accuracy threshold in meters. Readings worse than this are flagged for review
  // in the sheet, and the customer is warned before sending. Submission is still
  // allowed, because a coarse fix beats no fix for route planning.
  // Keep in sync with ACCURACY_THRESHOLD_M in GAS.gs.
  ACCURACY_THRESHOLD: 150,

  // Geolocation timeout in milliseconds
  GEO_TIMEOUT: 30000,

  // Request the GPS chip rather than a cached or wifi-derived fix
  GEO_HIGH_ACCURACY: true,

  // Network request timeout to the Apps Script endpoint, in milliseconds
  API_TIMEOUT: 20000,

  // Retry backoff for queued offline submissions. Each failure multiplies the
  // wait by two, up to RETRY_MAX_MS. Stored per record in IndexedDB.
  RETRY_BASE_MS: 30000,
  RETRY_MAX_MS: 30 * 60 * 1000,

  // Drop a queued submission from the device after this many days without success,
  // so one phone cannot clog its own queue forever.
  PENDING_TTL_DAYS: 30
};

if (typeof module !== 'undefined') {
  module.exports = CONFIG;
}