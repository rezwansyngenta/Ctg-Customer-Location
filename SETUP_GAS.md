# Google Apps Script & Google Sheets Setup

This guide walks you through setting up the backend (Google Apps Script) and storage (Google Sheets) for the Customer Pinpoint Location app.

## 1) Prepare Google Sheets

1. Go to [sheets.google.com](https://sheets.google.com) and create a new Google Sheet.
2. Rename the first sheet to `Customers`.
3. Rename the second sheet to `Submissions` (add a new sheet tab).
4. Import customers from `Ctg Customer List.xlsx` into the `Customers` sheet.

### Customers sheet columns

Add/confirm these columns (order doesn't strictly matter; the code looks up by header name):

| Column | Type | Notes |
|---|---|---|
| `BP_ID` | **Plain text** | Unique business partner ID (required for validation). See the warning below. |
| `Customer_Name` | Text | Customer name (copied to submissions on validation). |
| `Street_Address` | Text | Full address as in Excel (combined). The code returns this for confirmation. |
| `Market_Place` | Text | (Optional) From Excel. |
| `Postal_Area` | Text | (Optional) From Excel. |
| `Upazilla` | Text | (Optional) From Excel. |
| `District` | Text | (Optional) From Excel. |
| `Status` | Text | Optional. Anything other than `Active`, `1`, `true` or `yes` marks the customer inactive and their submissions are rejected. A blank cell, or no `Status` column at all, counts as active. |
| `Invite_Token` | Text | (Optional, recommended) Customer-specific token for stronger identity verification. If used, validate on server in `submitLocation`. |

`Status` is optional; leave it blank unless you want to pause a specific customer. The sample data shows BP IDs like 21137284 etc.; keep them as-is.

> **Set `BP_ID` to Plain text before importing.** In Google Sheets, select the `BP_ID` column, then `Format > Number > Plain text`, *then* paste. If the column is formatted as a number, Sheets strips leading zeros (so `0071234` becomes `71234`) and every typed ID with a leading zero silently fails validation. Do this before the import, not after: reformatting afterwards will not restore digits Sheets already dropped.

### Submissions sheet

The script auto-creates headers on first submission. Headers include: `Submission_ID`, `Local_ID`, `BP_ID`, `Customer_Name`, `Captured_At`, `Submitted_At`, `Lat`, `Lon`, `Accuracy_m`, `Accuracy_Flag`, `Device_ID`, `Consent`, `Status`, `Reject_Reason`, `Source`.

You don't need to pre-create these manually; the script handles it.

## 2) Set up Google Apps Script

1. Open your Google Sheet.
2. Go to `Extensions > Apps Script`.
3. Replace the default `Code.gs` content with the contents of `GAS.gs` from this repo.
4. Save the project (name it something like "Customer Pinpoint Location Backend").

## 3) Deploy as Web App

1. In Apps Script, click `Deploy > New deployment`.
2. Click the gear icon next to "Type" and select `Web app`.
3. Fill in deployment details:
   - Description: "Customer location capture backend"
   - Execute as: `Me` (your Google account)
   - Who has access: `Anyone with the link`
4. Click `Deploy`.
5. Authorize the app if prompted (Google will ask for permissions to access the sheet).
6. Copy the **Web App URL** (looks like `https://script.google.com/macros/s/.../exec`). This is your `GAS_URL`.

### Verify the deployment is actually public

Do this before handing the URL to anyone. Open a browser that is **signed out** of Google and paste the `/exec` URL. A signed-out customer must reach the app, not a login page.

Or check the status code:

```bash
curl -i -X POST \
  -H "Content-Type: application/json" \
  -d '{"action":"validateBP","bpId":"21137284"}' \
  <YOUR_EXEC_URL>
```

- `200` with `{"valid":...}` in the body: correct, deployment is public.
- `401`, or an HTML sign-in page: the deployment is not public. Fix via `Deploy > Manage deployments >` edit the deployment (pencil icon) > `Who has access` > `Anyone` > `Save`. Editing access can require a new deployment version.

> **Google Workspace accounts often cannot deploy "Anyone" web apps.** Admins can disable this org-wide, in which case the option is greyed out and the whole Apps Script approach cannot serve public customers. If that happens, the Sheet and script need to be owned by a plain `@gmail.com` account instead. Test this early: it determines whether the backend is viable at all.

## 4) Configure frontend

1. In this project folder, copy `config.example.js` to `config.js`:
   ```bash
   cp config.example.js config.js
   ```
2. Edit `config.js` and set `GAS_URL` to the Web App URL you just copied.
3. (Optional) Adjust `ACCURACY_THRESHOLD` (default 150m) and `GEO_TIMEOUT` (default 30000ms).
4. If you change `ACCURACY_THRESHOLD`, change `ACCURACY_THRESHOLD_M` in `GAS.gs` to match. The two are separate values; the frontend uses its copy to decide whether to warn the customer, and the backend uses its own to set the `Accuracy_Flag` column.

## 5) Test the backend

You can test `validateBP` and `submit` directly with curl (while online).

### Test validateBP
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"action":"validateBP","bpId":"21137284"}' \
  YOUR_GAS_URL
```

With token (if configured):
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"action":"validateBP","bpId":"21137284","token":"YOUR_TOKEN"}' \
  YOUR_GAS_URL
```

Expected: valid true/false with customer details if valid.

### Test submit (example)
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "action":"submit",
    "localId":"test-123",
    "bpId":"21137284",
    "lat":22.3475,
    "lon":91.8123,
    "accuracy":10,
    "capturedAt":"2026-10-05T10:00:00.000Z",
    "deviceId":"device-test-1",
    "consent":true
  }' \
  YOUR_GAS_URL
```

Include `token` if using invitation links:
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "action":"submit",
    "localId":"test-124",
    "bpId":"21137284",
    "lat":22.3475,
    "lon":91.8123,
    "accuracy":10,
    "capturedAt":"2026-10-05T10:00:00.000Z",
    "deviceId":"device-test-1",
    "consent":true,
    "token":"YOUR_TOKEN"
  }' \
  YOUR_GAS_URL
```

Expected: `{"success":true,"submissionId":"SUB-..."}`. Repeating with the same `localId` returns idempotent success and does not add a second row.

> **Always HTTP 200.** Apps Script cannot set status codes, so a rejected submission also comes back as `200`, with `{"success":false,"error":"..."}` in the body. When testing, check the `success` field, not the HTTP status. `curl -i` is still useful, because it distinguishes a real API response from a Google sign-in page.

## 6) Deploy frontend to GitHub Pages

1. Commit all files (including `config.js` with your GAS_URL) to your GitHub repo.
2. Go to repo Settings > Pages.
3. Source: Deploy from a branch (main/master). Folder: `/ (root)` or `/docs` as per your repo structure.
4. Save. GitHub will give you the Pages URL (e.g. `https://username.github.io/repo-name/`).
5. Open the Pages URL **once while online** on your mobile device - this caches the app shell for offline use.

## 7) Stronger security with invitation tokens (recommended)

BP-ID-only validation is weak if BP IDs are guessable or shared. For stronger identity assurance:

This is **already implemented** in the shipped code. To turn it on:

1. In the `Customers` sheet, add an `Invite_Token` column and generate unique tokens per customer (random 12-16 char strings). Leave the cell empty for any customer who should not require a token.
2. Share customer-specific links: `https://username.github.io/repo-name/?bp=21137284&token=ABC123...`

`parseUrlParams()` in `app.js` reads both `bp` and `token` from the query string. `validateBP()` and `submitLocation()` in `GAS.gs` enforce the token and record it in the `Invite_Token_Used` column. If a stored token is missing or mismatched, the backend returns `{valid:false, requiresToken:true}`.

There is **no UI for tokens and no setup cost**: a customer with an empty `Invite_Token` cell never sees one. Identity still rests on the BP ID alone for those customers.

## 8) Troubleshooting

- **"GAS_URL not configured" in app**: Make sure `config.js` exists and `GAS_URL` is set correctly (no trailing spaces).
- **Customers see a Google sign-in page instead of the app**: the deployment is not public. `Deploy > Manage deployments >` edit > `Who has access` > `Anyone`. Verified with a signed-out browser, not your own.
- **Browser console shows a CORS preflight error, or every submission sits in the queue and the sheet stays empty**: two different causes, check them in order.
  1. The deployment is not public. A sign-in HTML page carries no CORS headers, so the preflight fails. `Deploy > Manage deployments >` pencil > `Who has access` > `Anyone`.
  2. `jsonResponse()` in `GAS.gs` is calling a `TextOutput` method that does not exist. `TextOutput` has only `getContent()`, `setMimeType()` and `setContentType()` - no `setHttpHeader`, no `setHeaders`. Calling either throws a `TypeError` and breaks every response. Do not add CORS headers at all: Apps Script sends `Access-Control-Allow-Origin: *` on the POST response by itself.
3. `apiCall()` in `app.js` is sending `Content-Type: application/json`. That is not a CORS-safelisted value, so the browser sends a preflight `OPTIONS` first - and an `OPTIONS` to the deployment answers `text/html` with no CORS headers, so the request never runs. Send `text/plain` instead; the body is still JSON and Apps Script reads `e.postData.contents` either way.

To tell the two apart in the browser console: a failing preflight shows as `OPTIONS ... 200 (text/html)` followed by the POST erroring with `net::ERR_FAILED` and `TypeError: Failed to fetch`.
- **`TypeError: ...is not a function` in the response**: an older `GAS.gs` is still deployed. The error names both the method and the line, so you can tell which version is live. Re-paste the current file and create a new deployment version.
- **Re-check the backend at any time**: open the Web App URL in a browser. A healthy deployment returns JSON with `"success":true` and a `health` block listing your sheet names, the Customers row count, and the active-customer count. An HTML error page means the code itself is broken.
- **"No customer data found"**: the `Customers` tab has headers but zero data rows, or the tab is named something other than `Customers`. The `health` block in the error response says which.
- **BP IDs never validate, but they look right**: `BP_ID` is probably formatted as a number and leading zeros were stripped. See the Plain text note above. The backend also tolerates this at lookup time, but Plain text is still the right fix so your exported reports are correct.
- **A customer is rejected as inactive**: their `Status` cell holds something other than `Active`, `1`, `true` or `yes`. A blank cell and a missing `Status` column both count as active, so an untouched customer list works out of the box.
- **Bengali text shows as empty boxes**: the `fonts/` directory did not deploy, or was not precached. The font is self-hosted on purpose; an offline page cannot reach Google Fonts.
- **First-time offline blocked**: You must open the app while online at least once so the Service Worker can cache files. This is by design.
- **Service Worker never installs**: check `Application > Service Workers` in devtools. The shell is cached entry by entry, so one missing file no longer aborts the install. Confirm all 10 shell entries landed: `index.html`, `style.css`, `app.js`, `manifest.json`, `Syngenta_Logo.svg`, and the four `.woff2` files. `config.js` is intentionally *not* precached, because it is gitignored and only needed while online.
- **Geolocation not working on iOS**: Requires HTTPS (GitHub Pages provides HTTPS). Also ensure location permissions are granted. On some iOS versions, PWA needs to be added to home screen for better persistence.
- **Uploads not happening after close**: This is expected browser behavior. Uploads retry on next page load or when connectivity returns. The UI states this clearly.