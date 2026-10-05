// Frontend configuration for Customer Pinpoint Location
// This file is gitignored. config.example.js is the committed template.
const CONFIG = {
  // Google Apps Script Web App URL
  // NOTE: the deployment MUST be shared as "Anyone with the link",
  // otherwise customers get a Google sign-in page instead of the app.
  GAS_URL: 'https://script.google.com/macros/s/AKfycbxfLCZU22A6t5luw4-L-no9ksxCOCyr45gXMiSpnEhCSk0E3Q85gf4YskS9R7fTgdX4_w/exec',

  // Accuracy above this many meters is flagged HIGH_ACCURACY_ISSUE in the sheet.
  // Still allowed to submit, because a coarse fix beats no fix for route planning.
  ACCURACY_THRESHOLD: 150,

  // Geolocation timeout in milliseconds
  GEO_TIMEOUT: 30000,

  // Request the GPS chip rather than a cached/wifi fix
  GEO_HIGH_ACCURACY: true,

  // Network request timeout to the Apps Script endpoint
  API_TIMEOUT: 20000,

  // Retry backoff for queued offline submissions
  RETRY_BASE_MS: 30000,
  RETRY_MAX_MS: 30 * 60 * 1000,
  RETRY_MAX_ATTEMPTS: 20,

  // Drop a queued submission from the device after this long with no success,
  // so one phone cannot clog the queue forever.
  PENDING_TTL_DAYS: 30
};

if (typeof module !== 'undefined') {
  module.exports = CONFIG;
}