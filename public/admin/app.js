// Pixberry ERP — back office shell: navigation, router, live events, notifications, offline queue.
import { esc, $, $$, toast, store, ago } from '/assets/lib.js';
import { session, api, loadMe, setBranch, logout, renderLogin, connectEvents, can, chime } from '/assets/staff.js';

const NAV = [
  ['Operate'],
  ['dashboard', '📊', 'Dashboard', ['reports.view', 'orders.create']],
  ['pos', '🧾', 'Point of sale', ['orders.create']],
  ['orders', '📋', 'Orders & bills', ['orders.create', 'payments.take', 'reports.view']],
  ['tables', '🪑', 'Tables & floor', ['tables.manage', 'orders.create']],
  ['kds', '🍳', 'Kitchen display', ['kds.view'], '/kds'],
  ['reservations', '📅', 'Reservations & queue', ['reservations.manage']],
  ['Manage'],
  ['menu', '📖', 'Menu', ['menu.manage']],
  ['inventory', '📦', 'Inventory', ['inventory.manage']],
  ['recipes', '🥣', 'Recipes & costing', ['inventory.manage', 'menu.manage']],
  ['purchasing', '🚚', 'Suppliers & purchasing', ['purchasing.manage']],
  ['customers', '💜', 'Customers & loyalty', ['customers.manage']],
  ['staff', '👥', 'Staff & attendance', ['staff.manage']],
  ['Insights'],
  ['reports', '📈', 'Reports', ['reports.view']],
  ['messages', '✉️', 'Notifications & messages', null],
  ['audit', '🔍', 'Audit log', ['audit.view']],
  ['settings', '⚙️', 'Settings', ['settings.manage']],
];
const allowed = n => !n[3] || n[3].some(can);
export const ctx = { listeners: new Set(), settings: null };
export function onLive(fn) { ctx.listeners.add(fn); return () => ctx.listeners.delete(fn); }
export async function getSettings(force = false) { if (!ctx.settings || force) ctx.settings = await api('GET', '/settings'); return ctx.settings; }

let cleanup = null, notifs = [];
async function start() {
  if (!session.token) return renderLogin($('#login'), 'Café back office', start);
  try { await loadMe(); } catch { return renderLogin($('#login'), 'Café back office', start); }
  $('#shell').hidden = false;
  if (store.get('pb.theme')) document.documentElement.dataset.theme = store.get('pb.theme');
  renderNav(); renderTop();
  connectEvents((type, data) => {
    if (type === 'notification') onNotification(data);
    ctx.listeners.forEach(fn => { try { fn(type, data); } catch (e) { console.error(e); } });
  });
  loadNotifs();
  addEventListener('hashchange', route);
  addEventListener('online', () => { $('#offline').hidden = true; flushQueue(); });
  addEventListener('offline', () => { $('#offline').hidden = false; });
  $('#offline').hidden = navigator.onLine;
  setInterval(flushQueue, 20000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  route();
}

function renderNav() {
  const first = NAV.find(n => n.length > 1 && allowed(n) && !n[4]);
  ctx.home = first ? first[0] : 'messages';
  $('#nav').innerHTML = `<div class="logo"><img src="/assets/icon.svg" width="28" height="28" alt=""> ${esc(session.me.cafe.name || 'Pixberry ERP')}</div>` +
    NAV.map(n => n.length === 1 ? `<div class="grp">${esc(n[0])}</div>` : allowed(n) ? `<a href="${n[4] || `#/${n[0]}`}" data-nav="${n[0]}" ${n[4] ? 'target="_blank"' : ''}><span class="ic">${n[1]}</span>${esc(n[2])}${n[0] === 'tables' ? '<span class="badge" id="reqBadge" hidden></span>' : ''}</a>` : '').join('')
      .replace(/<div class="grp">[^<]*<\/div>(?=<div class="grp">|$)/g, '');
  $('#nav').onclick = e => { if (e.target.closest('a')) $('#nav').classList.remove('open'); };
}
function renderTop() {
  const me = session.me;
  const clocked = me.clocked_in;
  $('#topbar').innerHTML = `
    <button class="btn ghost sm" id="menuBtn" aria-label="Menu">☰</button>
    <h1 id="title"></h1>
    ${me.branches.length > 1 ? `<select id="branchSel" aria-label="Branch">${me.branches.map(b => `<option value="${b.id}" ${b.id === session.branch ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>` : ''}
    <button class="btn sm ${clocked ? '' : 'primary'}" id="clockBtn" title="${clocked ? `Clocked in ${ago(clocked.clock_in)} ago` : ''}">${clocked ? '⏱ Clock out' : '⏱ Clock in'}</button>
    <button class="btn ghost sm bell" id="bell" aria-label="Notifications">🔔<span class="dot" id="bellDot" hidden></span></button>
    <button class="btn ghost sm" id="themeBtn" aria-label="Toggle light/dark theme" title="Light / dark">🌓</button>
    <button class="btn ghost sm" id="userBtn">${esc(me.user.name)} ▾</button>`;
  $('#menuBtn').onclick = () => $('#nav').classList.toggle('open');
  $('#branchSel')?.addEventListener('change', e => { setBranch(e.target.value); location.reload(); });
  $('#clockBtn').onclick = async () => {
    try { await api('POST', clocked ? '/attendance/clock-out' : '/attendance/clock-in'); await loadMe(); renderTop(); toast(clocked ? 'Clocked out' : 'Clocked in', 'ok'); } catch (e) { toast(e.message, 'bad'); }
  };
  $('#themeBtn').onclick = () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next; store.set('pb.theme', next);
  };
  $('#bell').onclick = toggleNotifs;
  $('#userBtn').onclick = userMenu;
}
async function userMenu() {
  const { modal, fieldsHtml, readFields } = await import('/admin/ui.js');
  const defs = [{ name: 'current', label: 'Current password', type: 'password', required: true }, { name: 'next', label: 'New password (8+ characters)', type: 'password', required: true }];
  modal({
    title: session.me.user.name,
    body: `<p class="muted">Signed in as <b>${esc(session.me.user.username)}</b> · role <b>${esc(session.me.user.role)}</b></p><h3>Change password</h3>${fieldsHtml(defs)}`,
    actions: [{ label: 'Sign out', kind: 'danger', onClick: () => logout() }, { label: 'Change password', kind: 'primary', onClick: async ({ el }) => { await api('POST', '/auth/password', readFields(el, defs)); toast('Password changed', 'ok'); } }],
  });
}

// ---------- Notifications ----------
async function loadNotifs() { try { notifs = await api('GET', '/notifications'); updateBell(); } catch { /* ignore */ } }
function updateBell() {
  const n = notifs.filter(x => !x.is_read).length;
  $('#bellDot').hidden = !n; $('#bellDot').textContent = n > 99 ? '99+' : n;
}
function onNotification(n) {
  const mine = n.audience === 'staff' || (n.audience === 'kitchen' && can('kds.view')) || (n.audience === 'manager' && (can('reports.view') || can('inventory.manage')));
  if (!mine) return;
  notifs.unshift({ ...n, is_read: 0, created_at: new Date().toISOString() });
  updateBell();
  if (n.audience !== 'kitchen' || location.hash.includes('pos')) toast(n.message, n.type === 'delayed_order' || n.type === 'low_stock' ? 'bad' : '');
  if (['request_bill', 'request_waiter', 'order_ready', 'new_order'].includes(n.type) && store.get('pb.sound', true)) chime();
  if (n.type.startsWith('request_')) refreshReqBadge();
}
async function refreshReqBadge() {
  if (!can('orders.create') && !can('tables.manage')) return;
  try { const r = await api('GET', '/service-requests'); const n = r.filter(x => x.status === 'open').length; const b = $('#reqBadge'); if (b) { b.hidden = !n; b.textContent = n; } } catch { /* ignore */ }
}
function toggleNotifs() {
  const ex = $('.notif-panel'); if (ex) { ex.remove(); return; }
  const p = document.createElement('div');
  p.className = 'card notif-panel';
  p.innerHTML = `<div class="row between" style="padding:10px 14px;border-bottom:1px solid var(--border)"><b>Notifications</b><button class="btn sm ghost" id="readAll">Mark all read</button></div>` +
    (notifs.slice(0, 50).map(n => `<div class="n ${n.is_read ? '' : 'unread'}">${esc(n.message)}<div class="faint">${ago(n.created_at)} ago</div></div>`).join('') || '<div class="empty">No notifications.</div>');
  document.body.append(p);
  p.querySelector('#readAll').onclick = async () => { await api('POST', '/notifications/read-all'); notifs.forEach(n => (n.is_read = 1)); updateBell(); p.remove(); };
  setTimeout(() => document.addEventListener('click', function off(e) { if (!p.contains(e.target) && e.target.id !== 'bell') { p.remove(); document.removeEventListener('click', off); } }), 0);
}

// ---------- Offline queue for POS orders ----------
export function queueOrder(body) { const q = store.get('pb.queue', []); q.push(body); store.set('pb.queue', q); }
async function flushQueue() {
  const q = store.get('pb.queue', []);
  if (!q.length || !navigator.onLine) return;
  const left = [];
  for (const body of q) {
    try { await api('POST', '/orders', body); toast('Offline order sent', 'ok'); }
    catch (e) { if (e.status) toast(`Queued order failed: ${e.message}`, 'bad'); else left.push(body); }
  }
  store.set('pb.queue', left);
}

// ---------- Router ----------
async function route() {
  const [name, ...rest] = (location.hash.replace(/^#\/?/, '') || ctx.home).split('/');
  const nav = NAV.find(n => n[0] === name);
  if (!nav || !allowed(nav)) { location.hash = `#/${ctx.home}`; return; }
  $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.nav === name));
  $('#title').textContent = nav[2];
  document.title = `${nav[2]} · Pixberry ERP`;
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  ctx.listeners.clear();
  const view = $('#view');
  view.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const mod = await import(`/admin/views/${name}.js`);
    cleanup = await mod.render(view, rest);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="banner bad">${esc(e.message || 'Failed to load this page')}</div>`;
  }
  refreshReqBadge();
}
start();
