// Back office (PHP edition): kitchen, counter & bills, menu with photos, tables & QR codes, sales, setup.
(() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m, bad) => { const t = document.createElement('div'); t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = m; $('#toasts').append(t); setTimeout(() => t.remove(), 4000); };
  let ME = null, cur = '₹';
  const money = n => cur + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  async function api(a, body, { form, query = '' } = {}) {
    const opt = { credentials: 'same-origin', headers: {} };
    if (body || form) { opt.method = 'POST'; opt.headers['X-CSRF'] = ME?.csrf || ''; if (form) opt.body = form; else { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); } }
    const r = await fetch(`api.php?a=${a}${query}`, opt);
    const d = await r.json().catch(() => ({ error: 'Unexpected response from the server.' }));
    if (r.status === 401 && a !== 'login') { showLogin(); throw new Error('Please sign in.'); }
    if (!r.ok) throw Object.assign(new Error(d.error || 'Request failed'), { status: r.status });
    return d;
  }
  const guard = fn => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, true); } };

  // ---------- login ----------
  function showLogin() { $('#app').hidden = true; $('#login').hidden = false; $('#lu').focus(); }
  $('#lf').addEventListener('submit', async e => {
    e.preventDefault(); $('#le').textContent = '';
    try { await api('login', { username: $('#lu').value.trim(), password: $('#lp').value }); $('#lp').value = ''; await boot(); }
    catch (err) { $('#le').textContent = err.message; }
  });
  $('#logout').onclick = async () => { await api('logout', {}).catch(() => {}); location.reload(); };

  // ---------- shell & routing ----------
  const VIEWS = { kitchen: 'Kitchen', counter: 'Counter & bills', menu: 'Menu', tables: 'Tables & QR codes', sales: 'Sales', setup: 'Setup' };
  let view = null, timer = null;
  async function boot() {
    try { ME = await api('me'); } catch { return showLogin(); }
    cur = ME.currency || '₹';
    $('#login').hidden = true; $('#app').hidden = false;
    $('#cafeName').textContent = ME.cafe; $('#who').textContent = `${ME.user.name} · ${ME.user.role}`;
    $('#tabs').innerHTML = ME.areas.map(k => `<a href="#${k}" data-v="${k}">${VIEWS[k]}<span class="badge" id="b-${k}" hidden></span></a>`).join('');
    route();
  }
  addEventListener('hashchange', route);
  function route() {
    if (!ME) return;
    const h = location.hash.slice(1); view = ME.areas.includes(h) ? h : ME.areas[0];
    document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.v === view));
    clearInterval(timer); timer = null;
    ({ kitchen: kitchen, counter: counter, menu: menu, tables: tables, sales: sales, setup: setup })[view]();
  }
  const poll = (fn, ms = 8000) => { fn(); timer = setInterval(() => { if (!document.hidden) fn(); }, ms); };

  // ---------- orders (kitchen + counter) ----------
  let seenNew = null, audio;
  function chime() { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); const t = audio.currentTime; [880, 1320].forEach((f, i) => { const o = audio.createOscillator(), g = audio.createGain(); o.frequency.value = f; o.connect(g); g.connect(audio.destination); g.gain.setValueAtTime(.0001, t + i * .18); g.gain.exponentialRampToValueAtTime(.25, t + i * .18 + .02); g.gain.exponentialRampToValueAtTime(.0001, t + i * .18 + .3); o.start(t + i * .18); o.stop(t + i * .18 + .32); }); } catch { /* no audio */ } }
  async function loadOrders() {
    const orders = await api('orders');
    const ids = new Set(orders.filter(o => o.status === 'new').map(o => o.id));
    if (seenNew && [...ids].some(id => !seenNew.has(id))) { chime(); toast('New order received'); }
    seenNew = ids;
    const nb = $('#b-kitchen'); if (nb) { nb.hidden = !ids.size; nb.textContent = ids.size; }
    const alerts = orders.filter(o => !o.paid && o.status !== 'cancelled' && (o.bill_requested || o.waiter_called)).length;
    const cb = $('#b-counter'); if (cb) { cb.hidden = !alerts; cb.textContent = alerts; }
    return orders;
  }
  const age = o => Math.floor((Date.now() - Date.parse(o.created_at)) / 60000);
  function kitchen() {
    $('#view').innerHTML = `<p class="hint">Tickets older than ${ME.late_min} minutes turn red. Keep this screen open: new orders appear automatically (tap anywhere once to enable the sound).</p><div class="board" id="kb"></div>`;
    const draw = guard(async () => {
      const os = (await loadOrders()).filter(o => ['new', 'preparing', 'ready'].includes(o.status) && !o.paid);
      const col = (st, label, next, btn) => { const list = os.filter(o => o.status === st).sort((a, b) => a.created_at.localeCompare(b.created_at));
        return `<div><div class="colh"><span>${label}</span><span>${list.length}</span></div>${list.map(o => `<div class="ticket ${st} ${st !== 'ready' && age(o) >= ME.late_min ? 'late' : ''}">
          <div class="row between"><span class="where">${esc(o.table)}</span><span class="faint num">#${o.number} · ${age(o)} min</span></div>
          ${o.customer ? `<div class="muted">${esc(o.customer)}</div>` : ''}<ul>${o.items.map(i => `<li><b>${i.qty}×</b> ${esc(i.name)}</li>`).join('')}</ul>${o.note ? `<div class="note">“${esc(o.note)}”</div>` : ''}
          <div class="row">${st !== 'new' ? `<button class="btn sm" data-id="${o.id}" data-st="${st === 'ready' ? 'preparing' : 'new'}" aria-label="Move back">↩</button>` : ''}<button class="btn primary" style="flex:1" data-id="${o.id}" data-st="${next}">${btn}</button></div></div>`).join('') || `<div class="empty">${st === 'new' ? 'Waiting for orders…' : 'Nothing here'}</div>`}</div>`; };
      const kb = $('#kb'); if (!kb) return;
      kb.innerHTML = col('new', 'New', 'preparing', 'Start') + col('preparing', 'Preparing', 'ready', 'Ready') + col('ready', 'Ready to serve', 'served', 'Served');
    });
    $('#kb').onclick = guard(async e => { const b = e.target.closest('[data-st]'); if (!b) return; b.disabled = true; await api('order_status', { id: Number(b.dataset.id), status: b.dataset.st }); draw(); });
    poll(draw);
  }
  function counter() {
    $('#view').innerHTML = `<div class="card"><div class="row between"><h2>Open bills</h2><span class="muted" id="csum"></span></div><div id="cl"></div></div>`;
    const draw = guard(async () => {
      const open = (await loadOrders()).filter(o => !o.paid && o.status !== 'cancelled');
      if (!$('#cl')) return;
      $('#csum').textContent = open.length ? `${open.length} open · ${money(open.reduce((s, o) => s + o.total, 0))} to collect` : '';
      $('#cl').innerHTML = open.length ? `<div class="tbl"><table><thead><tr><th>Order</th><th>Items</th><th>Status</th><th class="r">Total</th><th>Take payment</th></tr></thead><tbody>${open.map(o => `<tr>
        <td><b>${esc(o.table)}</b> <span class="faint num">#${o.number}</span>${o.customer ? `<div class="muted">${esc(o.customer)}</div>` : ''}${o.waiter_called ? `<div><span class="chip alert">Waiter called</span> <button class="btn sm" data-done="${o.id}">Done</button></div>` : ''}</td>
        <td class="muted">${o.items.map(i => `${i.qty}× ${esc(i.name)}`).join(', ')}${o.note ? `<div class="note">“${esc(o.note)}”</div>` : ''}</td>
        <td><span class="chip ${o.status}">${o.status}</span>${o.bill_requested ? ' <span class="chip alert">Bill requested</span>' : ''}</td>
        <td class="r num"><b>${money(o.total)}</b><div class="faint">GST ${money(o.tax)}</div></td>
        <td><div class="row">${['Cash', 'UPI', 'Card'].map(m => `<button class="btn sm ${m === 'UPI' ? 'primary' : ''}" data-pay="${o.id}" data-m="${m}">${m}</button>`).join('')}<button class="btn sm danger" data-cancel="${o.id}">Cancel</button></div></td></tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">No open bills. Orders from the table QR menus appear here.</div>';
    });
    let arm = null;
    $('#cl').onclick = guard(async e => {
      const p = e.target.closest('[data-pay]'), c = e.target.closest('[data-cancel]'), d = e.target.closest('[data-done]');
      if (p) { await api('pay', { id: Number(p.dataset.pay), method: p.dataset.m }); toast(`Paid by ${p.dataset.m}`); draw(); }
      if (d) { await api('waiter_done', { id: Number(d.dataset.done) }); draw(); }
      if (c) { if (arm !== c.dataset.cancel) { arm = c.dataset.cancel; c.textContent = 'Tap again'; return; } arm = null; await api('cancel', { id: Number(c.dataset.cancel) }); toast('Order cancelled'); draw(); }
    });
    poll(draw);
  }

  // ---------- menu ----------
  function menu() {
    $('#view').innerHTML = `<div class="cols"><div class="card"><div class="row between"><h2>Items</h2><span class="hint">“Sold out” hides an item from guests at once.</span></div><div class="tbl" id="ml"></div></div>
      <form class="card" id="mf"><h2 id="mt">Add an item</h2><input type="hidden" id="mid">
        <label>Name<input id="mname" required maxlength="80"></label><label>Description<input id="mdesc" maxlength="200"></label>
        <div class="g2"><label>Price (${esc(cur)})<input id="mprice" type="number" min="0" step="0.01" required></label><label>Category<input id="mcat" list="mcats" maxlength="40" placeholder="Coffee"></label></div>
        <datalist id="mcats"></datalist><label>Diet<select id="mdiet"><option value="veg">Veg</option><option value="egg">Contains egg</option><option value="nonveg">Non-veg</option></select></label>
        <div class="row" id="photoRow" hidden><span class="pic lg" id="mpic"></span><div class="grid" style="gap:6px"><label>Product photo (JPG, PNG or WebP)<input type="file" id="mphoto" accept="image/jpeg,image/png,image/webp"></label><button class="btn sm" type="button" id="mphotoDel">Remove photo</button></div></div>
        <p class="hint" id="photoHint">Save the item first, then you can add its photo.</p>
        <div class="row"><button class="btn primary" id="msave">Add item</button><button class="btn" type="button" id="mcancel" hidden>Cancel</button></div></form></div>`;
    let items = [];
    const pic = i => i.photo ? `<img src="${esc(i.photo)}" alt="">` : PBArt.svg(i);
    const draw = guard(async () => {
      items = await api('items');
      $('#mcats').innerHTML = [...new Set(items.map(i => i.cat))].map(c => `<option value="${esc(c)}">`).join('');
      $('#ml').innerHTML = items.length ? `<table><thead><tr><th>Item</th><th>Category</th><th class="r">Price</th><th></th></tr></thead><tbody>${items.map(i => `<tr>
        <td><div class="row" style="flex-wrap:nowrap"><span class="pic">${pic(i)}</span><span><b>${esc(i.name)}</b>${i.sold_out ? ' <span class="chip alert">Sold out</span>' : ''}</span></div></td>
        <td class="muted">${esc(i.cat)}</td><td class="r num">${money(i.price)}</td>
        <td><div class="row" style="justify-content:flex-end"><button class="btn sm" data-sold="${i.id}">${i.sold_out ? 'Back in stock' : 'Sold out'}</button><button class="btn sm" data-edit="${i.id}">Edit</button><button class="btn sm danger" data-del="${i.id}">Delete</button></div></td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">No items yet. Add your first dish with the form.</div>';
    });
    const reset = () => { $('#mf').reset(); $('#mid').value = ''; $('#mt').textContent = 'Add an item'; $('#msave').textContent = 'Add item'; $('#mcancel').hidden = true; $('#photoRow').hidden = true; $('#photoHint').hidden = false; };
    const edit = i => { $('#mid').value = i.id; $('#mname').value = i.name; $('#mdesc').value = i.desc; $('#mprice').value = i.price; $('#mcat').value = i.cat; $('#mdiet').value = i.diet; $('#mt').textContent = 'Edit item'; $('#msave').textContent = 'Save changes'; $('#mcancel').hidden = false; $('#photoRow').hidden = false; $('#photoHint').hidden = true; $('#mpic').innerHTML = pic(i); $('#mphotoDel').hidden = !i.photo; $('#mname').focus(); };
    let arm = null;
    $('#ml').onclick = guard(async e => {
      const s = e.target.closest('[data-sold]'), ed = e.target.closest('[data-edit]'), dl = e.target.closest('[data-del]');
      if (s) { const i = items.find(x => x.id === Number(s.dataset.sold)); await api('item_soldout', { id: i.id, sold_out: !i.sold_out }); draw(); }
      if (ed) edit(items.find(x => x.id === Number(ed.dataset.edit)));
      if (dl) { if (arm !== dl.dataset.del) { arm = dl.dataset.del; dl.textContent = 'Tap again'; return; } arm = null; await api('item_delete', { id: Number(dl.dataset.del) }); toast('Item deleted'); reset(); draw(); }
    });
    $('#mcancel').onclick = reset;
    $('#mf').onsubmit = guard(async e => {
      e.preventDefault();
      const r = await api('item_save', { id: Number($('#mid').value) || null, name: $('#mname').value, desc: $('#mdesc').value, price: Number($('#mprice').value), cat: $('#mcat').value, diet: $('#mdiet').value, sold_out: items.find(i => i.id === Number($('#mid').value))?.sold_out || false });
      toast($('#mid').value ? 'Item saved' : 'Item added. You can add a photo now.');
      await draw(); edit(r);
    });
    $('#mphoto').onchange = guard(async () => {
      const f = $('#mphoto').files[0]; if (!f) return;
      const fd = new FormData(); fd.append('id', $('#mid').value); fd.append('photo', f);
      $('#mpic').innerHTML = '<span class="faint" style="font-size:12px;padding:8px;display:block">Uploading…</span>';
      const r = await api('item_photo', null, { form: fd }); $('#mphoto').value = '';
      await draw(); edit(items.find(i => i.id === Number($('#mid').value))); toast('Photo saved');
      void r;
    });
    $('#mphotoDel').onclick = guard(async () => { const fd = new FormData(); fd.append('id', $('#mid').value); fd.append('remove', '1'); await api('item_photo', null, { form: fd }); await draw(); edit(items.find(i => i.id === Number($('#mid').value))); });
    draw();
  }

  // ---------- tables & QR ----------
  function tables() {
    const base = location.href.replace(/admin\.php.*$/, '').replace(/#.*$/, '');
    $('#view').innerHTML = `<div class="card noprint"><div class="row between"><h2>Tables &amp; QR codes</h2><div class="row"><label class="row" style="grid-auto-flow:column">Tables <input type="number" id="tcount" min="1" max="60" style="width:90px"></label><button class="btn" id="tsave">Update</button><button class="btn primary" onclick="print()">Print QR codes</button></div></div>
      ${location.protocol !== 'https:' ? '<p class="banner bad">This site is not on https yet. Turn on SSL for your domain before printing: guests\' phones only share location on https links.</p>' : ''}
      <p class="hint">Each table has its own QR code. “New code” makes an old printed QR stop working. The Counter code is for takeaway orders.</p></div><div class="qrs" id="qrs" style="margin-top:14px"></div>`;
    let rows = [];
    const draw = guard(async () => {
      rows = await api('tables');
      $('#tcount').value = rows.filter(r => r.kind === 'table').length;
      $('#qrs').innerHTML = rows.map(r => `<div class="qr"><strong>${esc(ME.cafe)}</strong><div class="code" id="qr${r.id}"></div><b>${r.kind === 'counter' ? 'Takeaway' : 'Table ' + esc(r.label)}</b><span>Scan to view menu &amp; order</span>
        <small>${esc(base)}menu.php?t=${esc(r.token)}</small><div class="row noprint"><a class="btn sm" href="menu.php?t=${encodeURIComponent(r.token)}" target="_blank" rel="noopener">Open</a><button class="btn sm" data-regen="${r.id}">New code</button></div></div>`).join('');
      for (const r of rows) {
        const el = document.getElementById('qr' + r.id);
        const qr = qrcode(0, 'M'); qr.addData(`${base}menu.php?t=${r.token}`); qr.make();
        el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      }
    });
    let arm = null;
    $('#qrs').onclick = guard(async e => { const b = e.target.closest('[data-regen]'); if (!b) return; if (arm !== b.dataset.regen) { arm = b.dataset.regen; b.textContent = 'Tap again'; return; } arm = null; await api('table_regen', { id: Number(b.dataset.regen) }); toast('New QR code made. Reprint it.'); draw(); });
    $('#tsave').onclick = guard(async () => { await api('tables_count', { count: Number($('#tcount').value) }); toast('Tables updated'); draw(); });
    draw();
  }

  // ---------- sales ----------
  function sales() {
    $('#view').innerHTML = `<div class="row" style="margin-bottom:12px"><label class="row" style="grid-auto-flow:column">Day <input type="date" id="sday" style="width:auto"></label></div><div id="sv"></div>`;
    const draw = guard(async () => {
      const s = await api('sales', null, { query: $('#sday').value ? '&day=' + $('#sday').value : '' });
      if (!$('#sday').value) { $('#sday').value = s.day; $('#sday').max = s.day; }
      const bars = (obj, fmt) => { const e = Object.entries(obj), max = Math.max(1, ...e.map(x => x[1])); return e.map(([k, v]) => `<div class="hbar"><span>${esc(k)}</span><div class="t"><i style="width:${v / max * 100}%"></i></div><span class="num">${fmt(v)}</span></div>`).join('') || '<p class="faint">No paid orders.</p>'; };
      $('#sv').innerHTML = `<div class="kpis"><div class="kpi"><div class="l">Sales</div><div class="v">${money(s.gross)}</div></div><div class="kpi"><div class="l">Paid orders</div><div class="v">${s.orders}</div></div><div class="kpi"><div class="l">Average order</div><div class="v">${money(s.avg)}</div></div><div class="kpi"><div class="l">GST collected</div><div class="v">${money(s.tax)}</div></div><div class="kpi"><div class="l">Cancelled</div><div class="v">${s.cancelled}</div></div></div>
        <div class="cols" style="margin-top:14px"><div class="card"><h2>Best sellers</h2>${bars(s.items, v => v + ' sold')}</div><div class="card"><h2>Payment methods</h2>${bars(s.methods, money)}</div></div>`;
    });
    $('#sday').onchange = draw; draw();
  }

  // ---------- setup ----------
  function setup() {
    $('#view').innerHTML = '<div class="empty">Loading…</div>';
    (guard(async () => {
      const s = await api('settings'), staff = await api('staff');
      $('#view').innerHTML = `<div class="cols">
        <div class="grid">
          <div class="card"><h2>📍 Café location &amp; ordering radius</h2>
            <p class="banner info">Guests can browse the menu anywhere, but orders (and waiter / bill requests) are accepted only when their phone is inside this radius. The server checks it on every order.</p>
            <div class="g2"><label>Latitude<input id="slat" type="number" step="any" value="${s.lat ?? ''}"></label><label>Longitude<input id="slng" type="number" step="any" value="${s.lng ?? ''}"></label></div>
            <div class="row"><button class="btn" id="here">📍 Use my current location</button><button class="btn" id="test">Test from where I am</button></div><p class="hint" id="geomsg">Stand at the café entrance when you use your location.</p>
            <div class="g2"><label>Ordering radius (m)<input id="srad" type="number" min="10" max="50000" value="${s.radius_m}"></label><label>GPS error allowance (m)<input id="stol" type="number" min="0" max="500" value="${s.tolerance_m}"></label>
              <label>Reject fixes less precise than (m)<input id="smax" type="number" min="20" max="10000" value="${s.max_accuracy_m}"></label><label>Kitchen: flag tickets after (min)<input id="slate" type="number" min="1" max="120" value="${s.late_min}"></label></div>
            <label class="check"><input type="checkbox" id="sgeo" ${s.geofence ? 'checked' : ''}> Only accept orders within the radius</label></div>
          <div class="card"><h2>Bill</h2><div class="g2"><label>GST rate (%)<input id="sgst" type="number" min="0" max="28" step="0.5" value="${s.gst}"></label><label>Menu prices are<select id="smode"><option value="exclusive" ${s.gst_mode === 'exclusive' ? 'selected' : ''}>before GST (GST added)</option><option value="inclusive" ${s.gst_mode === 'inclusive' ? 'selected' : ''}>including GST</option></select></label></div></div>
        </div>
        <div class="grid">
          <div class="card"><h2>QR menu page</h2>
            <div class="row"><span class="pic lg" style="background:#fff">${s.logo_url ? `<img src="${esc(s.logo_url)}" alt="Logo" style="object-fit:contain">` : '<span class="faint" style="display:grid;place-items:center;height:100%">No logo</span>'}</span><label>Café logo<input type="file" id="slogo" accept="image/jpeg,image/png,image/webp"></label></div>
            <label>Café name<input id="sname" maxlength="80" value="${esc(s.cafe_name)}"></label>
            <div class="g2"><label>Big title<input id="stitle" maxlength="40" value="${esc(s.title)}"></label><label>Accent colour<input id="saccent" type="color" value="${esc(s.accent)}"></label></div>
            <label>Welcome line ({cafe} = café name)<input id="swel" maxlength="120" value="${esc(s.welcome)}"></label>
            <label>Tagline<input id="stag" maxlength="200" value="${esc(s.tagline)}"></label>
            <label>Instagram handle (optional)<input id="sig" maxlength="60" value="${esc(s.instagram)}"></label></div>
          <div class="card"><h2>Staff logins</h2><div class="tbl"><table><tbody>${staff.map(u => `<tr><td><b>${esc(u.name)}</b><div class="faint">@${esc(u.username)}</div></td><td><span class="chip">${esc(u.role)}</span>${u.active ? '' : ' <span class="chip alert">disabled</span>'}</td><td class="r"><button class="btn sm" data-u="${u.id}">Edit</button></td></tr>`).join('')}</tbody></table></div>
            <form class="grid" id="uf"><input type="hidden" id="uid"><div class="g2"><label>Name<input id="uname" required maxlength="100"></label><label>Username<input id="uuser" maxlength="40" autocomplete="off"></label>
              <label>Role<select id="urole"><option value="cashier">Cashier (kitchen, counter, sales)</option><option value="kitchen">Kitchen only</option><option value="admin">Admin (everything)</option></select></label><label>Password<input id="upass" type="password" autocomplete="new-password" placeholder="8+ characters"></label></div>
              <label class="check" id="uactiveRow" hidden><input type="checkbox" id="uactive" checked> Account active</label>
              <div class="row"><button class="btn primary" id="usave">Add staff login</button><button class="btn" type="button" id="ucancel" hidden>Cancel</button></div></form></div>
        </div></div>
        <div class="row" style="margin-top:14px;position:sticky;bottom:12px"><button class="btn primary" id="ssave" style="min-height:46px;padding:0 26px">Save setup</button></div>`;
      const pos = () => new Promise((res, rej) => { if (!navigator.geolocation) return rej(new Error('This browser cannot share location.')); navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }), e => rej(new Error(e.code === 1 ? 'Location permission denied. Allow it for this site (needs https).' : 'Could not get your location.')), { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }); });
      $('#here').onclick = async () => { $('#geomsg').textContent = 'Getting your location…'; try { const p = await pos(); $('#slat').value = p.lat.toFixed(6); $('#slng').value = p.lng.toFixed(6); $('#geomsg').textContent = `Filled in (±${Math.round(p.accuracy)} m). Press Save setup.`; } catch (e) { $('#geomsg').textContent = e.message; } };
      $('#test').onclick = async () => { $('#geomsg').textContent = 'Checking…'; try { const r = await api('geofence_test', await pos()); $('#geomsg').textContent = r.allowed ? `✅ An order from here would be accepted${r.distance_m != null ? ` (${r.distance_m} m away)` : ''}.` : `🚫 Blocked: ${r.reason}`; } catch (e) { $('#geomsg').textContent = e.message; } };
      $('#slogo').onchange = guard(async () => { const f = $('#slogo').files[0]; if (!f) return; const fd = new FormData(); fd.append('logo', f); await api('logo', null, { form: fd }); toast('Logo saved'); setup(); });
      $('#ssave').onclick = guard(async () => {
        await api('settings_save', { lat: $('#slat').value, lng: $('#slng').value, radius_m: $('#srad').value, tolerance_m: $('#stol').value, max_accuracy_m: $('#smax').value, late_min: $('#slate').value, geofence: $('#sgeo').checked,
          gst: $('#sgst').value, gst_mode: $('#smode').value, cafe_name: $('#sname').value, title: $('#stitle').value, accent: $('#saccent').value, welcome: $('#swel').value, tagline: $('#stag').value, instagram: $('#sig').value });
        ME = await api('me'); $('#cafeName').textContent = ME.cafe; toast('Setup saved');
      });
      const ureset = () => { $('#uf').reset(); $('#uid').value = ''; $('#uuser').disabled = false; $('#usave').textContent = 'Add staff login'; $('#ucancel').hidden = true; $('#uactiveRow').hidden = true; };
      document.querySelectorAll('[data-u]').forEach(b => b.onclick = () => { const u = staff.find(x => x.id == b.dataset.u); $('#uid').value = u.id; $('#uname').value = u.name; $('#uuser').value = u.username; $('#uuser').disabled = true; $('#urole').value = u.role; $('#upass').value = ''; $('#upass').placeholder = 'Leave blank to keep'; $('#uactive').checked = !!Number(u.active); $('#uactiveRow').hidden = false; $('#usave').textContent = 'Save login'; $('#ucancel').hidden = false; });
      $('#ucancel').onclick = ureset;
      $('#uf').onsubmit = guard(async e => { e.preventDefault(); await api('staff_save', { id: Number($('#uid').value) || null, name: $('#uname').value, username: $('#uuser').value, role: $('#urole').value, password: $('#upass').value, active: $('#uactive').checked }); toast('Staff login saved'); setup(); });
    }))();
  }

  boot();
})();
