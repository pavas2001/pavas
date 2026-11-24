// Pixberry Signal — staff phone app (waiters and managers). Install it from the browser menu ("Add to home screen").
import { esc, $, toast, store, money } from '/assets/lib.js';
import { session, api, loadMe, renderLogin, connectEvents, can, logout } from '/assets/staff.js';
import { T, TYPES, COLORS, tile, syncClock, ageS, mmss, shortLabel, chimeFor, unlockAudio } from '/signal/common.js';

const l = T.en;
const S = { tab: store.get('pb.sapp.tab', 'req'), scope: store.get('pb.sapp.scope', 'mine'), board: null, devices: [], known: null, sheet: null, newKey: null, sound: store.get('pb.sapp.sound', true) };
const TABS = [
  ['req', 'Requests', '<path d="M6 8a6 6 0 0 1 12 0c0 6 3 8 3 8H3s3-2 3-8M10 20a2 2 0 0 0 4 0"/>'],
  ['floor', 'Floor', '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>'],
  ['cubes', 'Cubes', '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12L4 7.5M12 12v9"/>'],
  ['ins', 'Insights', '<path d="M4 20V11M10 20V5M16 20v-6M21 20H3"/>'],
  ['shift', 'Shift', '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'],
];
const svg = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;

// This device can be set up as the counter display instead (Shift › Use as counter display)
if (store.get('pb.device.mode') === 'display') location.replace('/signal');

async function start() {
  if (!session.token) return renderLogin($('#login'), 'Signal · staff app', start);
  try { await loadMe(); } catch { return renderLogin($('#login'), 'Signal · staff app', start); }
  $('#app').hidden = false;
  addEventListener('pointerdown', unlockAudio, { once: true });
  connectEvents(type => { if (['signal.updated', 'table.updated', 'order.created', 'order.updated'].includes(type)) load(); });
  setInterval(tick, 1000);
  setInterval(load, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  await load();
  if (store.get('pb.sapp.push')) enablePush({ quiet: true });  // keep this phone's alerts linked to whoever is signed in
}

// ---------- Lock-screen alerts ----------
const native = () => !!window.Capacitor?.isNativePlatform?.();
const pushState = () => {
  if (native()) return store.get('pb.sapp.push') ? 'on' : 'off';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  return store.get('pb.sapp.push') && Notification.permission === 'granted' ? 'on' : 'off';
};
function b64ToBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}
async function enablePush({ quiet = false } = {}) {
  try {
    if (native()) {
      const P = window.Capacitor.Plugins.PushNotifications;
      if (!P) throw new Error('This app version has no push support.');
      let perm = await P.checkPermissions();
      if (perm.receive !== 'granted' && !quiet) perm = await P.requestPermissions();
      if (perm.receive !== 'granted') throw new Error('Notifications are turned off for Pixberry Signal in phone settings.');
      await P.createChannel?.({ id: 'requests', name: 'Table requests', importance: 5, sound: 'default', vibration: true }).catch(() => {});
      await new Promise((resolve, reject) => {
        P.addListener('registration', async t => { try { await api('POST', '/signal/push/subscribe', { kind: 'fcm', token: t.value }); resolve(); } catch (e) { reject(e); } });
        P.addListener('registrationError', e => reject(new Error(e.error || 'Could not register for alerts')));
        P.addListener('pushNotificationActionPerformed', () => { S.tab = 'req'; load(); });
        P.register();
      });
    } else {
      if (pushState() === 'unsupported') throw new Error(/iPhone|iPad/.test(navigator.userAgent) ? 'On iPhone, first add this app to your Home Screen (Share › Add to Home Screen), then open it from there.' : 'This browser can\'t show alerts. Use Chrome on Android.');
      const perm = quiet ? Notification.permission : await Notification.requestPermission();
      if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Alerts are blocked. Allow notifications for this site in the browser settings.' : 'Alerts were not allowed.');
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const { publicKey } = await api('GET', '/signal/push/key');
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
      }
      await api('POST', '/signal/push/subscribe', { kind: 'web', subscription: sub.toJSON() });
    }
    store.set('pb.sapp.push', true);
    if (!quiet) toast('Lock-screen alerts are on for this phone', 'ok');
  } catch (e) { if (!quiet) toast(e.message, 'bad'); }
  if (S.board) render();
}
async function disablePush() {
  try {
    if (!native()) {
      const reg = await navigator.serviceWorker?.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) { await api('POST', '/signal/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
    }
  } catch { /* ignore */ }
  store.del('pb.sapp.push');
  render();
}

const me = () => S.board?.me || {};
const mySection = () => me().section_id;
const inMyZone = r => !mySection() || r.section_id === mySection();

let loading = false, again = false;
async function load() {
  if (loading) { again = true; return; }
  loading = true;
  try {
    const b = await api('GET', '/signal/board');
    syncClock(b.now);
    const prev = S.known;
    S.known = new Set(b.requests.map(r => r.id));
    S.board = b;
    if (S.tab === 'cubes') S.devices = await api('GET', '/signal/devices');
    if (prev && me().on_duty) {
      const fresh = b.requests.filter(r => !prev.has(r.id) && inMyZone(r));
      if (fresh.length) alertNew(fresh[0]);
    }
    render();
  } catch (e) { toast(e.message, 'bad'); }
  finally { loading = false; if (again) { again = false; load(); } }
}

function alertNew(r) {
  const title = `${r.table_label} · ${l[r.type] || r.label}`;
  const sub = `${r.section_name || 'Floor'} · just now`;
  if (S.sound) chimeFor(r.type);
  try { navigator.vibrate?.([120, 60, 120]); } catch { /* ignore */ }
  if (document.hidden && pushState() !== 'on' && 'Notification' in window && Notification.permission === 'granted') {
    navigator.serviceWorker?.getRegistration().then(reg => reg ? reg.showNotification(title, { body: sub, tag: `req-${r.id}`, icon: '/assets/icon.svg' }) : new Notification(title, { body: sub }))
      .catch(() => { try { new Notification(title, { body: sub }); } catch { /* ignore */ } });
  }
  const o = $('#overlay');
  const el = document.createElement('div');
  el.className = 'banner';
  el.innerHTML = `${tile(r.type)}<span>${esc(title)}<small>${esc(sub)}</small></span>`;
  o.append(el);
  setTimeout(() => el.remove(), 4000);
}

function tick() {
  if (!S.board) return;
  const lim = S.board.settings.escalate_after_s;
  if (S.board.requests.some(r => !r.claimed_by && !r.late && ageS(r.created_at) >= lim)) {
    S.board.requests.forEach(r => { if (!r.claimed_by && ageS(r.created_at) >= lim) r.late = true; });
    render(); return;
  }
  document.querySelectorAll('[data-age]').forEach(el => { el.textContent = mmss(ageS(el.dataset.age)); });
}

function render() {
  const b = S.board, m = me();
  const titles = { req: 'Requests', floor: 'Floor', cubes: 'Cubes', ins: 'Insights', shift: 'Shift' };
  const zoneName = b.sections.find(s => s.id === m.section_id)?.name;
  $('#top').innerHTML = `<div class="row"><h1>${titles[S.tab]}</h1><button class="duty ${m.on_duty ? '' : 'off'}" data-a="duty"><i></i>${m.on_duty ? `On duty${zoneName ? ` · ${esc(zoneName)}` : ''}` : 'Off duty'}</button></div>
    ${S.tab === 'req' ? `<div class="seg"><button data-a="scope" data-v="mine" aria-pressed="${S.scope === 'mine'}">${zoneName ? esc(zoneName) : 'My zone'}</button><button data-a="scope" data-v="all" aria-pressed="${S.scope === 'all'}">All tables</button></div>` : ''}`;
  const mine = b.requests.filter(r => inMyZone(r) && !r.claimed_by).length;
  $('#tabs').innerHTML = TABS.map(([k, n, p]) => `<button data-a="tab" data-v="${k}" ${S.tab === k ? 'aria-current="page"' : ''}>${svg(p)}${n}${k === 'req' && mine ? `<span class="badge">${mine}</span>` : ''}${k === 'cubes' && b.device_problems ? '<span class="badge">!</span>' : ''}</button>`).join('');
  const c = $('#content'), top = c.scrollTop;
  c.innerHTML = { req: reqTab, floor: floorTab, cubes: cubesTab, ins: insTab, shift: shiftTab }[S.tab]();
  c.scrollTop = top;
  drawSheet();
}

function reqCard(r) {
  const mineClaim = r.claimed_by === me().user_id;
  const sub = r.claimed_by ? `${mineClaim ? 'You are' : `${esc(r.claimed_by_name)} is`} on the way` : r.late ? '<span class="lt">Late · whole floor alerted</span>' : `${esc(r.section_name || 'Floor')} · ${r.source === 'cube' ? 'Cube' : r.source === 'qr' ? 'QR' : 'Staff'}`;
  const btn = r.claimed_by && !mineClaim ? '' : `<button class="act ${mineClaim ? 'done' : ''}" data-a="${mineClaim ? 'done' : 'claim'}" data-id="${r.id}">${mineClaim ? 'Done' : 'On my way'}</button>`;
  return `<div class="rq ${r.late && !r.claimed_by ? 'late' : ''} ${r.claimed_by ? 'claimed' : ''}">${tile(r.type)}
    <span><b>${esc(r.table_label)} · ${esc(l[r.type] || r.label)}</b><small>${sub}${r.note ? ` · “${esc(r.note)}”` : ''}</small></span>
    <span class="r"><span class="age" data-age="${esc(r.created_at)}">${mmss(ageS(r.created_at))}</span>${btn}</span></div>`;
}
function reqTab() {
  const list = S.board.requests.filter(r => S.scope === 'all' || inMyZone(r));
  if (!me().on_duty) return `<div class="empty">You're off duty, so you won't get alerts.<br><br><button class="btn2 pri" data-a="duty">Go on duty</button></div>${list.map(reqCard).join('')}`;
  return list.length ? list.map(reqCard).join('') : `<div class="empty">Nothing waiting${S.scope === 'mine' && mySection() ? ' in your zone' : ''}. 👍</div>`;
}

function floorTab() {
  const groups = new Map();
  for (const t of S.board.tables) { const k = t.section_name || 'Floor'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
  if (!S.board.tables.length) return '<div class="empty">No tables yet. Add them in the back office under Tables & floor.</div>';
  return [...groups.entries()].map(([name, list]) => `<div class="sect">${esc(name)}</div><div class="map">${list.map(t => {
    const on = t.request_type;
    const info = on ? esc(l[on]) : t.order_id ? `${t.seated_min ?? 0} min · ${money(t.order_total)}` : 'Free';
    return `<button class="tb ${on ? 'on' : ''} ${!on && !t.order_id ? 'free' : ''}" data-a="table" data-id="${t.id}" style="${on ? `background:${COLORS[on]}` : ''}"><b>${shortLabel(t.label)}</b><small>${info}</small></button>`;
  }).join('')}</div>`).join('');
}
function drawSheet() {
  const o = $('#overlay');
  o.querySelectorAll('.scrim,.sheet').forEach(x => x.remove());
  if (S.newKey) {
    o.insertAdjacentHTML('beforeend', `<div class="scrim" data-a="closekey"></div><div class="sheet"><span class="grab"></span>
      <h2 style="margin:0">Cube paired</h2>
      <p style="margin:0;color:var(--p-mut)">Enter this key into the cube during setup. It is shown only once. If it's lost, remove the cube and pair it again.</p>
      <div class="key" id="keytxt">${esc(S.newKey)}</div>
      <div class="kv" style="grid-template-columns:1fr 1fr"><button class="btn2" data-a="copykey">Copy key</button><button class="btn2 pri" data-a="closekey">Done</button></div></div>`);
    return;
  }
  if (!S.sheet) return;
  const t = S.board.tables.find(x => x.id === S.sheet);
  if (!t) { S.sheet = null; return; }
  const r = S.board.requests.find(x => x.table_id === t.id);
  o.insertAdjacentHTML('beforeend', `<div class="scrim" data-a="close"></div><div class="sheet"><span class="grab"></span>
    <div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0">${esc(t.label)}</h2><span class="duty">${esc(t.section_name || 'Floor')}</span></div>
    <div class="kv"><div><small>Status</small><b>${esc({ available: 'Available', ordering: 'Ordering', occupied: 'Occupied', bill_requested: 'Bill requested', cleaning: 'Needs cleaning' }[t.status] || t.status)}</b></div><div><small>Seated</small><b>${t.order_id ? `${t.seated_min ?? 0} min` : '—'}</b></div>
      <div><small>Running bill</small><b>${t.order_id ? money(t.order_total) : '—'}</b></div><div><small>Cube battery</small><b>${t.device_id ? (t.battery != null ? `${t.battery}%` : '—') : 'No cube'}</b></div></div>
    ${r ? reqCard(r) : ''}
    <div class="kv"><button class="btn2" data-a="close">Close</button><a class="btn2 pri" href="/admin#/tables">Open in back office</a></div></div>`);
}

function cubesTab() {
  const m = me();
  const tables = S.board.tables;
  const opts = sel => `<option value="">No table</option>${tables.map(t => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}`;
  const pair = m.can_manage ? `<div class="card"><div class="item" style="display:grid;gap:10px"><span><b>Pair a new cube</b><small>Choose its table. You'll get a key to enter into the cube.</small></span>
      <div class="row2"><select class="sel" id="pairTable">${opts(null)}</select><button class="act" data-a="pair">Pair cube</button></div></div></div>` : '';
  if (!S.devices.length) return `${pair}<div class="empty">No cubes paired yet.</div>`;
  return pair + S.devices.map(d => {
    const warn = d.problems.map(p => ({ offline: 'Offline', off_coaster: 'Off coaster', low_battery: 'Low battery' }[p])).join(' · ');
    const batt = d.battery ?? 0;
    return `<div class="cube ${d.problems.length ? 'bad' : ''}"><div class="h"><b>${d.kind === 'hub' ? 'Signal Hub' : esc(d.table_label || 'No table')}</b><span style="font-variant-numeric:tabular-nums">${d.battery != null ? `${batt}%` : '—'}</span></div>
      <div class="batt"><i class="${batt < 25 ? 'low' : ''}" style="width:${batt}%"></i></div>
      <small class="${warn ? 'warn' : ''}">${warn || `On coaster${d.rssi != null ? ` · signal ${d.rssi} dBm` : ''}`}${d.last_seen ? ` · seen ${mmss(ageS(d.last_seen))} ago` : ''}</small>
      ${m.can_manage ? `<div class="row2"><select class="sel" data-a="move" data-id="${d.id}" aria-label="Table">${opts(d.table_id)}</select><button class="btn2 danger" style="padding:8px 12px" data-a="remove" data-id="${d.id}">Remove</button></div>` : ''}</div>`;
  }).join('');
}

function insTab() {
  const s = S.board.stats;
  const max = Math.max(1, ...TYPES.map(t => s.by_type[t] || 0));
  const smax = Math.max(1, ...s.by_staff.map(x => x.n));
  return `<div class="stats"><div class="stat"><small>Today</small><b>${s.total}</b></div><div class="stat"><small>Avg reply</small><b>${s.avg_response_s != null ? mmss(s.avg_response_s) : '—'}</b></div><div class="stat"><small>Late</small><b>${s.late}</b></div></div>
    <div class="sect">By request</div><div class="bars">${TYPES.map(t => `<div class="bar"><span>${esc(l[t])}</span><span class="track"><i style="width:${(s.by_type[t] || 0) / max * 100}%;background:${COLORS[t]}"></i></span><span>${s.by_type[t] || 0}</span></div>`).join('')}</div>
    <div class="sect">Answered by</div><div class="bars">${s.by_staff.length ? s.by_staff.map(x => `<div class="bar"><span>${esc(x.name)}</span><span class="track"><i style="width:${x.n / smax * 100}%;background:var(--p-accent)"></i></span><span>${x.n}</span></div>`).join('') : '<span style="color:var(--p-mut)">Nobody yet today.</span>'}</div>`;
}

function shiftTab() {
  const m = me(), st = S.board.settings;
  const ps = pushState();
  const pushText = { on: 'On. This phone gets alerts even when it is locked.', off: 'Get alerts for your zone even when the phone is locked', blocked: 'Blocked. Allow notifications for this site in the browser settings.', unsupported: /iPhone|iPad/.test(navigator.userAgent) ? 'Add this app to your Home Screen first, then open it from there.' : 'Not supported in this browser. Use Chrome.' }[ps];
  let h = `<div class="card">
    <div class="item"><span><b>On duty</b><small>Get alerts for your zone</small></span><button class="sw" role="switch" aria-label="On duty" aria-checked="${m.on_duty}" data-a="duty"></button></div>
    <div class="item"><span><b>My zone</b><small>Tables you look after</small></span><span class="chips"><button data-a="zone" data-v="" aria-pressed="${!m.section_id}">All</button>${S.board.sections.map(s => `<button data-a="zone" data-v="${s.id}" aria-pressed="${m.section_id === s.id}">${esc(s.name)}</button>`).join('')}</span></div>
    <div class="item"><span><b>Sound on this phone</b><small>A different chime for each request</small></span><button class="sw" role="switch" aria-label="Sound" aria-checked="${S.sound}" data-a="sound"></button></div>
    <div class="item"><span><b>Lock-screen alerts</b><small>${pushText}</small></span>${ps === 'on' ? '<button class="sw" role="switch" aria-label="Lock-screen alerts" aria-checked="true" data-a="pushoff"></button>' : ps === 'off' ? '<button class="act" data-a="pushon">Turn on</button>' : ''}</div>
    ${ps === 'on' ? '<div class="item"><span><b>Test alert</b><small>Lock the phone, then check it arrives</small></span><button class="act" data-a="pushtest">Send test</button></div>' : ''}
  </div>
  <div class="sect">This device</div><div class="card"><div class="item"><span><b>Use as counter display</b><small>For a tablet or screen at the counter. Switch back from the display's top bar.</small></span><button class="act" data-a="displaymode">Switch</button></div></div>`;
  if (m.can_manage) h += `<div class="sect">Counter display · manager</div><div class="card">
    <div class="item"><span><b>Evening mode</b><small>Resting cubes flicker like a candle</small></span><button class="sw" role="switch" aria-label="Evening mode" aria-checked="${!!st.evening_mode}" data-a="set" data-k="evening_mode"></button></div>
    <div class="item"><span><b>Counter chime</b><small>Sound on the counter display</small></span><button class="sw" role="switch" aria-label="Counter chime" aria-checked="${!!st.chime}" data-a="set" data-k="chime"></button></div>
    <div class="item"><span><b>Display language</b><small>Counter screen only</small></span><span class="chips"><button data-a="lang" data-v="en" aria-pressed="${st.language === 'en'}">English</button><button data-a="lang" data-v="ml" aria-pressed="${st.language === 'ml'}">മലയാളം</button></span></div>
    <div class="item"><span><b>Alert the whole floor after</b><small>Seconds without anyone answering</small></span><input class="num" type="number" inputmode="numeric" min="30" max="3600" id="esc1" value="${st.escalate_after_s}"></div>
    <div class="item"><span><b>Alert the manager after</b><small>Seconds</small></span><input class="num" type="number" inputmode="numeric" min="30" max="3600" id="esc2" value="${st.manager_after_s}"></div>
  </div>`;
  h += `<div class="sect">Account</div><div class="card"><div class="item"><span><b>${esc(session.me.user.name)}</b><small>${esc(session.me.user.role)}</small></span><button class="act" data-a="logout">Sign out</button></div></div>
    <p style="color:var(--p-mut);font-size:13px;margin:4px 2px">Tip: add this app to your home screen from the browser menu so it opens full screen.</p>`;
  return h;
}

async function act(fn) { try { await fn(); } catch (e) { toast(e.message, 'bad'); } await load(); }
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-a]');
  if (!b || b.tagName === 'SELECT') return;
  const a = b.dataset.a;
  if (a === 'tab') { S.tab = b.dataset.v; S.sheet = null; store.set('pb.sapp.tab', S.tab); if (S.tab === 'cubes') S.devices = await api('GET', '/signal/devices').catch(() => []); render(); }
  else if (a === 'scope') { S.scope = b.dataset.v; store.set('pb.sapp.scope', S.scope); render(); }
  else if (a === 'claim' || a === 'done') { b.disabled = true; await act(() => api('POST', `/signal/requests/${b.dataset.id}/${a}`)); }
  else if (a === 'duty') await act(() => api('PUT', '/signal/me', { on_duty: !me().on_duty }));
  else if (a === 'zone') await act(() => api('PUT', '/signal/me', { section_id: b.dataset.v ? Number(b.dataset.v) : null }));
  else if (a === 'sound') { S.sound = !S.sound; store.set('pb.sapp.sound', S.sound); if (S.sound) chimeFor('water'); render(); }
  else if (a === 'pushon') await enablePush();
  else if (a === 'pushoff') await disablePush();
  else if (a === 'pushtest') { try { const r = await api('POST', '/signal/push/test'); toast(r.sent ? 'Test alert sent' : 'No phone is linked yet. Turn alerts on again.', r.sent ? 'ok' : 'bad'); } catch (err) { toast(err.message, 'bad'); } }
  else if (a === 'displaymode') { store.set('pb.device.mode', 'display'); location.href = '/signal'; }
  else if (a === 'set') await act(() => api('PUT', '/signal/settings', { [b.dataset.k]: !S.board.settings[b.dataset.k] }));
  else if (a === 'lang') await act(() => api('PUT', '/signal/settings', { language: b.dataset.v }));
  else if (a === 'table') { S.sheet = Number(b.dataset.id); drawSheet(); }
  else if (a === 'close') { S.sheet = null; drawSheet(); }
  else if (a === 'pair') {
    const tid = $('#pairTable').value;
    try { const r = await api('POST', '/signal/devices', { kind: 'cube', table_id: tid ? Number(tid) : null }); S.newKey = r.key; S.devices = await api('GET', '/signal/devices'); render(); }
    catch (err) { toast(err.message, 'bad'); }
  }
  else if (a === 'copykey') { try { await navigator.clipboard.writeText(S.newKey); toast('Key copied', 'ok'); } catch { const r = document.createRange(); r.selectNodeContents($('#keytxt')); getSelection().removeAllRanges(); getSelection().addRange(r); toast('Key selected. Copy it from the menu.'); } }
  else if (a === 'closekey') { S.newKey = null; drawSheet(); }
  else if (a === 'remove') {
    if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Tap again to remove'; setTimeout(() => { if (b.isConnected) { b.dataset.confirm = ''; b.textContent = 'Remove'; } }, 4000); return; }
    await act(async () => { await api('DELETE', `/signal/devices/${b.dataset.id}`); S.devices = await api('GET', '/signal/devices'); });
  }
  else if (a === 'logout') logout();
});
document.addEventListener('change', async e => {
  const s = e.target.closest('select[data-a="move"]');
  if (s) await act(async () => { await api('PUT', `/signal/devices/${s.dataset.id}`, { table_id: s.value ? Number(s.value) : null }); S.devices = await api('GET', '/signal/devices'); });
  if (e.target.id === 'esc1' || e.target.id === 'esc2') await act(() => api('PUT', '/signal/settings', { escalate_after_s: Number($('#esc1').value), manager_after_s: Number($('#esc2').value) }));
});

start();
