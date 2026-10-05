# Customer Pinpoint Location

A mobile-friendly Progressive Web App (PWA) for collecting customer store coordinates while physically at stores, even when there is no internet at the moment of capture. The frontend is hosted on GitHub Pages and the backend runs on Google Apps Script, with data stored in Google Sheets.

## Purpose

Syngenta Chittagong Warehouse needs reliable store coordinates (latitude/longitude) for route planning. Customer records contain Business Partner (BP) ID, customer name, and address details, but no reliable lat/lon. This tool allows customers to capture their location while at their store, with offline support and automatic retry when connectivity returns.

## Key Features

- **Offline capture**: If the page has been loaded and cached while online, customers can capture location without internet. The submission is saved locally (IndexedDB) and uploaded automatically when connectivity returns.
- **Clear status**: The app explicitly distinguishes between "Location saved on this device; waiting to upload" and "Submitted successfully" (only shown after server acknowledgement).
- **PWA**: Installable as an app on mobile devices; works offline after first load.
- **BP validation**: Validates BP ID against the customer list when online (deferred if offline). Supports customer-specific invitation tokens (via URL `?bp=...&token=...`) for stronger identity verification.
- **Idempotent uploads**: Each pending submission has a unique `localId`; the server treats re-tries as idempotent to prevent duplicates.
- **Geolocation safety**: Records actual accuracy (meters), warns on poor readings, and handles permission denial/unavailability/timeouts gracefully.
- **Consent-first**: Location is captured only with explicit consent after confirming the customer is at their store.

## Architecture

- **Frontend (static)**: `index.html`, `style.css`, `app.js`, `sw.js`, `manifest.json`, `config.js`. Deployed to GitHub Pages.
- **Service Worker**: Caches app shell for offline use. First-time offline access is blocked if the app has not been cached.
- **Local storage**: IndexedDB (`pending` store) for offline submissions (BP ID, coordinates, accuracy, timestamps, device ID, `localId`, consent).
- **Backend**: Google Apps Script Web App (`doPost`) with actions `validateBP` and `submit`.
- **Storage**: Google Sheets with `Customers` (master list for validation) and `Submissions` (append-only log with server acknowledgements).
- **Fonts**: Hind Siliguri is self-hosted in `fonts/` (Bengali + Latin subsets, weights 400 and 700, ~163 KB). Self-hosted rather than loaded from Google Fonts because an offline page cannot reach `fonts.googleapis.com`, and many low-end Chinese Android ROMs ship no Bengali system font, which would render the entire UI as blank boxes.
- **Branding**: Syngenta green `#019934` and wordmark navy `#010066`, sampled from `Syngenta_Logo.svg`. Logo is bundled and served from cache.

## Backend Response Contract

**Google Apps Script `ContentService` always replies with HTTP 200.** It cannot set a status code. A rejected submission arrives as `200 OK` with `{ success: false, error: ... }` in the body.

Therefore, in `app.js`:

- `apiCall()` throws `AppError('server')` when the body's `success` is explicitly `false`, and `AppError('network')` when `fetch` itself fails.
- `validateBP` never sets `success`; it reports `valid: false` instead, so the two signals stay unambiguous.
- A `network` error is transient: the record is kept with a persisted exponential backoff (`attempts`, `nextAttemptAt`).
- A `server` error is permanent **only for record-level rejections** - the codes listed in `PERMANENT_CODES` (`BP_NOT_FOUND`, `BP_INACTIVE`, `NO_CONSENT`, and friends). Those records are dropped. Every other server failure, including `SERVER_ERROR`, `BAD_JSON` and the sheet-level faults (`BAD_HEADERS`, `CUSTOMERS_EMPTY`, `NO_CUSTOMERS_SHEET`), is treated as Syngenta's problem to fix, so the record stays queued and retries. Losing a customer's location to a transient Apps Script timeout is worse than a queue that is briefly longer.

Do not "simplify" this by trusting `response.ok`. It is always true.

### `errorCode`, and why English never reaches the screen

Every rejection carries a stable machine code alongside the human-readable `error` text:

```json
{ "success": false, "errorCode": "BP_NOT_FOUND", "error": "BP ID not found", "bpId": "12345678" }
```

`error` is English because it is what appears in Apps Script execution logs for whoever debugs the backend. The customer never reads it. `app.js` maps `errorCode` through `BANGLA_REASONS` and renders only the Bangla string; an unmapped code falls back to a generic Bangla line rather than leaking English onto the screen. When adding a new `errorCode` to `GAS.gs`, add the Bangla line to `BANGLA_REASONS` too.

### CORS

`jsonResponse()` in `GAS.gs` uses `.setHeaders({...})` to send `Access-Control-Allow-Origin: *`, and `doOptions` handles the preflight. This is not optional and not cosmetic. Without it the browser rejects the request before it reaches `doPost`, `fetch` rejects with `TypeError: Failed to fetch`, the app classifies that as a network fault, and every submission queues on the phone forever while the sheet stays empty.

Note that `TextOutput` has **no** `setHttpHeader` method. Calling it throws a `TypeError` and breaks every response. Use `setHeaders`. Do not also assume Apps Script adds CORS headers on its own - verified absent on this deployment.

## Important Constraints

- **First-time offline is not possible**: The page must be loaded and its files cached while online before offline use. If opened for the first time while offline, the app shows a blocking message.
- **Background upload after closing browser is not promised**: Browser support varies. Uploads are retried when the page is opened again or when connectivity returns (via `online` event). The UI clearly states this.
- **BP validation without full list download**: The client never downloads the entire customer list. Validation happens server-side when online (either at confirmation time or during retry).
- **Acknowledgement required**: The local pending copy is removed only after the server returns `{ success: true }`. "Submitted successfully" is shown only then. See the response contract above: the HTTP status line cannot be used for this.
- **Deployment access must be public**: the Web App must be shared as "Anyone with the link". If it is restricted, customers see a Google sign-in page instead of the app, and the local queue never drains.
- **BP_ID must be Plain text**: if Sheets stores `BP_ID` as a number, leading zeros are stripped and typed IDs stop matching the customer list.

## Prerequisites

1. GitHub account (for GitHub Pages hosting)
2. Google account (for Google Sheets and Google Apps Script)
3. The `Ctg Customer List.xlsx` file (provided)

## Quick Start

1. **Prepare Google Sheets**
   - Create a Google Sheet. Add two sheets: `Customers` and `Submissions`.
   - Import customers from `Ctg Customer List.xlsx` into `Customers`. See `SETUP_GAS.md` for column details.

2. **Deploy Google Apps Script**
   - Create a bound GAS project for the sheet, implement the backend (see `GAS.gs`), deploy as Web App with: Execute as "Me", Access: "Anyone with the link". Copy the Web App URL.

3. **Configure frontend**
   - Copy `config.example.js` to `config.js`.
   - Set `GAS_URL` to the Web App URL.
   - Adjust `ACCURACY_THRESHOLD` (meters) and `GEO_TIMEOUT` (ms) if needed.

4. **Deploy to GitHub Pages**
   - Commit all files to GitHub (root or `/docs`). Enable Pages in repo settings.
   - Open the deployed URL once while online to cache the app shell.

See `SETUP_GAS.md` for detailed setup instructions.

## Mobile UI Notes

- Primary action sits in a `position: sticky` bottom bar so it stays under the thumb when the on-screen keyboard shrinks the viewport.
- Base font 17px, line-height 1.75 (Bengali matras extend above and below the baseline and get clipped at tighter leading). Buttons are 56px tall; the minimum tap target anywhere is 52px.
- Viewport is `width=device-width, initial-scale=1.0, viewport-fit=cover`. **No `user-scalable=no`**: pinch zoom is an accessibility requirement, particularly for older users.
- `env(safe-area-inset-*)` is applied for notched phones.
- `viewport.width <= 360px` tightens padding and type sizes.
- The whole UI is Bengali script. No English toggle: the target audience is exactly the customers who cannot read Roman Bangla.

## Bangla Copy Needs Proofreading

All user-facing strings are Bangla drafted by the developer. Before field use, a native speaker should read every string aloud to a real customer. Strings live in `index.html` (labels, headings, static copy) and `app.js` (`resultSuccess`, `resultPending`, `resultRejected`, geolocation error branches, status pills). Centralising them into one dictionary would make a single proofreading pass easier.

## Testing Checklist

- [ ] First load online - app caches assets (SW installed)
- [ ] Open offline after cache - UI works, can capture location
- [ ] First-time offline (no cache) - blocked with clear message
- [ ] Capture offline → saved to IndexedDB, shows "saved on this device; waiting to upload"
- [ ] Go online → pending submissions auto-upload and clear after ack; shows "Submitted successfully"
- [ ] Close browser after saving offline, reopen later online → auto-retry uploads
- [ ] Geolocation: permission denied, unavailable, timeout handled gracefully
- [ ] Poor accuracy (> threshold) shown as warning; submission still allowed (flagged)
- [ ] Consent required before capture/submit
- [ ] Duplicate retry returns idempotent ack (no duplicate rows)
- [ ] BP validation online works; deferred when offline

## Known Limitations

- Background upload after browser close is not guaranteed (varies by browser/iOS). This is explicitly stated to users.
- Geolocation without internet depends on device/GPS; accuracy varies and is recorded.
- GAS has execution quotas; adequate for typical warehouse collection volumes.
- BP-ID-only verification is weak if BP IDs are guessable/shared. For stronger identity assurance, use customer-specific invitation links with tokens (see `SETUP_GAS.md`).

## License

Internal use - Syngenta Chittagong Warehouse project.