'use strict';
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { all, get, run, insert } = require('./db');

// ---------- Settings ----------
const DEFAULT_SETTINGS = {
  cafe: { name: 'Pixberry Café', logo_url: '', address: '', phone: '', email: '', gstin: '', website: '' },
  public_url: '',                       // e.g. https://order.mycafe.in (used inside QR codes); blank = request host
  timezone: 'Asia/Kolkata',
  currency: { code: 'INR', symbol: '₹' },
  tax: { enabled: true, mode: 'exclusive', rate: 5, label: 'GST', split: true }, // split => CGST + SGST halves
  service_charge: { enabled: false, percent: 5, dine_in_only: true },
  rounding: true,                       // round bill to nearest whole currency unit
  hours: {                              // per weekday 0=Sun..6=Sat
    0: { open: '08:00', close: '22:00', closed: false }, 1: { open: '08:00', close: '22:00', closed: false },
    2: { open: '08:00', close: '22:00', closed: false }, 3: { open: '08:00', close: '22:00', closed: false },
    4: { open: '08:00', close: '22:00', closed: false }, 5: { open: '08:00', close: '23:00', closed: false },
    6: { open: '08:00', close: '23:00', closed: false },
  },
  enforce_hours_for_qr: false,          // block QR orders outside opening hours
  holidays: [],                         // ["2026-12-25", ...]
  receipt: { header: 'Thank you for visiting!', footer: 'Visit again ☕', show_logo: true, show_gstin: true, paper: '80mm' },
  order_status_labels: { new: 'New', preparing: 'Preparing', ready: 'Ready', served: 'Served' },
  kds: { delay_minutes: 15, sound: true },
  payment_methods: ['cash', 'upi', 'card', 'wallet'],
  loyalty: { enabled: true, points_per_100: 5, point_value: 100 }, // 5 pts per ₹100; 1 pt = ₹1 (100 paise)
  notifications: { customer_ready: true, low_stock: true, delayed_orders: true, digital_receipts: true },
  messaging: {
    whatsapp: { enabled: false, webhook_url: '', token: '' },
    sms: { enabled: false, webhook_url: '', token: '' },
    email: { enabled: false, webhook_url: '', token: '', from: '' },
  },
  permissions: null,                    // role -> [permissions]; null = defaults
  backup: { enabled: true, keep_days: 14 },
};

function getSetting(key) {
  if (key === 'public_url') { // Settings value wins; otherwise PUBLIC_URL from the environment (set when hosting)
    const r = get('SELECT value FROM settings WHERE key = ?', key);
    const v = r ? JSON.parse(r.value) : '';
    return (v || process.env.PUBLIC_URL || '').replace(/\/$/, '');
  }
  const r = get('SELECT value FROM settings WHERE key = ?', key);
  if (!r) return structuredClone(DEFAULT_SETTINGS[key]);
  const v = JSON.parse(r.value);
  const d = DEFAULT_SETTINGS[key];
  if (d && typeof d === 'object' && !Array.isArray(d) && v && typeof v === 'object' && !Array.isArray(v)) return { ...structuredClone(d), ...v };
  return v;
}
function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}
function allSettings() {
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = getSetting(k);
  return out;
}

// ---------- Geo ----------
// Great-circle distance in metres (haversine).
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371008.8;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Decide whether a customer's reported position allows a QR order at this branch.
 * Returns { allowed, reason, distance_m, radius_m, code }.
 */
function checkGeofence(branch, loc) {
  if (!branch.geofence_enabled) return { allowed: true, code: 'disabled', radius_m: branch.radius_m };
  if (branch.lat == null || branch.lng == null) {
    return { allowed: false, code: 'not_configured', radius_m: branch.radius_m, reason: 'Ordering is unavailable: the café location has not been set up yet. Please ask the staff.' };
  }
  const lat = Number(loc?.lat), lng = Number(loc?.lng), acc = Number(loc?.accuracy ?? 0);
  if (!loc || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return { allowed: false, code: 'location_required', radius_m: branch.radius_m, reason: 'Please allow location access so we can confirm you are at the café.' };
  }
  if (Number.isFinite(acc) && acc > branch.max_accuracy_m) {
    return { allowed: false, code: 'low_accuracy', radius_m: branch.radius_m, accuracy_m: Math.round(acc), reason: `Your location is too imprecise (±${Math.round(acc)} m). Turn on precise location / GPS and try again.` };
  }
  const d = distanceMeters(lat, lng, branch.lat, branch.lng);
  const slack = Math.min(Number.isFinite(acc) ? acc : 0, branch.accuracy_tolerance_m);
  const allowed = d - slack <= branch.radius_m;
  return {
    allowed, code: allowed ? 'inside' : 'outside',
    distance_m: Math.round(d), radius_m: branch.radius_m,
    reason: allowed ? null : `You appear to be about ${formatDistance(d)} from the café. Orders can only be placed within ${branch.radius_m} m of the café.`,
  };
}
function formatDistance(m) { return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`; }

// ---------- Time ----------
function nowIso() { return new Date().toISOString(); }
function localParts(date = new Date(), tz = getSetting('timezone')) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  const hh = p.hour === '24' ? '00' : p.hour;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hh}:${p.minute}`, dow };
}
// Offset (minutes) of the café timezone from UTC right now — used to group reports by local day in SQL.
function tzOffsetMinutes(tz = getSetting('timezone'), date = new Date()) {
  const lp = localParts(date, tz);
  const asUtc = Date.UTC(+lp.date.slice(0, 4), +lp.date.slice(5, 7) - 1, +lp.date.slice(8, 10), +lp.time.slice(0, 2), +lp.time.slice(3, 5));
  return Math.round((asUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000);
}
function inWindow(time, from, to) {
  if (!from || !to) return true;
  return from <= to ? time >= from && time <= to : time >= from || time <= to; // handles overnight windows
}
function isOpenNow() {
  const lp = localParts();
  const holidays = getSetting('holidays') || [];
  if (holidays.includes(lp.date)) return { open: false, reason: 'The café is closed today for a holiday.' };
  const h = (getSetting('hours') || {})[lp.dow];
  if (!h || h.closed) return { open: false, reason: 'The café is closed today.' };
  if (!inWindow(lp.time, h.open, h.close)) return { open: false, reason: `We're open ${h.open}–${h.close} today.` };
  return { open: true };
}
function itemScheduledNow(it, lp = localParts()) {
  if (it.available_days) {
    const days = String(it.available_days).split(',').map(s => s.trim()).filter(Boolean).map(Number);
    if (days.length && !days.includes(lp.dow)) return false;
  }
  return inWindow(lp.time, it.available_from, it.available_to);
}

// ---------- Ids ----------
function token(bytes = 18) { return crypto.randomBytes(bytes).toString('base64url'); }

// ---------- Realtime bus (Server-Sent Events) ----------
const bus = new EventEmitter();
bus.setMaxListeners(1000);
function emit(type, data = {}) { bus.emit('event', { type, data, at: nowIso() }); }

// ---------- Audit ----------
function audit(user, action, entity, entityId, details) {
  insert('audit_log', { user_id: user?.id ?? null, user_name: user?.name ?? 'system', action, entity, entity_id: entityId ?? null, details: details ? JSON.stringify(details) : null });
}

// ---------- Notifications ----------
function notify({ branch_id = null, audience = 'staff', type, message, ref = null }) {
  const id = insert('notifications', { branch_id, audience, type, message, ref });
  emit('notification', { id, branch_id, audience, type, message, ref });
  return id;
}

// ---------- Outbound messages (WhatsApp / SMS / email) ----------
// Messages go to the outbox. If a channel is connected (enabled + webhook URL), a worker POSTs
// {to, subject, body} to that webhook (your WhatsApp BSP, SMS gateway or email relay). Otherwise
// the message is kept with status "skipped" so staff can see what would have been sent.
function queueMessage(channel, recipient, body, subject = '') {
  if (!recipient) return null;
  const cfg = (getSetting('messaging') || {})[channel] || {};
  const connected = cfg.enabled && cfg.webhook_url;
  return insert('outbox', { channel, recipient, subject, body, status: connected ? 'queued' : 'skipped', error: connected ? null : 'Channel not connected' });
}
async function flushOutbox() {
  const rows = all(`SELECT * FROM outbox WHERE status = 'queued' ORDER BY id LIMIT 20`);
  const messaging = getSetting('messaging') || {};
  for (const m of rows) {
    const cfg = messaging[m.channel] || {};
    if (!cfg.enabled || !cfg.webhook_url) { run(`UPDATE outbox SET status='skipped', error='Channel not connected' WHERE id=?`, m.id); continue; }
    try {
      const res = await fetch(cfg.webhook_url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) },
        body: JSON.stringify({ channel: m.channel, to: m.recipient, subject: m.subject, body: m.body, from: cfg.from || undefined }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      run(`UPDATE outbox SET status='sent', sent_at=?, error=NULL WHERE id=?`, nowIso(), m.id);
    } catch (e) {
      run(`UPDATE outbox SET status='failed', error=? WHERE id=?`, String(e.message || e), m.id);
    }
  }
}
// Send to a customer on whichever channels are connected (WhatsApp preferred, then SMS; email separately).
function messageCustomer({ phone, email }, body, subject = '') {
  const m = getSetting('messaging') || {};
  if (phone) {
    if (m.whatsapp?.enabled) queueMessage('whatsapp', phone, body, subject);
    else if (m.sms?.enabled) queueMessage('sms', phone, body, subject);
    else queueMessage('whatsapp', phone, body, subject); // recorded as skipped
  }
  if (email && m.email?.enabled) queueMessage('email', email, body, subject);
}

// ---------- Money ----------
function money(paise) {
  const c = getSetting('currency');
  const v = (Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${c.symbol}${v}`;
}
function toPaise(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw httpError(400, `Invalid amount: ${v}`);
  return Math.round(n * 100);
}

function httpError(status, message, extra) { const e = new Error(message); e.status = status; if (extra) e.extra = extra; return e; }

module.exports = {
  DEFAULT_SETTINGS, getSetting, setSetting, allSettings,
  distanceMeters, checkGeofence, formatDistance,
  nowIso, localParts, tzOffsetMinutes, inWindow, isOpenNow, itemScheduledNow,
  token, bus, emit, audit, notify, queueMessage, flushOutbox, messageCustomer,
  money, toPaise, httpError,
};
