// Pixberry — customer QR ordering (mobile browser). Location-gated: orders can only be placed within the café's radius.
import { esc, $, $$, money, setCurrency, toast, request, ApiError, dietMark, uid, store, fmtTime } from '/assets/lib.js';

const token = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop());
const API = `/api/public/t/${encodeURIComponent(token)}`;
const K = { cart: `pb.cart.${token}`, order: `pb.order.${token}`, pending: `pb.pending.${token}`, cust: 'pb.customer' };

const S = {
  ctx: null, menu: [], cart: store.get(K.cart, []), q: '', type: 'dine_in',
  loc: { state: 'checking' }, // checking | ok | disabled | outside | denied | unsupported | insecure | low_accuracy | unavailable | not_configured | error
  coords: null, orderKey: store.get(K.order), order: null, view: 'menu', submitting: false, pollTimer: null,
};
const app = $('#app');

// ---------------- Location check ----------------
function getPosition(maxAge = 30000) {
  return new Promise((resolve, reject) => {
    if (!window.isSecureContext) return reject({ code: 'insecure' });
    if (!navigator.geolocation) return reject({ code: 'unsupported' });
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      e => reject({ code: e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable' }),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: maxAge },
    );
  });
}
async function checkLocation({ fresh = false } = {}) {
  const g = S.ctx.geofence;
  if (!g.enabled) { S.loc = { state: 'disabled' }; renderLoc(); return { ok: true, coords: null }; }
  if (!g.configured) { S.loc = { state: 'not_configured' }; renderLoc(); return { ok: false }; }
  S.loc = { ...S.loc, state: S.loc.state === 'ok' ? 'ok' : 'checking' }; renderLoc();
  try {
    const coords = await getPosition(fresh ? 0 : 30000);
    S.coords = coords;
    const res = await request('POST', `${API}/locate`, coords);
    S.loc = { state: res.allowed ? 'ok' : res.code === 'low_accuracy' ? 'low_accuracy' : 'outside', res };
    renderLoc(); renderCartBar();
    return { ok: res.allowed, coords };
  } catch (e) {
    const code = e instanceof ApiError ? 'error' : e.code || 'error';
    S.loc = { state: code === 'timeout' ? 'unavailable' : code, message: e.message };
    renderLoc(); renderCartBar();
    return { ok: false };
  }
}
const canOrder = () => ['ok', 'disabled'].includes(S.loc.state) && S.ctx?.open?.open !== false;

function locView() {
  const g = S.ctx.geofence, l = S.loc, r = l.res || {};
  const retry = `<button class="btn sm" data-act="relocate">Check again</button>`;
  const V = {
    checking: ['checking', '📍', 'Checking your location…', `We only accept orders from guests at the café (within ${g.radius_m} m).`, ''],
    ok: ['ok', '✅', "You're at the café — ordering is on", r.distance_m != null ? `About ${r.distance_m} m from the café.` : '', ''],
    disabled: null,
    outside: ['bad', '🚫', 'Ordering is only available at the café', esc(r.reason || `You need to be within ${g.radius_m} m of the café to place an order. You can still browse the menu.`), retry],
    low_accuracy: ['warn', '📡', 'Your location is not precise enough', `${esc(r.reason || '')} On iPhone: Settings › Privacy › Location › your browser › Precise Location.`, retry],
    denied: ['bad', '🔒', 'Location permission is off', 'Allow location access for this site in your browser settings, then tap “Check again”. We use it only to confirm you are at the café.', retry],
    unsupported: ['bad', '⚠️', "Your browser can't share location", 'Please ask a staff member to take your order.', ''],
    insecure: ['bad', '⚠️', 'Location needs a secure (https) link', 'Please scan the QR code again or ask the staff.', ''],
    unavailable: ['warn', '📡', "We couldn't get your location", 'Turn on location / GPS and try again.', retry],
    not_configured: ['bad', '⚙️', 'Online ordering is not set up yet', 'The café has not set its location yet. Please order with the staff.', ''],
    error: ['warn', '⚠️', "Couldn't check your location", 'Check your connection and try again.', retry],
  }[l.state];
  if (!V) return '';
  const [cls, ic, title, text, action] = V;
  return `<div class="loc ${cls}" role="status"><div class="ic">${ic}</div><div class="txt"><b>${title}</b>${text}</div>${action}</div>`;
}
function renderLoc() { const el = $('#loc'); if (el) el.innerHTML = locView(); }

// ---------------- Cart ----------------
const saveCart = () => store.set(K.cart, S.cart);
const cartCount = () => S.cart.reduce((s, l) => s + l.qty, 0);
const cartTotal = () => S.cart.reduce((s, l) => s + l.qty * l.unit_price, 0);
const itemById = id => S.menu.flatMap(c => c.items).find(i => i.id === id);
function qtyInCart(id) { return S.cart.filter(l => l.item_id === id).reduce((s, l) => s + l.qty, 0); }
function addLine(line) {
  const same = S.cart.find(l => l.sig === line.sig);
  if (same) same.qty = Math.min(99, same.qty + line.qty); else S.cart.push(line);
  saveCart(); renderMenu(); renderCartBar();
}
function simpleLine(it) { return { sig: `${it.id}||`, item_id: it.id, variant_id: null, modifier_ids: [], qty: 1, notes: '', name: it.name, variant: '', mods: [], unit_price: it.price }; }
function changeSimple(it, d) {
  const l = S.cart.find(x => x.item_id === it.id && (d > 0 ? x.sig === `${it.id}||` : true));
  if (d > 0) { if (l) l.qty++; else S.cart.push(simpleLine(it)); }
  else if (l) { l.qty--; if (l.qty <= 0) S.cart.splice(S.cart.indexOf(l), 1); }
  saveCart(); renderMenu(); renderCartBar();
}

// ---------------- Rendering ----------------
const ICON = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg>',
  cart: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2 3h3.2l2.6 11.2a1.5 1.5 0 0 0 1.5 1.2h8.4a1.5 1.5 0 0 0 1.4-1.1L21 7H6.6L6 4.6A2 2 0 0 0 4.1 3H2z"/><circle cx="9.5" cy="19.5" r="1.7"/><circle cx="17.5" cy="19.5" r="1.7"/></svg>',
};
function shell() {
  const c = S.ctx, pg = c.page || {};
  if (pg.accent && /^#[0-9a-fA-F]{6}$/.test(pg.accent)) document.documentElement.style.setProperty('--menu-accent', pg.accent);
  const where = c.table.kind === 'counter' ? ['Takeaway & pickup'] : [`Table ${c.table.label}`, ...(c.table.section ? [c.table.section] : []), 'Dine-in'];
  const welcome = (pg.welcome || 'Welcome to {cafe}').replace('{cafe}', c.cafe.name);
  const initials = c.cafe.name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  app.innerHTML = `
    <header class="bar"><div class="wrap">
      <div class="name">${esc(c.cafe.name)}</div>
      <button class="round" data-act="search" aria-label="Search the menu">${ICON.search}</button>
      <button class="round" data-act="cart" aria-label="View cart">${ICON.cart}<span class="count" id="cartCount" hidden></span></button>
    </div></header>
    <section class="wrap hero">
      <h1 class="title">${esc(pg.title || 'Menu')}</h1>
      ${pg.show_logo !== false ? `<div class="logo-card">${c.cafe.logo_url ? `<img src="${esc(c.cafe.logo_url)}" alt="${esc(c.cafe.name)} logo">` : `<span class="initials">${esc(initials)}</span>`}</div>` : ''}
      ${pg.instagram ? `<div class="ig">Instagram: ${esc(pg.instagram)}</div>` : ''}
      <h2 class="welcome">🍽️ ${esc(welcome)}</h2>
      ${pg.tagline ? `<p class="tagline">${esc(pg.tagline)}</p>` : ''}
      <div class="where">${where.map(w => `<span>${esc(w)}</span>`).join('')}</div>
      ${c.open && c.open.open === false ? `<div class="banner bad">${esc(c.open.reason)}</div>` : c.open?.info ? `<div class="banner info">${esc(c.open.info)}</div>` : ''}
      <div id="loc"></div>
    </section>
    <main class="wrap" id="main"></main>
    <div class="cartbar" id="cartbar"></div>`;
  renderLoc();
}
function renderMain() {
  clearInterval(S.pollTimer);
  if (S.view === 'order') return renderOrder();
  const main = $('#main');
  main.innerHTML = `
    ${S.order && ['open', 'billed'].includes(S.order.status) ? `<div class="banner info row between" style="margin-top:12px"><span>Your order #${S.order.number} · ${esc(S.order.progress)}</span><button class="btn sm" data-act="view-order">View order</button></div>` : ''}
    <div class="sticky"><div class="search" id="searchbox" ${S.q || S.searchOpen ? '' : 'hidden'}><span>🔍</span><input id="q" type="search" placeholder="Search the menu" value="${esc(S.q)}" aria-label="Search menu"></div>
    <nav class="cats" id="cats">${S.menu.map(c => `<button data-cat="${c.id}">${esc(c.name)}</button>`).join('')}</nav></div>
    <div id="menu"></div>`;
  $('#q').addEventListener('input', e => { S.q = e.target.value; renderMenu(); });
  renderMenu(); renderCartBar();
}
function itemHtml(it) {
  const n = qtyInCart(it.id);
  const blocked = it.sold_out || !it.available_now;
  const simple = !it.variants.length && !it.groups.length;
  const ctrl = blocked ? `<button class="add" disabled>${it.sold_out ? 'Sold out' : 'Later'}</button>`
    : simple && n ? `<span class="step"><button data-dec="${it.id}" aria-label="Remove one">−</button><span>${n}</span><button data-inc="${it.id}" aria-label="Add one">+</button></span>`
    : `<button class="add" data-open="${it.id}">${n ? `ADD · ${n}` : 'ADD'}${simple ? '' : '<sup>+</sup>'}</button>`;
  const from = it.variants.length ? Math.min(...it.variants.map(v => v.price)) : it.price;
  return `<article class="item ${blocked ? 'soldout' : ''}">
    <div class="info"><div class="nm">${dietMark(it.diet)} ${esc(it.name)} ${it.featured ? '<span class="badge">Popular</span>' : ''}${it.recommended ? '<span class="badge">Chef\'s pick</span>' : ''}</div>
      <div class="pr">${it.variants.length ? 'from ' : ''}${money(from)}</div>
      ${it.description ? `<div class="ds">${esc(it.description)}</div>` : ''}
      ${it.is_combo && it.combo_items ? `<div class="ds">Includes: ${esc(it.combo_items)}</div>` : ''}
      ${!it.available_now && it.schedule ? `<div class="hint">Available ${esc(it.schedule)}</div>` : ''}
      ${it.photo_url ? '' : `<div style="margin-top:6px">${ctrl}</div>`}</div>
    ${it.photo_url ? `<div class="pic"><img src="${esc(it.photo_url)}" alt="" loading="lazy">${ctrl}</div>` : ''}
  </article>`;
}
function renderMenu() {
  const el = $('#menu'); if (!el) return;
  const q = S.q.trim().toLowerCase();
  const cats = S.menu.map(c => ({ ...c, items: c.items.filter(i => !q || i.name.toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q)) })).filter(c => c.items.length);
  const featured = !q ? S.menu.flatMap(c => c.items).filter(i => i.featured && !i.sold_out && i.available_now) : [];
  el.innerHTML = (featured.length ? `<section class="sec"><h2>⭐ Popular</h2>${featured.map(itemHtml).join('')}</section>` : '') +
    (cats.map(c => `<section class="sec" id="cat-${c.id}"><h2>${esc(c.name)}</h2>${c.description || c.schedule ? `<div class="sd">${esc(c.description || '')}${!c.available_now && c.schedule ? ` · available ${esc(c.schedule)}` : ''}</div>` : ''}${c.items.map(itemHtml).join('')}</section>`).join('')
    || `<div class="empty">No dishes match “${esc(S.q)}”.</div>`);
}
function renderCartBar() {
  const n = cartCount(), cc = $('#cartCount');
  if (cc) { cc.hidden = !n; cc.textContent = n; }
  const el = $('#cartbar'); if (!el) return;
  if (S.view !== 'menu' || !S.cart.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<button class="btn primary lg" data-act="cart"><span>${cartCount()} item${cartCount() > 1 ? 's' : ''} · ${money(cartTotal())}</span><span>View cart →</span></button>`;
}

// ---------------- Item options sheet ----------------
function openItem(it) {
  let variant = it.variants[0]?.id ?? null, qty = 1;
  const picked = new Map(it.groups.map(g => [g.id, new Set()]));
  const price = () => (it.variants.find(v => v.id === variant)?.price ?? it.price) + it.groups.flatMap(g => g.options.filter(o => picked.get(g.id).has(o.id))).reduce((s, o) => s + o.price, 0);
  const sheet = openSheet(`
    <h2>${dietMark(it.diet)} ${esc(it.name)}</h2>${it.description ? `<p class="muted">${esc(it.description)}</p>` : ''}
    ${it.variants.length ? `<div class="grp"><h3>Size</h3><small>Required</small></div>${it.variants.map((v, i) => `<div class="opt"><label><input type="radio" name="v" value="${v.id}" ${i === 0 ? 'checked' : ''}> ${esc(v.name)}</label><span>${money(v.price)}</span></div>`).join('')}` : ''}
    ${it.groups.map(g => `<div class="grp"><h3>${esc(g.name)}</h3><small>${g.min ? `Choose ${g.min === g.max ? g.min : `${g.min}–${g.max || 'any'}`}` : g.max ? `Optional · up to ${g.max}` : 'Optional'}</small></div>
      ${g.options.map(o => `<div class="opt"><label><input type="${g.max === 1 ? 'radio' : 'checkbox'}" name="g${g.id}" value="${o.id}" data-g="${g.id}"> ${esc(o.name)}</label><span>${o.price ? `+${money(o.price)}` : ''}</span></div>`).join('')}`).join('')}
    <div class="field" style="margin-top:14px"><label for="note">Preparation notes</label><input id="note" maxlength="200" placeholder="e.g. less spicy, no onion"></div>
    <div class="row between" style="margin-top:8px"><span class="step"><button data-q="-1">−</button><span id="sq">1</span><button data-q="1">+</button></span>
      <button class="btn primary lg grow" id="addbtn">Add · ${money(price())}</button></div>
    <p class="hint" id="err" role="alert"></p>`);
  const refresh = () => { $('#addbtn', sheet).textContent = `Add · ${money(price() * qty)}`; $('#sq', sheet).textContent = qty; };
  sheet.addEventListener('change', e => {
    if (e.target.name === 'v') variant = Number(e.target.value);
    if (e.target.dataset.g) {
      const g = it.groups.find(x => x.id === Number(e.target.dataset.g));
      const set = picked.get(g.id);
      if (g.max === 1) { set.clear(); if (e.target.checked) set.add(Number(e.target.value)); }
      else if (e.target.checked) {
        if (g.max && set.size >= g.max) { e.target.checked = false; $('#err', sheet).textContent = `You can choose up to ${g.max} for ${g.name}.`; return; }
        set.add(Number(e.target.value));
      } else set.delete(Number(e.target.value));
    }
    $('#err', sheet).textContent = ''; refresh();
  });
  sheet.addEventListener('click', e => {
    const d = e.target.closest('[data-q]'); if (d) { qty = Math.max(1, Math.min(99, qty + Number(d.dataset.q))); refresh(); }
    if (e.target.id === 'addbtn') {
      const missing = it.groups.find(g => picked.get(g.id).size < g.min);
      if (missing) { $('#err', sheet).textContent = `Please choose ${missing.name}.`; return; }
      const mids = [...picked.values()].flatMap(s => [...s]).sort((a, b) => a - b);
      const mods = it.groups.flatMap(g => g.options.filter(o => picked.get(g.id).has(o.id)).map(o => o.name));
      const notes = $('#note', sheet).value.trim();
      addLine({ sig: `${it.id}|${variant || ''}|${mids.join(',')}|${notes}`, item_id: it.id, variant_id: variant, modifier_ids: mids, qty, notes, name: it.name, variant: it.variants.find(v => v.id === variant)?.name || '', mods, unit_price: price() });
      closeSheet(); toast(`Added ${it.name}`);
    }
  });
}
function openSheet(html) {
  closeSheet();
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  bg.addEventListener('click', e => { if (e.target === bg) closeSheet(); });
  document.body.append(bg);
  document.body.style.overflow = 'hidden';
  return bg.firstElementChild;
}
function closeSheet() { $$('.sheet-bg').forEach(x => x.remove()); document.body.style.overflow = ''; }

// ---------------- Cart & checkout ----------------
function openCart() {
  const c = S.ctx, cust = store.get(K.cust, {});
  const counter = c.table.kind === 'counter';
  const sheet = openSheet(`
    <div class="row between"><h2 style="margin:0">Your order</h2><button class="btn ghost sm" data-act="close">Close</button></div>
    <div id="lines"></div>
    ${counter ? `<div class="field" style="margin-top:12px"><label>Order type</label><div class="row">${c.order_types.map(t => `<label class="check"><input type="radio" name="otype" value="${t}" ${S.type === t ? 'checked' : ''}> ${t === 'pickup' ? 'Pickup later' : 'Takeaway now'}</label>`).join('')}</div></div>` : ''}
    <div class="grid g2" style="margin-top:12px">
      <div class="field"><label for="cn">Name ${counter ? '(required)' : '(optional)'}</label><input id="cn" autocomplete="name" value="${esc(cust.name || '')}"></div>
      <div class="field"><label for="cp">Phone (optional)</label><input id="cp" type="tel" autocomplete="tel" value="${esc(cust.phone || '')}" placeholder="For order updates & receipt"></div>
    </div>
    <label class="check"><input type="checkbox" id="consent" ${cust.consent ? 'checked' : ''}> Save my details for receipts, order updates &amp; loyalty points</label>
    <div class="field" style="margin-top:10px"><label for="on">Note for the café</label><input id="on" maxlength="300" placeholder="Anything else we should know?"></div>
    <div class="totals" id="tot"></div>
    <div id="cartloc" style="margin:10px 0"></div>
    <button class="btn primary lg block" id="place">Place order</button>
    <p class="hint" style="text-align:center">${c.geofence.enabled ? `For security, orders are accepted only within ${c.geofence.radius_m} m of the café.` : ''}</p>`);
  const draw = () => {
    if (!S.cart.length) { closeSheet(); renderMenu(); renderCartBar(); return; }
    $('#lines', sheet).innerHTML = S.cart.map((l, i) => `<div class="line"><div class="grow"><div><b>${esc(l.name)}</b>${l.variant ? ` · ${esc(l.variant)}` : ''}</div>${l.mods.length ? `<div class="mods">+ ${esc(l.mods.join(', '))}</div>` : ''}${l.notes ? `<div class="mods">“${esc(l.notes)}”</div>` : ''}<div class="mods">${money(l.unit_price)} each</div></div>
      <span class="step"><button data-l="${i}" data-d="-1">−</button><span>${l.qty}</span><button data-l="${i}" data-d="1">+</button></span><b class="num" style="min-width:64px;text-align:right">${money(l.unit_price * l.qty)}</b></div>`).join('');
    const sub = cartTotal();
    const t = c.tax, sc = c.service_charge;
    const svc = sc.enabled && (!sc.dine_in_only || !counter) ? Math.round(sub * sc.percent / 100) : 0;
    const tax = t.enabled && t.mode === 'exclusive' ? Math.round((sub + svc) * t.rate / 100) : 0;
    $('#tot', sheet).innerHTML = `<div><span>Item total</span><span>${money(sub)}</span></div>${svc ? `<div><span>Service charge (${sc.percent}%)</span><span>${money(svc)}</span></div>` : ''}
      ${tax ? `<div><span>${esc(t.label)} (${t.rate}%)</span><span>${money(tax)}</span></div>` : t.enabled ? `<div class="muted"><span>Prices include ${esc(t.label)}</span><span></span></div>` : ''}
      <div class="big"><span>Estimated total</span><span>${money(sub + svc + tax)}</span></div>`;
    $('#cartloc', sheet).innerHTML = canOrder() ? '' : locView();
    const btn = $('#place', sheet);
    btn.disabled = S.submitting || S.ctx.open?.open === false;
    btn.textContent = S.submitting ? 'Placing order…' : canOrder() ? `Place order · ${money(sub + svc + tax)}` : 'Check location & place order';
  };
  draw();
  sheet.addEventListener('change', e => { if (e.target.name === 'otype') { S.type = e.target.value; refreshMenuForType(); } });
  sheet.addEventListener('click', async e => {
    const b = e.target.closest('[data-l]');
    if (b) { const l = S.cart[Number(b.dataset.l)]; l.qty += Number(b.dataset.d); if (l.qty <= 0) S.cart.splice(Number(b.dataset.l), 1); saveCart(); draw(); renderMenu(); renderCartBar(); }
    if (e.target.closest('[data-act="close"]')) closeSheet();
    if (e.target.closest('[data-act="relocate"]')) { await checkLocation({ fresh: true }); draw(); }
    if (e.target.id === 'place') placeOrder(sheet, draw);
  });
}
async function refreshMenuForType() {
  try { S.menu = await request('GET', `${API}/menu?type=${S.type}`); } catch { /* keep current */ }
  const byId = new Map(S.menu.flatMap(c => c.items).map(i => [i.id, i]));
  for (const l of S.cart) { const it = byId.get(l.item_id); if (it && !l.variant_id && !l.modifier_ids.length) l.unit_price = it.price; }
  renderMenu();
}
async function placeOrder(sheet, draw) {
  const name = $('#cn', sheet).value.trim(), phone = $('#cp', sheet).value.trim(), consent = $('#consent', sheet).checked;
  if (S.ctx.table.kind === 'counter' && !name) { toast('Please enter your name for the order', 'bad'); $('#cn', sheet).focus(); return; }
  store.set(K.cust, consent ? { name, phone, consent } : {});
  S.submitting = true; draw();
  try {
    // Always take a fresh location fix at checkout — the server re-checks it against the café radius.
    const loc = await checkLocation({ fresh: true });
    if (!loc.ok) { toast(S.loc.res?.reason || 'We could not confirm you are at the café.', 'bad'); return; }
    const pending = store.get(K.pending) || { client_ref: uid() }; // reused on retry → no duplicate orders
    store.set(K.pending, pending);
    const body = {
      client_ref: pending.client_ref, type: S.ctx.table.kind === 'counter' ? S.type : 'dine_in',
      items: S.cart.map(l => ({ item_id: l.item_id, variant_id: l.variant_id, modifier_ids: l.modifier_ids, qty: l.qty, notes: l.notes })),
      customer: { name, phone, consent }, notes: $('#on', sheet).value.trim(), location: loc.coords,
    };
    const res = await request('POST', `${API}/orders`, body);
    store.del(K.pending);
    S.cart = []; saveCart();
    S.order = res.order; S.orderKey = res.order.key; store.set(K.order, S.orderKey);
    closeSheet(); S.view = 'order'; renderMain(); renderCartBar();
    toast('Order sent to the kitchen!', 'ok');
  } catch (e) {
    if (e instanceof ApiError) {
      store.del(K.pending);
      if (e.body?.geofence) { S.loc = { state: e.body.geofence.code === 'low_accuracy' ? 'low_accuracy' : e.body.geofence.code === 'location_required' ? 'denied' : 'outside', res: e.body.geofence }; renderLoc(); }
      toast(e.message, 'bad');
      if (e.status === 409) await reloadMenu();
    } else toast("You seem to be offline. Your cart is saved — tap Place order again when you're back online.", 'bad');
  } finally { S.submitting = false; if (document.body.contains(sheet)) draw(); }
}

// ---------------- Order status ----------------
async function loadOrder() {
  if (!S.orderKey) return null;
  try { S.order = await request('GET', `/api/public/orders/${encodeURIComponent(S.orderKey)}`); }
  catch (e) { if (e.status === 404) { S.order = null; S.orderKey = null; store.del(K.order); } }
  return S.order;
}
function renderOrder() {
  const o = S.order, main = $('#main');
  if (!o) { S.view = 'menu'; return renderMain(); }
  const steps = ['new', 'preparing', 'ready', 'served'];
  const idx = o.progress === 'paid' ? 4 : steps.indexOf(o.progress);
  const active = ['open', 'billed'].includes(o.status);
  main.innerHTML = `
    <div class="card" style="margin-top:14px">
      <div class="row between"><h2 style="margin:0">Order #${o.number}</h2><span class="chip ${o.status === 'paid' ? 'ok' : o.status === 'cancelled' ? 'bad' : 'brand'}">${esc(o.status === 'paid' ? 'Paid' : o.status === 'billed' ? 'Bill requested' : o.status === 'cancelled' ? 'Cancelled' : 'In progress')}</span></div>
      ${o.pickup_code ? `<p style="margin:8px 0 0">Pickup code <b style="font-size:22px;letter-spacing:.1em">${esc(o.pickup_code)}</b></p>` : ''}
      ${o.status !== 'cancelled' ? `<div class="progress">${steps.map((_, i) => `<div class="${i <= idx ? 'on' : ''}"></div>`).join('')}</div>
      <div class="steps">${['Received', 'Preparing', 'Ready', 'Served'].map((s, i) => `<span class="${i === idx ? 'on' : ''}">${s}</span>`).join('')}</div>` : ''}
    </div>
    ${active && S.ctx.table.kind === 'table' ? `<div class="fab"><button class="btn" data-act="more">＋ Add more items</button><button class="btn" data-req="waiter">🙋 Call waiter</button><button class="btn" data-req="bill">🧾 Ask for bill</button></div>` : ''}
    ${active && S.ctx.table.kind === 'counter' ? `<div class="fab"><button class="btn" data-act="more">＋ New order</button></div>` : ''}
    <div class="card">
      ${o.items.map(i => `<div class="line"><div class="grow"><b>${i.qty}× ${esc(i.name)}</b>${i.variant ? ` · ${esc(i.variant)}` : ''}${i.modifiers.length ? `<div class="mods">+ ${esc(i.modifiers.join(', '))}</div>` : ''}${i.notes ? `<div class="mods">“${esc(i.notes)}”</div>` : ''}</div>
        <span class="chip ${i.status === 'ready' ? 'ok' : i.status === 'served' ? '' : i.status === 'cancelled' ? 'bad' : i.status === 'preparing' ? 'warn' : 'info'}">${esc(i.status_label)}</span><span class="num" style="min-width:64px;text-align:right">${money(i.unit_price * i.qty)}</span></div>`).join('')}
      <div class="totals" style="margin-top:10px"><div><span>Subtotal</span><span>${money(o.subtotal)}</span></div>
        ${o.discount ? `<div><span>Discount</span><span>−${money(o.discount)}</span></div>` : ''}${o.service_charge ? `<div><span>Service charge</span><span>${money(o.service_charge)}</span></div>` : ''}
        ${o.tax_breakdown.map(t => `<div><span>${esc(t.label)}${o.tax_mode === 'inclusive' ? ' (incl.)' : ''}</span><span>${money(t.amount)}</span></div>`).join('')}
        ${o.round_off ? `<div><span>Round off</span><span>${money(o.round_off)}</span></div>` : ''}
        <div class="big"><span>Total</span><span>${money(o.total)}</span></div>${o.paid ? `<div><span>Paid</span><span>${money(o.paid)}</span></div>` : ''}</div>
      ${o.status === 'paid' ? `<p style="margin-top:12px"><a class="btn block" href="/r/${encodeURIComponent(o.key)}" target="_blank" rel="noopener">View receipt</a></p>` : ''}
    </div>
    ${o.status === 'paid' ? feedbackHtml() : ''}
    <p style="text-align:center;margin:16px 0"><button class="btn ghost" data-act="menu">← Back to menu</button></p>`;
  if (active) S.pollTimer = setInterval(async () => { const before = JSON.stringify(S.order); await loadOrder(); if (JSON.stringify(S.order) !== before && S.view === 'order') renderOrder(); }, 5000);
}
function feedbackHtml() {
  if (store.get(`pb.fb.${S.order.key}`)) return `<div class="card"><p style="margin:0">Thanks for your feedback! 💜</p></div>`;
  return `<div class="card" id="fb"><h3>How was everything?</h3><div class="stars">${[1, 2, 3, 4, 5].map(n => `<button data-star="${n}" aria-label="${n} star">★</button>`).join('')}</div>
    <textarea id="fbc" placeholder="Tell us more (optional)" style="margin-top:8px"></textarea><button class="btn primary block" style="margin-top:8px" data-act="fb">Send feedback</button></div>`;
}
async function serviceRequest(type) {
  const loc = await checkLocation({ fresh: true });
  if (!loc.ok) { toast(S.loc.res?.reason || 'We could not confirm you are at the café.', 'bad'); return; }
  try {
    const r = await request('POST', `${API}/requests`, { type, location: loc.coords });
    toast(r.already_requested ? 'Already requested — someone is on the way.' : type === 'bill' ? 'Bill requested. A staff member will bring it shortly.' : 'A staff member is on the way.', 'ok');
    await loadOrder(); renderOrder();
  } catch (e) { toast(e.message, 'bad'); }
}

// ---------------- Events ----------------
let stars = 0;
document.addEventListener('click', async e => {
  const t = e.target;
  const inc = t.closest('[data-inc]'), dec = t.closest('[data-dec]'), open = t.closest('[data-open]'), cat = t.closest('[data-cat]');
  if (inc) changeSimple(itemById(Number(inc.dataset.inc)), 1);
  else if (dec) changeSimple(itemById(Number(dec.dataset.dec)), -1);
  else if (open) { const it = itemById(Number(open.dataset.open)); if (!it.variants.length && !it.groups.length) changeSimple(it, 1); else openItem(it); }
  else if (cat) { $$('#cats button').forEach(b => b.classList.toggle('on', b === cat)); document.getElementById(`cat-${cat.dataset.cat}`)?.scrollIntoView({ behavior: 'smooth' }); }
  const act = t.closest('[data-act]')?.dataset.act;
  if (act === 'cart') { if (S.cart.length) openCart(); else if (S.order && S.view !== 'order') { S.view = 'order'; renderMain(); renderCartBar(); } else toast('Your cart is empty — tap ADD on any dish.'); }
  if (act === 'search') {
    if (S.view !== 'menu') { S.view = 'menu'; renderMain(); }
    S.searchOpen = true; const box = $('#searchbox'); if (box) { box.hidden = false; $('#q').focus(); box.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }
  if (act === 'relocate' && !t.closest('.sheet')) checkLocation({ fresh: true });
  if (act === 'view-order') { S.view = 'order'; renderMain(); renderCartBar(); }
  if (act === 'menu' || act === 'more') { S.view = 'menu'; renderMain(); window.scrollTo(0, 0); }
  const rq = t.closest('[data-req]'); if (rq) serviceRequest(rq.dataset.req);
  const st = t.closest('[data-star]'); if (st) { stars = Number(st.dataset.star); $$('[data-star]').forEach(b => b.classList.toggle('on', Number(b.dataset.star) <= stars)); }
  if (act === 'fb') {
    if (!stars) { toast('Tap a star rating first'); return; }
    try { await request('POST', `/api/public/orders/${encodeURIComponent(S.order.key)}/feedback`, { rating: stars, comment: $('#fbc').value }); } catch (err) { if (err.status !== 409) { toast(err.message, 'bad'); return; } }
    store.set(`pb.fb.${S.order.key}`, 1); renderOrder();
  }
});

async function reloadMenu() {
  try { S.menu = await request('GET', `${API}/menu?type=${S.type}`); renderMenu(); } catch { /* offline */ }
}

// ---------------- Boot ----------------
(async function boot() {
  try {
    S.ctx = await request('GET', API);
  } catch (e) {
    app.innerHTML = `<div class="wrap"><div class="card" style="margin-top:32px;text-align:center"><h2>Sorry!</h2><p>${esc(e instanceof ApiError ? e.message : "We couldn't load the menu. Check your internet connection and try again.")}</p><button class="btn primary" onclick="location.reload()">Try again</button></div></div>`;
    return;
  }
  setCurrency(S.ctx.currency);
  document.title = `${S.ctx.cafe.name} — Menu`;
  S.menu = S.ctx.menu;
  S.type = S.ctx.order_types[0];
  // Drop cart lines that are no longer on the menu
  const ids = new Set(S.menu.flatMap(c => c.items).filter(i => !i.sold_out).map(i => i.id));
  S.cart = S.cart.filter(l => ids.has(l.item_id)); saveCart();
  if (S.ctx.active_order) { S.order = S.ctx.active_order; S.orderKey = S.order.key; store.set(K.order, S.orderKey); }
  else if (S.orderKey) { await loadOrder(); if (S.order && !['open', 'billed', 'paid'].includes(S.order.status)) S.order = null; }
  shell();
  S.view = S.order && S.ctx.table.kind === 'counter' && ['open', 'billed'].includes(S.order.status) && !S.cart.length ? 'order' : 'menu';
  renderMain();
  checkLocation();
})();
