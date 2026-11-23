// Point of sale: build an order for a table / takeaway / pickup and send it to the kitchen.
import { api, can } from '/assets/staff.js';
import { onLive, queueOrder } from '/admin/app.js';
import { esc, $, $$, money, modal, toast, chip } from '/admin/ui.js';
import { dietMark, uid, store } from '/assets/lib.js';
import { openOrder } from '/admin/views/orderpanel.js';

export async function render(el, [orderIdParam]) {
  const S = { items: [], cats: [], tables: [], cat: '', q: '', cart: [], type: 'dine_in', table_id: store.get('pb.pos.table') || '', customer: { name: '', phone: '' }, addTo: null };
  [S.items, S.cats, S.tables] = await Promise.all([api('GET', '/items'), api('GET', '/categories'), api('GET', '/tables')]);
  if (orderIdParam) {
    S.addTo = await api('GET', `/orders/${orderIdParam}`).catch(() => null);
    if (S.addTo) { S.type = S.addTo.type; S.table_id = S.addTo.table_id || ''; }
  }
  const price = it => (S.type !== 'dine_in' && it.takeaway_price != null ? it.takeaway_price : it.price);

  el.innerHTML = `<div class="pos">
    <div>
      <div class="toolbar">
        ${S.addTo ? `<div class="banner info grow" style="margin:0">Adding items to order <b>#${S.addTo.number}</b>${S.addTo.table_label ? ` · ${esc(S.addTo.table_label)}` : ''} <a href="#/pos">start a new order instead</a></div>` : `
        <select id="ptype" aria-label="Order type"><option value="dine_in">Dine-in</option><option value="takeaway">Takeaway</option><option value="pickup">Pickup</option></select>
        <select id="ptable" aria-label="Table"></select>`}
        <input id="pq" type="search" placeholder="Search items" class="grow">
      </div>
      <div class="tabs" id="pcats"></div>
      <div class="pos-items" id="pitems"></div>
    </div>
    <div class="card pos-cart" id="pcart"></div>
  </div>`;

  function drawTables() {
    const sel = $('#ptable'); if (!sel) return;
    sel.hidden = S.type !== 'dine_in';
    sel.innerHTML = `<option value="">Choose table…</option>${S.tables.filter(t => t.kind === 'table').map(t => `<option value="${t.id}" ${String(t.id) === String(S.table_id) ? 'selected' : ''}>${esc(t.label)}${t.order_id ? ` · #${t.order_number} ${money(t.order_total)}` : t.merged_into_label ? ` → ${esc(t.merged_into_label)}` : ''}</option>`).join('')}`;
  }
  function drawCats() {
    $('#pcats').innerHTML = [['', 'All'], ...S.cats.filter(c => c.active).map(c => [c.id, c.name])].map(([k, l]) => `<button data-c="${k}" class="${String(k) === String(S.cat) ? 'on' : ''}">${esc(l)}</button>`).join('');
  }
  function drawItems() {
    const q = S.q.toLowerCase();
    const list = S.items.filter(i => i.available && (!S.cat || i.category_id === Number(S.cat)) && (!q || i.name.toLowerCase().includes(q)));
    $('#pitems').innerHTML = list.map(i => `<button class="pos-item ${i.sold_out ? 'out' : ''}" data-i="${i.id}" ${i.sold_out ? 'title="Sold out"' : ''}>
      <span>${dietMark(i.diet)} <b>${esc(i.name)}</b></span><span class="row between"><span class="num">${i.variants.length ? 'from ' : ''}${money(i.variants.length ? Math.min(...i.variants.map(v => S.type !== 'dine_in' && v.takeaway_price != null ? v.takeaway_price : v.price)) : price(i))}</span>${i.sold_out ? chip('Sold out', 'bad') : ''}</span></button>`).join('') || '<div class="empty">No items.</div>';
  }
  function drawCart() {
    const total = S.cart.reduce((s, l) => s + l.unit_price * l.qty, 0);
    const table = S.tables.find(t => String(t.id) === String(S.table_id));
    const existing = !S.addTo && S.type === 'dine_in' && table?.order_id ? table : null;
    $('#pcart').innerHTML = `
      <div class="row between"><h2 style="margin:0">${S.addTo ? `Add to #${S.addTo.number}` : 'New order'}</h2>${S.cart.length ? '<button class="btn sm ghost" data-clear>Clear</button>' : ''}</div>
      ${existing ? `<div class="banner warn" style="margin-top:10px">${esc(table.label)} already has order #${table.order_number} (${money(table.order_total)}). Items will be added to it. <button class="btn sm" data-open="${table.order_id}">Open</button></div>` : ''}
      ${S.type !== 'dine_in' && !S.addTo ? `<div class="grid g2" style="margin-top:10px"><input id="cname" placeholder="Customer name" value="${esc(S.customer.name)}"><input id="cphone" placeholder="Phone" value="${esc(S.customer.phone)}"></div>` : ''}
      <div style="margin-top:8px">${S.cart.map((l, i) => `<div class="cart-line"><div class="grow"><b>${esc(l.name)}</b>${l.variant ? ` · ${esc(l.variant)}` : ''}${l.mods.length ? `<div class="faint">+ ${esc(l.mods.join(', '))}</div>` : ''}
        <input data-note="${i}" value="${esc(l.notes)}" placeholder="Note" style="min-height:28px;padding:3px 8px;margin-top:4px;font-size:12px"></div>
        <span class="qty"><button data-d="-1" data-l="${i}">−</button><span>${l.qty}</span><button data-d="1" data-l="${i}">+</button></span><span class="num" style="min-width:70px;text-align:right">${money(l.unit_price * l.qty)}</span></div>`).join('') || '<div class="empty">Tap items to add them.</div>'}</div>
      <div class="sumrow big"><span>Items total</span><span class="num">${money(total)}</span></div>
      <p class="hint">Tax, service charge and discounts are applied on the bill.</p>
      <div class="grid g2" style="margin-top:8px">
        <button class="btn primary lg" data-send ${S.cart.length ? '' : 'disabled'}>Send to kitchen</button>
        <button class="btn lg" data-send="pay" ${S.cart.length && can('payments.take') ? '' : 'disabled'}>Send &amp; bill</button>
      </div>`;
  }
  function addLine(it, variant, mods, qty = 1) {
    const sig = `${it.id}|${variant?.id || ''}|${mods.map(m => m.id).join(',')}`;
    const same = S.cart.find(l => l.sig === sig && !l.notes);
    if (same) same.qty += qty;
    else S.cart.push({ sig, item_id: it.id, variant_id: variant?.id || null, modifier_ids: mods.map(m => m.id), qty, notes: '', name: it.name, variant: variant?.name || '', mods: mods.map(m => m.name),
      unit_price: (variant ? (S.type !== 'dine_in' && variant.takeaway_price != null ? variant.takeaway_price : variant.price) : price(it)) + mods.reduce((s, m) => s + m.price, 0) });
    drawCart();
  }
  function chooseOptions(it) {
    modal({ title: it.name, body: `
      ${it.variants.length ? `<h4>Size</h4>${it.variants.map((v, i) => `<label class="check" style="padding:6px 0"><input type="radio" name="v" value="${v.id}" ${i ? '' : 'checked'}> ${esc(v.name)} · ${money(S.type !== 'dine_in' && v.takeaway_price != null ? v.takeaway_price : v.price)}</label>`).join('')}` : ''}
      ${it.groups.map(g => `<h4 style="margin-top:12px">${esc(g.name)} <span class="faint">${g.min_select ? `(choose ${g.min_select}${g.max_select > g.min_select ? `–${g.max_select}` : ''})` : '(optional)'}</span></h4>
        ${g.options.map(o => `<label class="check" style="padding:6px 0"><input type="${g.max_select === 1 ? 'radio' : 'checkbox'}" name="g${g.id}" value="${o.id}"> ${esc(o.name)}${o.price ? ` +${money(o.price)}` : ''}</label>`).join('')}`).join('')}`,
      actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', onClick: ({ el }) => {
        const vid = Number(el.querySelector('[name=v]:checked')?.value);
        const mods = [];
        for (const g of it.groups) {
          const picked = [...el.querySelectorAll(`[name=g${g.id}]:checked`)].map(x => g.options.find(o => o.id === Number(x.value)));
          if (picked.length < g.min_select) { toast(`Choose ${g.name}`, 'bad'); return false; }
          if (g.max_select && picked.length > g.max_select) { toast(`Up to ${g.max_select} for ${g.name}`, 'bad'); return false; }
          mods.push(...picked);
        }
        addLine(it, it.variants.find(v => v.id === vid), mods);
      } }] });
  }
  async function send(andPay) {
    const lines = S.cart.map(l => ({ item_id: l.item_id, variant_id: l.variant_id, modifier_ids: l.modifier_ids, qty: l.qty, notes: l.notes }));
    let order;
    try {
      if (S.addTo) order = await api('POST', `/orders/${S.addTo.id}/items`, { items: lines });
      else {
        if (S.type === 'dine_in' && !S.table_id) return toast('Choose a table', 'bad');
        const body = { client_ref: uid(), type: S.type, table_id: S.type === 'dine_in' ? Number(S.table_id) : null, items: lines, customer: S.customer };
        try { order = await api('POST', '/orders', body); }
        catch (e) { if (!e.status) { queueOrder(body); S.cart = []; drawCart(); toast('Offline — order saved and will be sent automatically', 'bad'); return; } throw e; }
      }
    } catch (e) { toast(e.message, 'bad'); return; }
    toast(`Order #${order.number} sent to kitchen`, 'ok');
    S.cart = []; S.customer = { name: '', phone: '' };
    S.tables = await api('GET', '/tables');
    if (S.addTo) { location.hash = '#/pos'; }
    drawTables(); drawCart();
    if (andPay) { await api('POST', `/orders/${order.id}/bill`).catch(() => {}); openOrder(order.id); }
  }

  el.addEventListener('change', e => {
    if (e.target.id === 'ptype') { S.type = e.target.value; S.cart.forEach(l => { const it = S.items.find(i => i.id === l.item_id); const v = it.variants.find(x => x.id === l.variant_id); const mods = it.groups.flatMap(g => g.options).filter(o => l.modifier_ids.includes(o.id)); l.unit_price = (v ? (S.type !== 'dine_in' && v.takeaway_price != null ? v.takeaway_price : v.price) : price(it)) + mods.reduce((s, m) => s + m.price, 0); }); drawTables(); drawItems(); drawCart(); }
    if (e.target.id === 'ptable') { S.table_id = e.target.value; store.set('pb.pos.table', S.table_id); drawCart(); }
    if (e.target.dataset.note != null) S.cart[Number(e.target.dataset.note)].notes = e.target.value;
    if (e.target.id === 'cname') S.customer.name = e.target.value;
    if (e.target.id === 'cphone') S.customer.phone = e.target.value;
  });
  el.addEventListener('input', e => { if (e.target.id === 'pq') { S.q = e.target.value; drawItems(); } });
  el.addEventListener('click', e => {
    const c = e.target.closest('[data-c]'); if (c) { S.cat = c.dataset.c; drawCats(); drawItems(); }
    const i = e.target.closest('[data-i]');
    if (i) { const it = S.items.find(x => x.id === Number(i.dataset.i)); if (it.sold_out) return toast(`${it.name} is sold out`, 'bad'); if (it.variants.length || it.groups.length) chooseOptions(it); else addLine(it, null, []); }
    const d = e.target.closest('[data-d]'); if (d) { const l = S.cart[Number(d.dataset.l)]; l.qty += Number(d.dataset.d); if (l.qty <= 0) S.cart.splice(Number(d.dataset.l), 1); drawCart(); }
    if (e.target.closest('[data-clear]')) { S.cart = []; drawCart(); }
    const s = e.target.closest('[data-send]'); if (s) send(s.dataset.send === 'pay');
    const op = e.target.closest('[data-open]'); if (op) openOrder(Number(op.dataset.open));
  });
  if ($('#ptype')) $('#ptype').value = S.type;
  drawTables(); drawCats(); drawItems(); drawCart();
  onLive(async type => {
    if (type === 'menu.changed') { S.items = await api('GET', '/items'); drawItems(); }
    if (type.startsWith('order.') || type === 'table.updated') { S.tables = await api('GET', '/tables'); drawTables(); drawCart(); }
  });
  void $$;
}
