// Inventory: stock levels per location, received/used/wasted/adjusted/transfer, counts & reconciliation, ingredients, locations, batches/expiry.
import { api } from '/assets/staff.js';
import { esc, $, $$, money, formModal, modal, tableHtml, tabs, toast, chip, confirmBox } from '/admin/ui.js';
import { fmtDate } from '/assets/lib.js';

const KINDS = [['ingredient', 'Ingredient'], ['packaging', 'Packaging'], ['supply', 'Other supply']];
export async function render(el) {
  let tab = 'stock', stock = { locations: [], items: [], expiring: [] }, suppliers = [], filter = '';
  el.innerHTML = `<div class="tabs" id="it"></div><div id="ic"></div>`;
  tabs($('#it'), [['stock', 'Stock levels'], ['moves', 'Movement history'], ['count', 'Stock count'], ['ingredients', 'Items & suppliers'], ['locations', 'Storage locations']], tab, t => { tab = t; draw(); });
  async function load() { [stock, suppliers] = await Promise.all([api('GET', '/stock'), api('GET', '/suppliers').catch(() => [])]); draw(); }
  const qty = (n, u) => `${+Number(n).toFixed(3)} ${esc(u)}`;
  const ingOpts = () => stock.items.map(i => [i.id, `${i.name} (${i.unit})`]);
  const locOpts = () => stock.locations.map(l => [l.id, l.name]);

  function moveModal(type = 'received', ingredient_id = '') {
    const defs = [
      { name: 'type', label: 'Type', type: 'select', options: [['received', 'Received (stock in)'], ['used', 'Used (manual)'], ['wasted', 'Wasted / spoiled'], ['adjusted', 'Adjustment (+/−)'], ['transfer', 'Transfer between locations']], default: type },
      { name: 'ingredient_id', label: 'Item', type: 'select', options: ingOpts(), required: true, default: ingredient_id },
      { name: 'qty', label: 'Quantity', type: 'number', step: 'any', required: true, hint: 'For adjustments use a negative number to reduce stock' },
      { name: 'location_id', label: 'Location', type: 'select', options: locOpts(), required: true },
      { name: 'to_location_id', label: 'To location (transfer)', type: 'select', options: [['', '—'], ...locOpts()] },
      { name: 'unit_cost', label: 'Unit cost (paise per unit)', type: 'number', step: 'any', hint: 'Received only. e.g. 120 = ₹1.20 per g' },
      { name: 'batch_no', label: 'Batch / lot no.' }, { name: 'expiry_date', label: 'Expiry date', type: 'date' },
      { name: 'reference', label: 'Reference', placeholder: 'Invoice, reason…' }, { name: 'update_cost', label: 'Update item cost to this price', type: 'checkbox' }, { name: 'note', label: 'Note', span: 1 },
    ];
    formModal({ title: 'Record stock movement', defs, submit: async d => { await api('POST', '/stock/movements', d); toast('Stock updated', 'ok'); load(); } });
  }

  async function draw() {
    const c = $('#ic');
    if (tab === 'stock') {
      const list = stock.items.filter(i => !filter || (filter === 'low' ? i.low : i.kind === filter));
      const value = stock.items.reduce((s, i) => s + i.value, 0);
      c.innerHTML = `<div class="toolbar"><button class="btn primary" data-move="received">＋ Receive stock</button><button class="btn" data-move="wasted">Record waste</button><button class="btn" data-move="adjusted">Adjust</button><button class="btn" data-move="transfer">Transfer</button>
        <select id="kf"><option value="">All items</option><option value="low" ${filter === 'low' ? 'selected' : ''}>Low stock only</option>${KINDS.map(([k, l]) => `<option value="${k}" ${filter === k ? 'selected' : ''}>${l}</option>`).join('')}</select><span class="grow"></span><b>Stock value ${money(value)}</b></div>
        ${stock.expiring.length ? `<div class="banner warn"><b>Expiring within 3 days:</b> ${stock.expiring.map(x => `${esc(x.name)} batch ${esc(x.batch_no || '—')} (${esc(x.expiry_date)}, ${esc(x.location)})`).join(' · ')}</div>` : ''}` +
        tableHtml([
          { label: 'Item', render: i => `<b>${esc(i.name)}</b> ${i.low ? chip('Low', 'bad') : ''}<div class="faint">${esc(KINDS.find(k => k[0] === i.kind)?.[1] || i.kind)}${i.supplier_name ? ` · ${esc(i.supplier_name)}` : ''}</div>` },
          ...stock.locations.map(l => ({ label: l.name, render: i => qty(i.by_location[l.id] || 0, i.unit), r: 1 })),
          { label: 'Total', render: i => `<b>${qty(i.total, i.unit)}</b>`, r: 1 }, { label: 'Alert at', render: i => i.low_stock_level ? qty(i.low_stock_level, i.unit) : '—', r: 1 },
          { label: 'Cost / unit', render: i => money(i.cost_per_unit), r: 1 }, { label: 'Value', render: i => money(i.value), r: 1 },
          { label: '', render: i => `<button class="btn sm ghost" data-move="received" data-ing="${i.id}">＋</button> <button class="btn sm ghost" data-hist="${i.id}">History</button>` },
        ], list, { empty: 'No inventory items yet. Add them under “Items & suppliers”.' });
    } else if (tab === 'moves') {
      const rows = await api('GET', `/stock/movements${filter && /^\d+$/.test(filter) ? `?ingredient_id=${filter}` : ''}`);
      c.innerHTML = `<div class="toolbar"><select id="mf"><option value="">All items</option>${stock.items.map(i => `<option value="${i.id}" ${String(i.id) === filter ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select></div>` +
        tableHtml([{ label: 'When', render: m => esc(fmtDate(m.created_at)) }, { label: 'Item', key: 'ingredient' }, { label: 'Type', render: m => chip(m.type, { received: 'ok', used: '', wasted: 'bad', adjusted: 'warn', count: 'info', transfer: 'info' }[m.type]) },
          { label: 'Qty', render: m => `<span style="color:${m.qty < 0 ? 'var(--bad)' : 'var(--ok)'}">${m.qty > 0 ? '+' : ''}${qty(m.qty, m.unit)}</span>`, r: 1 }, { label: 'Location', key: 'location' },
          { label: 'Batch / expiry', render: m => esc([m.batch_no, m.expiry_date].filter(Boolean).join(' · ')) }, { label: 'Reference', render: m => esc([m.reference, m.note].filter(Boolean).join(' — ')) }, { label: 'By', render: m => esc(m.user_name || 'system') }], rows);
    } else if (tab === 'count') {
      const loc = stock.locations[0];
      const counts = await api('GET', '/stock/counts');
      c.innerHTML = `<div class="card"><div class="row between"><h3 style="margin:0">New stock count</h3><select id="cl">${stock.locations.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></div>
        <p class="hint">Enter what you physically counted. Leave blank to skip an item. Differences are booked as count adjustments.</p>
        <div class="table-wrap"><table class="data"><thead><tr><th>Item</th><th class="r">System</th><th class="r">Counted</th></tr></thead><tbody id="crows"></tbody></table></div>
        <div class="row" style="margin-top:10px"><input id="cn" placeholder="Note (optional)" class="grow" style="width:auto"><button class="btn primary" data-savecount>Save count & reconcile</button></div></div>
        <div class="card"><h3>Past counts</h3>${tableHtml([{ label: 'When', render: x => esc(fmtDate(x.created_at)) }, { label: 'Location', key: 'location' }, { label: 'By', key: 'user_name' }, { label: 'Lines', render: x => x.lines.length, r: 1 }, { label: 'Variances', render: x => x.lines.filter(l => l.diff).map(l => `${esc(stock.items.find(i => i.id === l.ingredient_id)?.name || '?')} ${l.diff > 0 ? '+' : ''}${l.diff}`).join(', ') || 'none' }], counts, { empty: 'No counts yet.' })}</div>`;
      const fill = lid => { $('#crows').innerHTML = stock.items.map(i => `<tr><td>${esc(i.name)}</td><td class="r num">${qty(i.by_location[lid] || 0, i.unit)}</td><td class="r"><input type="number" step="any" data-cnt="${i.id}" style="width:120px"></td></tr>`).join(''); };
      if (loc) fill(loc.id);
      $('#cl').onchange = e => fill(Number(e.target.value));
    } else if (tab === 'ingredients') {
      c.innerHTML = `<div class="toolbar"><button class="btn primary" data-newing>＋ New inventory item</button></div>` +
        tableHtml([{ label: 'Name', render: i => `<b>${esc(i.name)}</b>` }, { label: 'Kind', render: i => esc(KINDS.find(k => k[0] === i.kind)?.[1] || i.kind) }, { label: 'Unit', key: 'unit' }, { label: 'Cost / unit', render: i => money(i.cost_per_unit), r: 1 }, { label: 'Low-stock alert', render: i => i.low_stock_level ? qty(i.low_stock_level, i.unit) : 'off', r: 1 }, { label: 'Preferred supplier', render: i => esc(i.supplier_name || '—') }, { label: '', render: i => `<button class="btn sm ghost" data-eing="${i.id}">Edit</button>` }], stock.items);
    } else if (tab === 'locations') {
      c.innerHTML = `<div class="toolbar"><button class="btn primary" data-newloc>＋ New location</button><span class="faint">e.g. Main store, Walk-in fridge, Bar. Sales deduct from the default location.</span></div>` +
        tableHtml([{ label: 'Location', key: 'name' }, { label: 'Default', render: l => l.is_default ? chip('Default', 'brand') : '' }, { label: '', render: l => `<button class="btn sm ghost" data-eloc="${l.id}">Edit</button>` }], stock.locations);
    }
  }
  const ingDefs = () => [{ name: 'name', label: 'Name', required: true }, { name: 'kind', label: 'Kind', type: 'select', options: KINDS }, { name: 'unit', label: 'Unit', required: true, placeholder: 'g, ml, pc, kg, l…' }, { name: 'cost_per_unit', label: 'Cost per unit (paise)', type: 'number', step: 'any', hint: 'e.g. 120 = ₹1.20 per unit' }, { name: 'low_stock_level', label: 'Low-stock alert level', type: 'number', step: 'any' }, { name: 'preferred_supplier_id', label: 'Preferred supplier', type: 'select', options: [['', '— none —'], ...suppliers.map(s => [s.id, s.name])] }, { name: 'active', label: 'Active', type: 'checkbox', default: true }];

  el.addEventListener('change', e => { if (e.target.id === 'kf' || e.target.id === 'mf') { filter = e.target.value; draw(); } });
  el.addEventListener('click', async e => {
    const q = s => e.target.closest(s);
    try {
      if (q('[data-move]')) moveModal(q('[data-move]').dataset.move, q('[data-move]').dataset.ing || '');
      if (q('[data-hist]')) { filter = q('[data-hist]').dataset.hist; tab = 'moves'; $$('#it button').forEach(b => b.classList.toggle('on', b.dataset.tab === 'moves')); draw(); }
      if (q('[data-newing]')) formModal({ title: 'New inventory item', defs: ingDefs(), values: { kind: 'ingredient', active: true }, submit: async d => { await api('POST', '/ingredients', d); load(); } });
      if (q('[data-eing]')) { const i = stock.items.find(x => x.id === Number(q('[data-eing]').dataset.eing)); formModal({ title: `Edit ${i.name}`, defs: ingDefs(), values: i, submit: async d => { await api('PUT', `/ingredients/${i.id}`, d); toast('Saved — recipe costs update automatically', 'ok'); load(); } }); }
      if (q('[data-newloc]')) formModal({ title: 'New location', defs: [{ name: 'name', label: 'Name', required: true }, { name: 'is_default', label: 'Default (sales deduct from here)', type: 'checkbox' }], submit: async d => { await api('POST', '/stock-locations', d); load(); } });
      if (q('[data-eloc]')) { const l = stock.locations.find(x => x.id === Number(q('[data-eloc]').dataset.eloc)); formModal({ title: 'Edit location', values: l, defs: [{ name: 'name', label: 'Name', required: true }, { name: 'is_default', label: 'Default', type: 'checkbox' }], submit: async d => { await api('PUT', `/stock-locations/${l.id}`, d); load(); } }); }
      if (q('[data-savecount]')) {
        const lines = $$('[data-cnt]').filter(i => i.value !== '').map(i => ({ ingredient_id: Number(i.dataset.cnt), counted: Number(i.value) }));
        if (!lines.length) return toast('Enter at least one counted quantity', 'bad');
        if (!(await confirmBox('Save stock count?', `${lines.length} item(s) will be reconciled to your counted quantities.`, { danger: false, label: 'Save' }))) return;
        const r = await api('POST', '/stock/counts', { location_id: Number($('#cl').value), lines, note: $('#cn').value });
        const v = r.lines.filter(l => l.diff);
        modal({ title: 'Count saved', body: v.length ? tableHtml([{ label: 'Item', render: l => esc(stock.items.find(i => i.id === l.ingredient_id)?.name) }, { label: 'Expected', key: 'expected', r: 1 }, { label: 'Counted', key: 'counted', r: 1 }, { label: 'Variance', render: l => `${l.diff > 0 ? '+' : ''}${l.diff}`, r: 1 }], v) : '<p>No variances — stock matches.</p>', actions: [{ label: 'OK', kind: 'primary' }] });
        load();
      }
    } catch (err) { toast(err.message, 'bad'); }
  });
  await load();
}
