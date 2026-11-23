// Guest QR menu (PHP edition). The server re-checks the guest's location on every order.
(() => {
  const T = new URLSearchParams(location.search).get('t') || '';
  const API = (a, extra = '') => `api.php?a=${a}&t=${encodeURIComponent(T)}${extra}`;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage off */ } } };
  const toast = (m, bad) => { const t = document.createElement('div'); t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = m; $('#toasts').append(t); setTimeout(() => t.remove(), 4000); };
  async function api(a, body, extra) {
    const r = await fetch(API(a, extra), body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' } : { credentials: 'same-origin' });
    const d = await r.json().catch(() => ({ error: 'Unexpected response. Reload the page.' }));
    if (!r.ok) { const e = new Error(d.error || 'Request failed'); e.data = d; e.status = r.status; throw e; }
    return d;
  }
  const S = { ctx: null, cart: new Map(ls.get('pbg.cart.' + T, [])), q: '', loc: { state: 'idle' }, coords: null, mine: ls.get('pbg.mine.' + T, []), orders: [], view: 'menu', busy: false };
  let cur = '₹';
  const money = n => cur + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const saveCart = () => ls.set('pbg.cart.' + T, [...S.cart]);
  const item = id => S.ctx.items.find(i => i.id === id);
  const count = () => [...S.cart.values()].reduce((a, b) => a + b, 0);
  const subtotal = () => [...S.cart].reduce((s, [id, q]) => s + (item(id)?.price || 0) * q, 0);
  const ICON = {
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg>',
    cart: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2 3h3.2l2.6 11.2a1.5 1.5 0 0 0 1.5 1.2h8.4a1.5 1.5 0 0 0 1.4-1.1L21 7H6.6L6 4.6A2 2 0 0 0 4.1 3H2z"/><circle cx="9.5" cy="19.5" r="1.7"/><circle cx="17.5" cy="19.5" r="1.7"/></svg>',
  };

  // ---------- location ----------
  function position() {
    return new Promise((res, rej) => {
      if (!window.isSecureContext) return rej({ code: 'insecure' });
      if (!navigator.geolocation) return rej({ code: 'unsupported' });
      navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
        e => rej({ code: e.code === 1 ? 'denied' : 'unavailable' }), { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    });
  }
  async function checkLocation() {
    const g = S.ctx.geofence;
    if (!g.enabled) { S.loc = { state: 'off' }; drawLoc(); return true; }
    if (!g.configured) { S.loc = { state: 'unset' }; drawLoc(); return false; }
    S.loc = { state: S.loc.state === 'in' ? 'in' : 'checking', res: S.loc.res }; drawLoc();
    try {
      S.coords = await position();
      const r = await api('locate', S.coords);
      S.loc = { state: r.code, res: r }; drawLoc(); drawCartBar();
      return r.allowed;
    } catch (e) { S.loc = { state: e.code || 'error', res: e.data }; drawLoc(); return false; }
  }
  function drawLoc() {
    const r = S.loc.res || {}, rad = S.ctx.geofence.radius_m, again = '<button class="btn line" data-act="loc">Check again</button>';
    const V = {
      idle: ['idle', 'Checking your location…', `We accept orders from guests at the café (within ${rad} m).`, ''],
      checking: ['idle', 'Checking your location…', `We accept orders from guests at the café (within ${rad} m).`, ''],
      in: ['ok', "You're at the café: ordering is on", r.distance_m != null ? `About ${r.distance_m} m from the café.` : '', ''],
      off: null,
      out: ['bad', 'Ordering is only available at the café', esc(r.reason || '') + ' You can still browse the menu.', again],
      rough: ['warn', 'Your location is not precise enough', esc(r.reason || ''), again],
      none: ['bad', 'Location needed', 'Allow location access so we can confirm you are at the café.', again],
      denied: ['bad', 'Location permission is off', 'Allow location for this site in your browser settings, then tap Check again.', again],
      insecure: ['bad', 'This link must start with https://', 'Ask the café to turn on SSL for the website.', ''],
      unsupported: ['bad', "Your browser can't share location", 'Please order with the staff.', ''],
      unavailable: ['warn', "We couldn't get your location", 'Turn on GPS / location and try again.', again],
      unset: ['bad', 'Online ordering is not set up yet', 'Please order with the staff.', ''],
      error: ['warn', "Couldn't check your location", 'Check your connection and try again.', again],
    }[S.loc.state];
    $('#loc').innerHTML = V ? `<div class="loc ${V[0]}"><div class="t"><b>${V[1]}</b>${V[2]}</div>${V[3]}</div>` : '';
  }
  const canOrder = () => ['in', 'off'].includes(S.loc.state);

  // ---------- render ----------
  function shell() {
    const c = S.ctx, p = c.page;
    if (/^#[0-9a-f]{6}$/i.test(p.accent)) document.documentElement.style.setProperty('--menu-accent', p.accent);
    const initials = c.cafe.name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
    document.title = `${c.cafe.name} — Menu`;
    $('#app').innerHTML = `
      <header class="bar"><div class="wrap"><div class="name">${esc(c.cafe.name)}</div>
        <button class="round" data-act="search" aria-label="Search the menu">${ICON.search}</button>
        <button class="round" data-act="cart" aria-label="View cart">${ICON.cart}<span class="count" id="count" hidden></span></button></div></header>
      <section class="wrap hero">
        <h1 class="title">${esc(p.title || 'Menu')}</h1>
        <div class="logo-card">${c.cafe.logo ? `<img src="${esc(c.cafe.logo)}" alt="${esc(c.cafe.name)} logo">` : `<span class="initials">${esc(initials)}</span>`}</div>
        ${p.instagram ? `<div class="ig">Instagram: ${esc(p.instagram)}</div>` : ''}
        <h2 class="welcome">🍽️ ${esc((p.welcome || 'Welcome to {cafe}').replace('{cafe}', c.cafe.name))}</h2>
        ${p.tagline ? `<p class="tagline">${esc(p.tagline)}</p>` : ''}
        <div class="chips"><span>${c.table.kind === 'counter' ? 'Takeaway' : `Table ${esc(c.table.label)}`}</span><span>${c.table.kind === 'counter' ? 'Pickup at counter' : 'Dine-in'}</span></div>
        <div id="loc" style="width:100%"></div><div id="mine" style="width:100%"></div>
      </section>
      <main class="wrap" id="main"></main><div class="cartbar" id="cartbar"></div>`;
    drawLoc();
  }
  function drawMenu() {
    const q = S.q.trim().toLowerCase();
    const items = S.ctx.items.filter(i => !q || i.name.toLowerCase().includes(q) || i.desc.toLowerCase().includes(q));
    const cats = [...new Set(S.ctx.items.map(i => i.cat))];
    $('#main').innerHTML = `<div class="sticky"><div class="search" id="sbox" ${S.q || S.searchOpen ? '' : 'hidden'}><input id="q" type="search" placeholder="Search the menu" value="${esc(S.q)}" aria-label="Search the menu"></div>
      <nav class="cats">${cats.map((c, i) => `<button data-cat="${i}">${esc(c)}</button>`).join('')}</nav></div>
      ${cats.map((c, i) => { const list = items.filter(x => x.cat === c); return list.length ? `<section class="sec" id="cat${i}"><h2>${esc(c)}</h2>${list.map(row).join('')}</section>` : ''; }).join('') || `<p class="empty">${S.ctx.items.length ? 'No dishes match your search.' : 'The menu is being prepared. Please ask the staff.'}</p>`}`;
    $('#q')?.addEventListener('input', e => { S.q = e.target.value; const pos = e.target.selectionStart; drawMenu(); const i = $('#q'); i.focus(); i.setSelectionRange(pos, pos); });
    drawCartBar();
  }
  function row(i) {
    const n = S.cart.get(i.id) || 0;
    const ctl = i.sold_out ? '<button class="add" disabled>SOLD OUT</button>' : n ? `<span class="step"><button data-dec="${i.id}" aria-label="Remove one">−</button><span>${n}</span><button data-inc="${i.id}" aria-label="Add one">+</button></span>` : `<button class="add" data-inc="${i.id}">ADD</button>`;
    return `<article class="item ${i.sold_out ? 'soldout' : ''}"><div class="info"><div class="nm"><span class="diet ${esc(i.diet)}"></span>${esc(i.name)}</div>
      <div class="pr">${money(i.price)}</div>${i.desc ? `<div class="ds">${esc(i.desc)}</div>` : ''}</div>
      <div class="pic"><div class="ph">${i.photo ? `<img src="${esc(i.photo)}" alt="" loading="lazy">` : PBArt.svg(i)}</div><div class="ctl">${ctl}</div></div></article>`;
  }
  function drawCartBar() {
    const n = count(); const c = $('#count'); c.hidden = !n; c.textContent = n;
    $('#cartbar').innerHTML = n ? `<button class="btn primary lg" data-act="cart"><span>${n} item${n > 1 ? 's' : ''} · ${money(subtotal())}</span><span>View cart →</span></button>` : '';
  }
  function bill(sub) { const g = S.ctx.gst, r = g.rate / 100; if (g.mode === 'inclusive') return { tax: sub - sub / (1 + r), total: sub }; const tax = Math.round(sub * r * 100) / 100; return { tax, total: sub + tax }; }

  // ---------- cart sheet ----------
  function openCart() {
    if (!count()) { toast('Your cart is empty. Tap ADD on any dish.'); return; }
    const bg = document.createElement('div'); bg.className = 'sheet-bg';
    const counter = S.ctx.table.kind === 'counter';
    bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="row"><h2>Your order</h2><button class="btn" data-x>Close</button></div><div id="lines"></div>
      ${counter ? `<label>Your name (for pickup)<input id="cn" maxlength="80" autocomplete="name" value="${esc(ls.get('pbg.name', ''))}"></label>` : ''}
      <label>Note for the kitchen<input id="note" maxlength="200" placeholder="e.g. less spicy, no onion"></label>
      <div id="sum"></div><div id="sloc"></div><button class="btn primary lg" id="place">Place order</button>
      <p class="muted" style="text-align:center;margin:0">${S.ctx.geofence.enabled ? `Orders are accepted only within ${S.ctx.geofence.radius_m} m of the café.` : ''}</p></div>`;
    document.body.append(bg);
    const draw = () => {
      if (!count()) { bg.remove(); drawMenu(); return; }
      bg.querySelector('#lines').innerHTML = [...S.cart].map(([id, q]) => { const i = item(id); return `<div class="line"><div class="grow"><b>${esc(i.name)}</b><div class="muted">${money(i.price)} each</div></div><span class="step"><button data-dec="${id}">−</button><span>${q}</span><button data-inc="${id}">+</button></span><b>${money(i.price * q)}</b></div>`; }).join('');
      const sub = subtotal(), b = bill(sub), g = S.ctx.gst;
      bg.querySelector('#sum').innerHTML = `<div class="row muted"><span>Items</span><span>${money(sub)}</span></div><div class="row muted"><span>GST ${g.rate}%${g.mode === 'inclusive' ? ' (included)' : ''}</span><span>${money(b.tax)}</span></div><div class="row tot"><span>Total</span><span>${money(b.total)}</span></div>`;
      bg.querySelector('#sloc').innerHTML = canOrder() ? '' : $('#loc').innerHTML;
      const btn = bg.querySelector('#place'); btn.disabled = S.busy; btn.textContent = S.busy ? 'Placing order…' : canOrder() ? `Place order · ${money(b.total)}` : 'Check location & place order';
    };
    bg.addEventListener('click', async e => {
      if (e.target === bg || e.target.closest('[data-x]')) return bg.remove();
      const inc = e.target.closest('[data-inc]'), dec = e.target.closest('[data-dec]');
      if (inc || dec) { e.stopPropagation(); change(Number((inc || dec).dataset.inc || (inc || dec).dataset.dec), inc ? 1 : -1); draw(); }
      if (e.target.closest('[data-act="loc"]')) { await checkLocation(); draw(); }
      if (e.target.id === 'place') {
        const name = bg.querySelector('#cn')?.value.trim() || '';
        if (counter && !name) { toast('Please enter your name for the pickup order.', true); return; }
        if (counter) ls.set('pbg.name', name);
        S.busy = true; draw();
        try {
          if (!(await checkLocation())) { toast(S.loc.res?.reason || 'We could not confirm you are at the café.', true); return; }
          const ref = ls.get('pbg.pending.' + T, null) || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2));
          ls.set('pbg.pending.' + T, ref);
          const r = await api('order', { items: [...S.cart].map(([id, qty]) => ({ id, qty })), note: bg.querySelector('#note').value, customer: name, location: S.coords, client_ref: ref });
          ls.set('pbg.pending.' + T, null);
          S.cart.clear(); saveCart(); S.mine = [r.order.key, ...S.mine.filter(k => k !== r.order.key)].slice(0, 10); ls.set('pbg.mine.' + T, S.mine);
          bg.remove(); drawMenu(); await loadMine(); toast(`Order #${r.order.number} sent to the kitchen!`); $('#mine').scrollIntoView({ behavior: 'smooth' });
        } catch (err) {
          if (err.status) { ls.set('pbg.pending.' + T, null); toast(err.message, true); if (err.data?.geofence) { S.loc = { state: err.data.geofence.code, res: err.data.geofence }; drawLoc(); } if (err.status === 409) reloadMenu(); }
          else toast("You seem to be offline. Your cart is saved; tap Place order again when you're back online.", true);
        } finally { S.busy = false; if (document.body.contains(bg)) draw(); }
      }
    });
    draw();
  }
  function change(id, d) { const n = (S.cart.get(id) || 0) + d; if (n > 0) S.cart.set(id, Math.min(50, n)); else S.cart.delete(id); saveCart(); drawMenu(); }
  async function reloadMenu() { try { S.ctx = await api('menu'); drawMenu(); } catch { /* offline */ } }

  // ---------- my orders ----------
  async function loadMine() {
    if (!S.mine.length) { $('#mine').innerHTML = ''; return; }
    try { S.orders = await api('status', null, '&keys=' + S.mine.join(',')); } catch { return; }
    const today = new Date().toDateString();
    const list = S.orders.filter(o => new Date(o.created_at).toDateString() === today);
    const label = o => o.status === 'cancelled' ? ['Cancelled', ''] : o.paid ? ['Paid — thank you!', 'ok'] : ({ new: ['Received', ''], preparing: ['Preparing', 'warn'], ready: ['Ready', 'ok'], served: ['Served', 'ok'] })[o.status];
    const open = list.find(o => !o.paid && o.status !== 'cancelled');
    $('#mine').innerHTML = list.length ? `<div class="card" style="text-align:left"><b>Your orders today</b>${list.map(o => { const [l, c] = label(o); return `<div class="line"><div class="grow">#${o.number} · ${o.items.map(i => `${i.qty}× ${esc(i.name)}`).join(', ')}<div class="muted">${money(o.total)}</div></div><span class="chip ${c}">${l}</span></div>`; }).join('')}
      ${open && S.ctx.table.kind === 'table' ? `<div class="row"><button class="btn" style="flex:1" data-req="waiter" data-key="${esc(open.key)}">🙋 Call waiter</button><button class="btn" style="flex:1" data-req="bill" data-key="${esc(open.key)}">🧾 Ask for bill</button></div>` : ''}</div>` : '';
  }

  // ---------- events ----------
  document.addEventListener('click', async e => {
    if (e.target.closest('.sheet-bg')) return;
    const inc = e.target.closest('[data-inc]'), dec = e.target.closest('[data-dec]'), cat = e.target.closest('[data-cat]'), act = e.target.closest('[data-act]')?.dataset.act, rq = e.target.closest('[data-req]');
    if (inc) change(Number(inc.dataset.inc), 1);
    if (dec) change(Number(dec.dataset.dec), -1);
    if (cat) { document.querySelectorAll('.cats button').forEach(b => b.classList.toggle('on', b === cat)); document.getElementById('cat' + cat.dataset.cat)?.scrollIntoView({ behavior: 'smooth' }); }
    if (act === 'cart') openCart();
    if (act === 'loc') checkLocation();
    if (act === 'search') { S.searchOpen = true; const b = $('#sbox'); b.hidden = false; $('#q').focus(); b.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    if (rq) {
      if (!(await checkLocation())) { toast(S.loc.res?.reason || 'We could not confirm you are at the café.', true); return; }
      try { await api('request', { key: rq.dataset.key, type: rq.dataset.req, location: S.coords }); toast(rq.dataset.req === 'bill' ? 'Bill requested. Someone will bring it shortly.' : 'A staff member is on the way.'); }
      catch (err) { toast(err.message, true); }
    }
  });

  (async () => {
    try { S.ctx = await api('menu'); }
    catch (e) { $('#app').innerHTML = `<div class="wrap"><div class="card" style="text-align:center;margin-top:40px"><h2>Sorry!</h2><p>${esc(e.status ? e.message : "We couldn't load the menu. Check your internet and try again.")}</p><button class="btn primary" onclick="location.reload()">Try again</button></div></div>`; return; }
    cur = S.ctx.currency || '₹';
    for (const id of [...S.cart.keys()]) if (!item(id) || item(id).sold_out) S.cart.delete(id);
    shell(); drawMenu(); checkLocation(); loadMine();
    setInterval(() => { if (!document.hidden && S.orders.some(o => !o.paid && o.status !== 'cancelled')) loadMine(); }, 10000);
  })();
})();
