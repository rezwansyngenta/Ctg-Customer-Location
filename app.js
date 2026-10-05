/* ============================================================
   Customer Pinpoint Location — frontend
   Bangla UI. Offline capture via IndexedDB + service worker.
   ============================================================ */

const DB_NAME = 'customerPinpoint';
const DB_VERSION = 1;
const STORE_PENDING = 'pending';

/* Customer steps, for the progress bar */
const STEPS = {
  2: { label: 'ধাপ 1 / 4', pct: 25 },
  4: { label: 'ধাপ 2 / 4', pct: 50 },
  5: { label: 'ধাপ 3 / 4', pct: 75 },
  6: { label: 'ধাপ 4 / 4', pct: 100 }
};

let db = null;
let deviceId = null;
let inviteToken = null;
let currentBp = null;
let captured = null;
let isOnline = navigator.onLine;
let retrying = false;

/* ---------------- bootstrap ---------------- */

document.addEventListener('DOMContentLoaded', async () => {
  parseUrlParams();
  initDeviceId();
  bindEvents();
  paintNetwork();

  try {
    await openDB();
  } catch (e) {
    showFatal('এই ফোনে তথ্য জমা রাখা যাচ্ছে না। অন্য ব্রাউজার বা ফোনে চেষ্টা করুন।');
    return;
  }

  registerSW();
  await sweepExpired();
  await refreshPendingCount();
  await checkEnvironment();
});

function parseUrlParams() {
  try {
    const q = new URLSearchParams(location.search);
    const t = q.get('token');
    if (t) inviteToken = t.trim();
    const bp = q.get('bp');
    if (bp) { const el = $('bp-id'); if (el) el.value = bp.replace(/\D/g, ''); }
  } catch (e) { /* malformed URL, ignore */ }
}

function initDeviceId() {
  deviceId = localStorage.getItem('deviceId');
  if (!deviceId) {
    deviceId = uuid();
    localStorage.setItem('deviceId', deviceId);
  }
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

const $ = id => document.getElementById(id);

/* ---------------- IndexedDB ---------------- */

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE_PENDING)) {
        d.createObjectStore(STORE_PENDING, { keyPath: 'localId' });
      }
    };
    req.onsuccess = () => { db = req.result; res(); };
    req.onerror = () => rej(req.error);
  });
}

function tx(mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction([STORE_PENDING], mode);
    const out = fn(t.objectStore(STORE_PENDING));
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

const dbPut = rec => tx('readwrite', s => s.put(rec));
const dbDel = key => tx('readwrite', s => s.delete(key));
const dbAll = () => tx('readonly', s => s.getAll());

/* Remove a queued record only once the server has acknowledged it */
const ackAndDelete = localId => dbDel(localId);

/* ---------------- service worker ---------------- */

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').catch(e => {
    console.warn('SW registration failed', e);
  });
}

/* ---------------- network state ---------------- */

window.addEventListener('online', () => {
  isOnline = true;
  paintNetwork();
  retryPending();
});
window.addEventListener('offline', () => {
  isOnline = false;
  paintNetwork();
  paintReviewActions();
});

function paintNetwork() {
  const pill = $('pill-network');
  const txt = $('network-text');
  if (isOnline) {
    pill.classList.remove('pill-offline');
    txt.textContent = 'ইন্টারনেট আছে';
  } else {
    pill.classList.add('pill-offline');
    txt.textContent = 'ইন্টারনেট নেই';
  }
}

/* ---------------- routing ---------------- */

function show(n) {
  document.querySelectorAll('.screen').forEach(s => { s.hidden = true; });
  const el = $('screen-' + n);
  if (el) el.hidden = false;

  const step = STEPS[n];
  if (step) {
    $('progress').hidden = false;
    $('step-label').textContent = step.label;
    $('progress-fill').style.width = step.pct + '%';
  } else {
    $('progress').hidden = true;
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function showFatal(text) {
  show(1);
  $('env-message').className = 'msg msg-err msg-lg';
  $('env-message').textContent = text;
  $('btn-retry-env').hidden = false;
}

function resetFlow() {
  currentBp = null;
  captured = null;
  $('bp-id').value = '';
  $('consent-checkbox').checked = false;
  $('confirm-store-checkbox').checked = false;
  clearBpNote();
  paintS4();
  show(2);
  if (isOnline) retryPending();
}

function bindEvents() {
  $('btn-retry-env').addEventListener('click', () => location.reload());
  $('btn-yes-store').addEventListener('click', () => show(4));
  $('btn-no-store').addEventListener('click', () => show(3));
  $('btn-restart').addEventListener('click', resetFlow);
  $('btn-restart-final').addEventListener('click', resetFlow);
  $('btn-capture-another').addEventListener('click', resetFlow);

  $('btn-back-s4').addEventListener('click', () => show(2));
  $('btn-back-s5').addEventListener('click', () => show(4));
  $('btn-back-s6').addEventListener('click', () => show(5));

  $('btn-next-capture').addEventListener('click', () => {
    if (!currentBp) currentBp = { bpId: $('bp-id').value.trim() };
    show(5);
  });
  $('btn-capture-location').addEventListener('click', captureLocation);
  $('btn-confirm-submit').addEventListener('click', () => submit(true));
  $('btn-save-offline').addEventListener('click', () => submit(false));

  const bp = $('bp-id');
  let t;
  bp.addEventListener('input', () => {
    /* keep digits only: paste of "21137284 " would fail validation */
    const clean = bp.value.replace(/\D/g, '');
    if (clean !== bp.value) bp.value = clean;
    clearTimeout(t);
    const v = clean.trim();
    if (!v) { clearBpNote(); paintS4(); return; }
    t = setTimeout(() => validateBp(v), 500);
  });

  $('consent-checkbox').addEventListener('change', paintS4);
  $('confirm-store-checkbox').addEventListener('change', paintS6);
}

function clearBpNote() {
  const n = $('bp-validation-status');
  n.textContent = '';
  n.className = 'field-note';
  $('bp-details').hidden = true;
  currentBp = null;
}

function paintS4() {
  $('btn-next-capture').disabled = !($('bp-id').value.trim() && $('consent-checkbox').checked);
}

function paintS6() {
  const ok = $('confirm-store-checkbox').checked;
  $('btn-confirm-submit').disabled = !ok;
  $('btn-save-offline').disabled = !ok;
  paintReviewActions();
}

function paintReviewActions() {
  const online = isOnline;
  $('btn-confirm-submit').hidden = !online;
  $('btn-save-offline').hidden = online;
}

/* ---------------- BP validation ---------------- */

function setBpNote(text, cls) {
  const n = $('bp-validation-status');
  n.textContent = text;
  n.className = 'field-note ' + cls;
}

async function validateBp(bpId) {
  if (!isOnline) {
    currentBp = { bpId };
    setBpNote('ইন্টারনেট নেই, তাই এখন যাচাই করা যাচ্ছে না।', 'note-info');
    paintS4();
    return;
  }

  setBpNote('যাচাই করা হচ্ছে…', 'note-info');
  try {
    const res = await apiCall({ action: 'validateBP', bpId });
    if (res.valid) {
      currentBp = { bpId: res.bpId, customerName: res.customerName || '', address: res.address || '' };
      $('bp-customer-name').textContent = currentBp.customerName;
      $('bp-address').textContent = currentBp.address;
      $('bp-details').hidden = false;
      setBpNote('বিপি আইডি সঠিক', 'note-ok');
    } else {
      currentBp = null;
      $('bp-details').hidden = true;
      setBpNote(res.error || 'বিপি আইডি সঠিক নয়', 'note-err');
    }
  } catch (e) {
    currentBp = { bpId };
    setBpNote('এখন যাচাই করা যায়নি, পাঠানোর সময় আবার হবে।', 'note-info');
  }
  paintS4();
}

/* ---------------- network call ---------------- */

async function apiCall(payload) {
  if (typeof CONFIG === 'undefined' || !CONFIG.GAS_URL || CONFIG.GAS_URL.indexOf('YOUR_SCRIPT_ID') !== -1) {
    throw new AppError('CONFIG', 'সার্ভার ঠিকানা সেট করা নেই।');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.API_TIMEOUT || 20000);
  try {
    const res = await fetch(CONFIG.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    let data;
    try { data = await res.json(); } catch (e) { throw new AppError('server', 'সার্ভার উত্তর দিতে পারেনি।'); }
    if (!res.ok) throw new AppError('server', (data && data.error) || 'সার্ভার সংরক্ষণ করেনি।');

    /* Apps Script ContentService always answers HTTP 200, even for
       rejections, so the status line cannot be trusted. The body's own
       success flag is the only real signal. validateBP never sets it
       (it reports valid:false instead), so this stays unambiguous. */
    if (data && data.success === false) {
      throw new AppError('server', data.error || 'সার্ভার সংরক্ষণ করেনি।');
    }
    return data;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError('network', 'সংযোগ বিচ্ছিন্ন');
  } finally {
    clearTimeout(timer);
  }
}

/* kind: 'network' → retry later, 'server' → retry only if user retries
   Anything the server rejected on validation will never succeed on a
   blind retry, so it must NOT sit in the queue. */
class AppError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

/* ---------------- geolocation ---------------- */

function captureLocation() {
  const status = $('capture-status');
  const btn = $('btn-capture-location');
  status.className = 'msg msg-info';
  status.innerHTML = '<span class="spinner"></span> আপনার অবস্থান খোঁজা হচ্ছে…';
  btn.disabled = true;

  if (!navigator.geolocation) {
    btn.disabled = false;
    status.className = 'msg msg-err';
    status.textContent = 'এই ফোনে লোকেশন সুবিধা নেই। অন্য ফোনে চেষ্টা করুন।';
    return;
  }

  navigator.geolocation.getCurrentPosition(onFix, onGeoError, {
    enableHighAccuracy: CONFIG.GEO_HIGH_ACCURACY !== false,
    timeout: CONFIG.GEO_TIMEOUT || 30000,
    maximumAge: 0
  });

  function onFix(pos) {
    btn.disabled = false;
    captured = {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      capturedAt: new Date().toISOString()
    };
    paintReview();
    show(6);
  }

  function onGeoError(err) {
    btn.disabled = false;
    status.className = 'msg msg-err msg-lg';
    if (err.code === 1) {
      status.innerHTML = 'লোকেশনের অনুমতি পাওয়া যায়নি।<br>ফোনের সেটিংসে গিয়ে <strong>লোকেশন অনুমতি চালু</strong> করুন, তারপর আবার চেষ্টা করুন।';
    } else if (err.code === 2) {
      status.innerHTML = 'এই মুহূর্তে লোকেশন পাওয়া যাচ্ছে না।<br>খোলা জায়গায় গিয়ে আবার চেষ্টা করুন।';
    } else if (err.code === 3) {
      status.innerHTML = 'লোকেশন নিতে অনেক সময় লেগেছে।<br>আবার চেষ্টা করুন।';
    } else {
      status.textContent = 'লোকেশন নিতে সমস্যা হয়েছে। আবার চেষ্টা করুন।';
    }
  }
}

function paintReview() {
  const bp = currentBp || { bpId: $('bp-id').value.trim() };
  $('review-bp-id').textContent = bp.bpId || '—';
  $('review-customer-name').textContent = bp.customerName || '—';
  $('review-address').textContent = bp.address || '—';

  $('review-lat').textContent = captured.lat.toFixed(6);
  $('review-lon').textContent = captured.lon.toFixed(6);
  const acc = captured.accuracy;
  $('review-accuracy').textContent = (acc >= 0 ? Math.round(acc) + ' মিটার' : 'জানা যায়নি');
  $('review-captured-at').textContent = new Date(captured.capturedAt).toLocaleString('bn-BD');

  const limit = (typeof CONFIG !== 'undefined' && CONFIG.ACCURACY_THRESHOLD != null) ? CONFIG.ACCURACY_THRESHOLD : 150;
  $('accuracy-warning').hidden = !(acc > limit);

  $('confirm-store-checkbox').checked = false;
  paintS6();
}

/* ---------------- submit ---------------- */

async function submit(tryNow) {
  if (!$('confirm-store-checkbox').checked || !captured) return;

  const payload = {
    action: 'submit',
    localId: uuid(),
    bpId: (currentBp && currentBp.bpId) || $('bp-id').value.trim(),
    lat: captured.lat,
    lon: captured.lon,
    accuracy: captured.accuracy,
    capturedAt: captured.capturedAt,
    deviceId,
    consent: true
  };
  if (inviteToken) payload.token = inviteToken;

  if (!tryNow || !isOnline) {
    await enqueue(payload);
    resultPending();
    return;
  }

  paintResult('busy', 'পাঠানো হচ্ছে…', 'সার্ভারের কাছে পৌঁছে যাচ্ছে।');

  try {
    const res = await apiCall(payload);
    if (res && res.success) {
      resultSuccess();
    } else {
      /* Server said no. Queuing this would retry a record that can
         never validate, so surface it and send the customer back. */
      resultRejected((res && res.error) || 'সার্ভার সংরক্ষণ করেনি।');
    }
  } catch (e) {
    if (e.kind === 'network') {
      await enqueue(payload);
      resultPending();
    } else {
      resultRejected(e.message);
    }
  }
}

async function enqueue(payload) {
  const rec = {
    localId: payload.localId,
    bpId: payload.bpId,
    payload,
    createdAt: new Date().toISOString(),
    attempts: 0,
    nextAttemptAt: Date.now(),
    lastError: null
  };
  await dbPut(rec);
  await refreshPendingCount();
}

/* ---------------- retry queue ---------------- */

async function refreshPendingCount() {
  try {
    const all = await dbAll();
    $('pending-text').textContent = 'অপেক্ষমাণ: ' + (all ? all.length : 0);
  } catch (e) { /* count is cosmetic */ }
}

function backoffFor(attempts) {
  const base = (typeof CONFIG !== 'undefined' && CONFIG.RETRY_BASE_MS) || 30000;
  const max = (typeof CONFIG !== 'undefined' && CONFIG.RETRY_MAX_MS) || 1800000;
  return Math.min(base * Math.pow(2, Math.max(0, attempts - 1)), max);
}

/* Drop records the server will never accept, and records old enough
   that keeping them only clutters the phone. */
async function sweepExpired() {
  try {
    const ttl = ((typeof CONFIG !== 'undefined' && CONFIG.PENDING_TTL_DAYS) || 30) * 86400000;
    const all = await dbAll();
    if (!all) return;
    const cutoff = Date.now() - ttl;
    for (const r of all) {
      if (new Date(r.createdAt).getTime() < cutoff) await dbDel(r.localId);
    }
  } catch (e) { /* best effort */ }
}

async function retryPending() {
  if (!isOnline || retrying) return;
  retrying = true;
  try {
    const all = await dbAll();
    if (!all || !all.length) return;
    const now = Date.now();

    for (const rec of all) {
      if (rec.nextAttemptAt && rec.nextAttemptAt > now) continue;

      try {
        const res = await apiCall(rec.payload);
        /* apiCall throws on success:false, so reaching here means the
           server accepted it. Only now is it safe to drop the local copy. */
        if (res && res.success) await ackAndDelete(rec.localId);
      } catch (e) {
        const attempts = (rec.attempts || 0) + 1;
        /* A hard server rejection will fail identically forever, so drop it
           instead of burning the queue on a record that can never land.
           Network blips get a real, persisted exponential backoff. */
        if (e.kind === 'server') {
          await dbDel(rec.localId);
        } else {
          await dbPut(Object.assign({}, rec, {
            attempts,
            nextAttemptAt: Date.now() + backoffFor(attempts),
            lastError: e.message
          }));
        }
      }
    }
  } catch (e) {
    console.warn('retry pass failed', e);
  } finally {
    retrying = false;
    await refreshPendingCount();
  }
}

/* ---------------- result screens ---------------- */

function paintResult(tone, title, body, icon) {
  const set = (toneClass, iconPath) => {
    const ic = $('result-icon');
    ic.className = 'hero-icon ' + toneClass;
    ic.innerHTML = iconPath || ic.innerHTML;
  };
  const OK = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
  const CLOCK = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-2h2zm0-4h-2V7h2z"/></svg>';
  const WARN = '<svg viewBox="0 0 24 24"><path d="M12 2L1 21h22L12 2zm1 15h-2v2h2zm0-4h-2V9h2z"/></svg>';

  if (tone === 'success') {
    set('hero-icon-green', OK);
    $('result-title').textContent = title;
    $('result-message').innerHTML = '<div class="msg msg-ok msg-lg">' + body + '</div>';
  } else if (tone === 'pending') {
    set('hero-icon-amber', CLOCK);
    $('result-title').textContent = title;
    $('result-message').innerHTML = '<div class="msg msg-warn msg-lg">' + body + '</div>';
  } else if (tone === 'error') {
    set('hero-icon-red', WARN);
    $('result-title').textContent = title;
    $('result-message').innerHTML = '<div class="msg msg-err msg-lg">' + body + '</div>';
  } else {
    set('hero-icon-green', OK);
    $('result-title').textContent = title;
    $('result-message').innerHTML = '<div class="msg msg-info msg-lg"><span class="spinner"></span> ' + body + '</div>';
  }
  show(7);
}

function resultSuccess() {
  paintResult('success', 'সফলভাবে জমা হয়েছে',
    'Syngenta আপনার দোকানের লোকেশন পেয়েছে।<br><strong>ধন্যবাদ।</strong>');
}

function resultPending() {
  paintResult('pending', 'এই ফোনে সংরক্ষিত হয়েছে',
    '<strong>এখনো পাঠানো হয়নি।</strong><br>ইন্টারনেট ফিরে এলে নিজে থেকেই পাঠিয়ে দেওয়া হবে।<br><br>তবে ব্রাউজার বন্ধ করে দিলে এই লোকেশন জমা নাও হতে পারে। তাই অ্যাপটি বন্ধ না করে রাখুন।');
}

function resultRejected(reason) {
  paintResult('error', 'জমা হয়নি',
    reason + '<br><br>বিপি আইডি দেখে আবার চেষ্টা করুন।');
}

/* ---------------- environment gate ---------------- */

async function checkEnvironment() {
  const controlled = navigator.serviceWorker && navigator.serviceWorker.controller;

  /* The only genuinely unusable case: no network AND nothing cached.
     Everything else lets the customer keep capturing, because a queued
     fix that arrives late beats no fix at all. */
  if (!isOnline && !controlled) {
    showFatal('এই অ্যাপটি একবার ইন্টারনেট সংযোগসহ খোলা প্রয়োজন।<br><br>সংযোগ ফিরে এলে অ্যাপটি একবার খুলে রাখুন, তারপর ইন্টারনেট ছাড়াই ব্যবহার করতে পারবেন।');
    return;
  }

  show(2);
  retryPending();

  if (!isOnline) return;

  /* Probe the backend so a misconfigured deployment surfaces now rather
     than as a silent queue that never drains. Non-blocking. */
  try {
    await apiCall({ action: 'validateBP', bpId: '__ping__' });
  } catch (e) {
    if (e.kind === 'network') return;
    $('pending-text').textContent = 'সার্ভার সমস্যা';
    console.error('backend probe failed', e.message);
  }
}