'use strict';
// Push alerts for Signal requests, delivered even when the phone is locked:
//   • Web Push for the installed web app (Android Chrome, iPhone Safari 16.4+ from the home screen)
//   • Firebase Cloud Messaging for the Android/iPhone store app, when FCM_SERVICE_ACCOUNT is set
const crypto = require('node:crypto');
const webpush = require('web-push');
const { all, get, run, insert } = require('./db');
const U = require('./util');

// ---------- Keys ----------
// VAPID keys identify this server to browsers' push services. Kept in the settings table under a key
// that the settings API never returns; or set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.
function vapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  const row = get(`SELECT value FROM settings WHERE key = 'push_vapid'`);
  if (row) return JSON.parse(row.value);
  const keys = webpush.generateVAPIDKeys();
  U.setSetting('push_vapid', keys);
  return keys;
}
function contact() {
  const email = U.getSetting('cafe').email;
  return process.env.VAPID_SUBJECT || (email ? `mailto:${email}` : 'mailto:admin@localhost');
}

// ---------- Subscriptions ----------
function subscribe(userId, kind, payload) {
  if (kind === 'web') {
    const s = payload || {};
    if (!s.endpoint || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) throw U.httpError(400, 'Invalid push subscription');
    const data = JSON.stringify({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } });
    run(`INSERT INTO push_subscriptions (user_id, kind, endpoint, data) VALUES (?, 'web', ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, data = excluded.data`, userId, s.endpoint, data);
  } else if (kind === 'fcm') {
    const token = String(payload || '');
    if (token.length < 20 || token.length > 4096) throw U.httpError(400, 'Invalid device token');
    run(`INSERT INTO push_subscriptions (user_id, kind, endpoint, data) VALUES (?, 'fcm', ?, '{}')
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id`, userId, token);
  } else throw U.httpError(400, 'kind must be web or fcm');
  return { ok: true };
}
function unsubscribe(userId, endpoint) { return run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', userId, String(endpoint || '')).changes; }

// ---------- FCM (HTTP v1) ----------
let fcmToken = null;
function fcmAccount() {
  const raw = process.env.FCM_SERVICE_ACCOUNT;
  if (!raw) return null;
  try { return JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')); }
  catch { console.error('[push] FCM_SERVICE_ACCOUNT is not valid JSON (or base64 JSON)'); return null; }
}
async function fcmAccessToken(sa) {
  if (fcmToken && fcmToken.exp > Date.now() + 60e3) return fcmToken.value;
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }), signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`FCM auth failed: HTTP ${res.status}`);
  const j = await res.json();
  fcmToken = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return fcmToken.value;
}
async function sendFcm(sa, token, msg) {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST', headers: { authorization: `Bearer ${await fcmAccessToken(sa)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: {
      token, notification: { title: msg.title, body: msg.body },
      data: { url: msg.url, tag: msg.tag },
      android: { priority: 'high', notification: { tag: msg.tag, channel_id: 'requests', sound: 'default' } },
      apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default', 'thread-id': 'requests' } } },
    } }),
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 404 || res.status === 400) return 'gone';
  if (!res.ok) throw new Error(`FCM send failed: HTTP ${res.status}`);
  return 'ok';
}

// ---------- Sending ----------
/** Send a notification to the given users' phones. Never throws; dead subscriptions are removed. */
async function sendToUsers(userIds, msg) {
  if (!userIds.length) return { sent: 0 };
  const subs = all(`SELECT * FROM push_subscriptions WHERE user_id IN (${userIds.map(() => '?').join(',')})`, ...userIds);
  if (!subs.length) return { sent: 0 };
  const keys = vapid();
  const sa = fcmAccount();
  const body = { title: msg.title, body: msg.body, url: msg.url || '/signal/app', tag: msg.tag || 'signal' };
  let sent = 0;
  await Promise.all(subs.map(async s => {
    try {
      let r = 'ok';
      if (s.kind === 'web') {
        await webpush.sendNotification(JSON.parse(s.data), JSON.stringify(body), { vapidDetails: { subject: contact(), publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 300, urgency: 'high', timeout: 10000 })
          .catch(e => { if (e.statusCode === 404 || e.statusCode === 410) r = 'gone'; else throw e; });
      } else if (s.kind === 'fcm') {
        if (!sa) return;
        r = await sendFcm(sa, s.endpoint, body);
      }
      if (r === 'gone') run('DELETE FROM push_subscriptions WHERE id = ?', s.id);
      else { sent++; run('UPDATE push_subscriptions SET last_ok = ? WHERE id = ?', U.nowIso(), s.id); }
    } catch (e) { console.error('[push]', s.kind, e.message || e); }
  }));
  return { sent };
}

/** Who should hear about a request: on-duty staff for that table's section (or with no section). */
function recipientsFor(branchId, sectionId, level = 0) {
  const onDuty = all(`SELECT ss.user_id, ss.section_id, u.role FROM signal_staff ss JOIN users u ON u.id = ss.user_id
                      WHERE ss.on_duty = 1 AND u.active = 1 AND (u.branch_id IS NULL OR u.branch_id = ?)`, branchId);
  if (level >= 2) {
    const managers = all(`SELECT id FROM users WHERE active = 1 AND role IN ('admin','manager') AND (branch_id IS NULL OR branch_id = ?)`, branchId).map(u => u.id);
    return [...new Set(managers)];
  }
  if (level === 1) return onDuty.map(s => s.user_id);                         // late: the whole floor
  return onDuty.filter(s => !s.section_id || !sectionId || s.section_id === sectionId).map(s => s.user_id);
}

function notifyRequest({ branchId, tableLabel, sectionId, label, requestId, level = 0, minutes = 0 }) {
  const title = level ? `Late: ${tableLabel} · ${label}` : `${tableLabel} · ${label}`;
  const body = level >= 2 ? `Waiting ${minutes} min and nobody has answered.` : level === 1 ? `Waiting ${minutes} min. Can you take it?` : 'Tap to answer.';
  const users = recipientsFor(branchId, sectionId, level);
  sendToUsers(users, { title, body, tag: `req-${requestId}`, url: '/signal/app' }).catch(() => {});
  return users.length;
}

module.exports = { vapid, subscribe, unsubscribe, sendToUsers, recipientsFor, notifyRequest };
