// Menu management: categories, items (variants, modifiers/extras, combos, schedule, prices), stations, import/export.
import { api, downloadFile } from '/assets/staff.js';
import { esc, $, $$, money, rupees, paise, modal, formModal, fieldsHtml, readFields, tableHtml, tabs, toast, chip, confirmBox } from '/admin/ui.js';
import { dietMark } from '/assets/lib.js';

export async function render(el) {
  let tab = 'items', items = [], cats = [], stations = [], catF = '', q = '';
  el.innerHTML = `<div class="tabs" id="mt"></div><div id="mc"></div>`;
  tabs($('#mt'), [['items', 'Items'], ['categories', 'Categories'], ['stations', 'Kitchen stations'], ['io', 'Import / export']], tab, t => { tab = t; draw(); });
  async function load() { [items, cats, stations] = await Promise.all([api('GET', '/items'), api('GET', '/categories'), api('GET', '/stations')]); draw(); }

  function draw() {
    const c = $('#mc');
    if (tab === 'items') {
      const list = items.filter(i => (!catF || String(i.category_id) === catF) && (!q || i.name.toLowerCase().includes(q.toLowerCase())));
      c.innerHTML = `<div class="toolbar"><button class="btn primary" data-new>＋ New item</button><select id="cf"><option value="">All categories</option>${cats.map(x => `<option value="${x.id}" ${String(x.id) === catF ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select><input id="iq" type="search" class="grow" placeholder="Search items" value="${esc(q)}"></div>` +
        tableHtml([
          { label: 'Item', render: i => `${dietMark(i.diet)} <b>${esc(i.name)}</b> ${i.featured ? chip('Popular', 'brand') : ''}${i.recommended ? chip('Recommended', 'info') : ''}${i.is_combo ? chip('Combo') : ''}<div class="faint">${esc(i.category_name || 'Uncategorised')}${i.station_name ? ` · ${esc(i.station_name)}` : ''}${i.available_from ? ` · ${esc(i.available_from)}–${esc(i.available_to)}` : ''}</div>` },
          { label: 'Dine-in', render: i => i.variants.length ? i.variants.map(v => `${esc(v.name)} ${money(v.price)}`).join('<br>') : money(i.price), r: 1 },
          { label: 'Takeaway', render: i => i.variants.length ? i.variants.map(v => v.takeaway_price != null ? money(v.takeaway_price) : '—').join('<br>') : i.takeaway_price != null ? money(i.takeaway_price) : '—', r: 1 },
          { label: 'Options', render: i => i.groups.map(g => `${esc(g.name)} (${g.options.length})`).join(', ') || '—' },
          { label: 'Food cost', render: i => i.recipe_cost ? `${money(i.recipe_cost)} <span class="faint">${Math.round(i.recipe_cost / (i.variants[0]?.price || i.price) * 100)}%</span>` : '<span class="faint">no recipe</span>', r: 1 },
          { label: 'On menu', render: i => `<input type="checkbox" data-avail="${i.id}" ${i.available ? 'checked' : ''} aria-label="Available">` },
          { label: 'Sold out', render: i => `<input type="checkbox" data-sold="${i.id}" ${i.sold_out ? 'checked' : ''} aria-label="Sold out">` },
          { label: '', render: i => `<button class="btn sm ghost" data-edit="${i.id}">Edit</button>` },
        ], list, { empty: 'No items yet — add your first dish.' });
    } else if (tab === 'categories') {
      c.innerHTML = `<div class="toolbar"><button class="btn primary" data-newcat>＋ New category</button><span class="faint">Set a time window to show a category only at certain hours (e.g. Breakfast 07:00–11:30).</span></div>` +
        tableHtml([{ label: 'Sort', key: 'sort', r: 1 }, { label: 'Category', render: x => `<b>${esc(x.name)}</b><div class="faint">${esc(x.description)}</div>` }, { label: 'Hours', render: x => x.available_from ? `${esc(x.available_from)}–${esc(x.available_to)}` : 'All day' }, { label: 'Items', render: x => items.filter(i => i.category_id === x.id).length, r: 1 }, { label: 'Active', render: x => x.active ? chip('Yes', 'ok') : chip('Hidden') }, { label: '', render: x => `<button class="btn sm ghost" data-ecat="${x.id}">Edit</button> <button class="btn sm ghost" data-dcat="${x.id}">Delete</button>` }], cats);
    } else if (tab === 'stations') {
      c.innerHTML = `<div class="toolbar"><button class="btn primary" data-newst>＋ New station</button><span class="faint">Stations split the kitchen display — e.g. hot food, drinks bar, desserts.</span></div>` +
        tableHtml([{ label: 'Station', key: 'name' }, { label: 'Items', render: s => items.filter(i => i.station_id === s.id).length, r: 1 }, { label: '', render: s => `<button class="btn sm ghost" data-est="${s.id}">Rename</button> <button class="btn sm ghost" data-dst="${s.id}">Delete</button>` }], stations);
    } else {
      c.innerHTML = `<div class="cols"><div class="card"><h3>Export</h3><p class="muted">Download the menu to back it up, edit it in a spreadsheet, or copy it to another branch.</p><div class="row"><button class="btn" data-exp="csv">Download CSV</button><button class="btn" data-exp="json">Download JSON (full, with options)</button></div></div>
        <div class="card"><h3>Import</h3><p class="muted">CSV columns: <code>category, name, description, price, takeaway_price, diet, available, sold_out, featured, station, available_from, available_to, photo_url</code>. Prices in rupees. Existing items (same name and category) are updated.</p><input type="file" id="imp" accept=".csv,.json,text/csv,application/json"><button class="btn primary" style="margin-top:8px" data-imp>Import file</button></div></div>`;
    }
  }

  function itemEditor(it = null) {
    const v = it || { available: true, diet: 'veg', price: null, variants: [], groups: [] };
    const defs = [
      { name: 'name', label: 'Name', required: true }, { name: 'category_id', label: 'Category', type: 'select', options: [['', '— none —'], ...cats.map(c => [c.id, c.name])] },
      { name: 'price', label: 'Dine-in price', type: 'money', required: true, hint: 'Used when the item has no sizes' }, { name: 'takeaway_price', label: 'Takeaway / pickup price', type: 'money', hint: 'Leave blank to use the dine-in price' },
      { name: 'description', label: 'Description', type: 'textarea', span: 1 }, { name: 'photo_url', label: 'Photo URL', span: 1, placeholder: 'https://…/photo.jpg' },
      { name: 'diet', label: 'Diet', type: 'select', options: [['veg', 'Veg'], ['nonveg', 'Non-veg'], ['egg', 'Contains egg'], ['vegan', 'Vegan']] }, { name: 'station_id', label: 'Kitchen station', type: 'select', options: [['', '— none —'], ...stations.map(s => [s.id, s.name])] },
      { name: 'available_from', label: 'Available from', type: 'time', hint: 'Optional schedule (e.g. breakfast)' }, { name: 'available_to', label: 'Available until', type: 'time' },
      { name: 'available_days', label: 'Days (0=Sun … 6=Sat)', placeholder: 'e.g. 1,2,3,4,5 — blank = every day' }, { name: 'sort', label: 'Sort order', type: 'number' },
      { name: 'available', label: 'Show on menu', type: 'checkbox' }, { name: 'sold_out', label: 'Sold out', type: 'checkbox' },
      { name: 'featured', label: 'Feature as popular', type: 'checkbox' }, { name: 'recommended', label: 'Recommended', type: 'checkbox' },
      { name: 'is_combo', label: 'Combo', type: 'checkbox' }, { name: 'combo_items', label: 'Combo includes', placeholder: 'e.g. Sandwich, Cold coffee' },
    ];
    const vrow = (x = {}) => `<div class="row vrow" style="margin-bottom:6px"><input placeholder="Size / variant (e.g. Large)" value="${esc(x.name || '')}" data-vn class="grow" style="width:auto"><input type="number" step="0.01" placeholder="Dine-in ₹" value="${rupees(x.price)}" data-vp style="width:110px"><input type="number" step="0.01" placeholder="Takeaway ₹" value="${rupees(x.takeaway_price)}" data-vt style="width:110px"><button class="btn sm ghost" data-rm>✕</button></div>`;
    const orow = (x = {}) => `<div class="row orow" style="margin:4px 0 4px 16px"><input placeholder="Option (e.g. Extra cheese)" value="${esc(x.name || '')}" data-on class="grow" style="width:auto"><input type="number" step="0.01" placeholder="+₹" value="${rupees(x.price)}" data-op style="width:100px"><button class="btn sm ghost" data-rm>✕</button></div>`;
    const grow = (g = { options: [] }) => `<div class="card grow-g" style="box-shadow:none;margin-bottom:8px;padding:10px"><div class="row"><input placeholder="Group (e.g. Extras, Spice level)" value="${esc(g.name || '')}" data-gn class="grow" style="width:auto"><label style="margin:0">min</label><input type="number" min="0" value="${g.min_select ?? 0}" data-gmin style="width:64px"><label style="margin:0">max</label><input type="number" min="0" value="${g.max_select ?? 1}" data-gmax style="width:64px" title="0 = no limit"><button class="btn sm ghost" data-rmg>✕</button></div><div data-opts>${g.options.map(orow).join('')}</div><button class="btn sm ghost" data-addo>＋ option</button></div>`;
    modal({
      title: it ? `Edit ${it.name}` : 'New item', wide: true,
      body: `<form onsubmit="return false">${fieldsHtml(defs, v)}
        <h3 style="margin-top:8px">Sizes / variants</h3><p class="hint">If you add sizes, the guest must pick one and its price replaces the item price.</p><div id="vars">${v.variants.map(vrow).join('')}</div><button class="btn sm" data-addv>＋ Add size</button>
        <h3 style="margin-top:16px">Add-ons &amp; options</h3><p class="hint">Groups like “Extras” (min 0, max 3) or “Spice level” (min 1, max 1 = required choice).</p><div id="grps">${v.groups.map(grow).join('')}</div><button class="btn sm" data-addg>＋ Add option group</button></form>`,
      onOpen: m => m.body.addEventListener('click', e => {
        if (e.target.closest('[data-addv]')) $('#vars', m.body).insertAdjacentHTML('beforeend', vrow());
        if (e.target.closest('[data-addg]')) $('#grps', m.body).insertAdjacentHTML('beforeend', grow());
        if (e.target.closest('[data-addo]')) e.target.closest('.grow-g').querySelector('[data-opts]').insertAdjacentHTML('beforeend', orow());
        if (e.target.closest('[data-rm]')) e.target.closest('.vrow,.orow').remove();
        if (e.target.closest('[data-rmg]')) e.target.closest('.grow-g').remove();
      }),
      actions: [
        ...(it ? [{ label: 'Delete', kind: 'danger', onClick: async () => { if (!(await confirmBox(`Delete ${it.name}?`, 'Past orders keep their copy of the item.'))) return false; await api('DELETE', `/items/${it.id}`); load(); } }] : []),
        { label: 'Cancel' },
        { label: 'Save', kind: 'primary', onClick: async ({ el: root }) => {
          const d = readFields(root, defs);
          d.variants = $$('.vrow', root).map(r => ({ name: $('[data-vn]', r).value.trim(), price: paise($('[data-vp]', r).value) || 0, takeaway_price: paise($('[data-vt]', r).value) })).filter(x => x.name);
          d.groups = $$('.grow-g', root).map(g => ({ name: $('[data-gn]', g).value.trim(), min_select: Number($('[data-gmin]', g).value) || 0, max_select: Number($('[data-gmax]', g).value) || 0, options: $$('.orow', g).map(o => ({ name: $('[data-on]', o).value.trim(), price: paise($('[data-op]', o).value) || 0 })).filter(o => o.name) })).filter(g => g.name);
          if (d.price == null && d.variants.length) d.price = d.variants[0].price;
          await api(it ? 'PUT' : 'POST', it ? `/items/${it.id}` : '/items', d);
          toast('Saved', 'ok'); load();
        } },
      ],
    });
  }
  const catDefs = [{ name: 'name', label: 'Name', required: true }, { name: 'sort', label: 'Sort order', type: 'number' }, { name: 'description', label: 'Description', span: 1 }, { name: 'available_from', label: 'Shown from', type: 'time' }, { name: 'available_to', label: 'Shown until', type: 'time' }, { name: 'active', label: 'Active', type: 'checkbox', default: true }];

  el.addEventListener('input', e => { if (e.target.id === 'iq') { q = e.target.value; const pos = e.target.selectionStart; draw(); const i = $('#iq'); i.focus(); i.setSelectionRange(pos, pos); } });
  el.addEventListener('change', async e => {
    try {
      if (e.target.id === 'cf') { catF = e.target.value; draw(); }
      if (e.target.dataset.sold) { await api('POST', `/items/${e.target.dataset.sold}/sold-out`, { sold_out: e.target.checked }); toast(e.target.checked ? 'Marked sold out' : 'Back in stock', 'ok'); load(); }
      if (e.target.dataset.avail) { await api('PUT', `/items/${e.target.dataset.avail}`, { available: e.target.checked }); load(); }
    } catch (err) { toast(err.message, 'bad'); }
  });
  el.addEventListener('click', async e => {
    const q2 = s => e.target.closest(s);
    try {
      if (q2('[data-new]')) itemEditor();
      if (q2('[data-edit]')) itemEditor(items.find(i => i.id === Number(q2('[data-edit]').dataset.edit)));
      if (q2('[data-newcat]')) formModal({ title: 'New category', defs: catDefs, values: { active: true, sort: cats.length }, submit: async d => { await api('POST', '/categories', d); load(); } });
      if (q2('[data-ecat]')) { const c = cats.find(x => x.id === Number(q2('[data-ecat]').dataset.ecat)); formModal({ title: 'Edit category', defs: catDefs, values: c, submit: async d => { await api('PUT', `/categories/${c.id}`, d); load(); } }); }
      if (q2('[data-dcat]')) { if (await confirmBox('Delete category?', 'Its items become uncategorised.')) { await api('DELETE', `/categories/${q2('[data-dcat]').dataset.dcat}`); load(); } }
      if (q2('[data-newst]')) formModal({ title: 'New station', defs: [{ name: 'name', label: 'Name', required: true }], submit: async d => { await api('POST', '/stations', d); load(); } });
      if (q2('[data-est]')) { const s = stations.find(x => x.id === Number(q2('[data-est]').dataset.est)); formModal({ title: 'Rename station', defs: [{ name: 'name', label: 'Name', required: true }], values: s, submit: async d => { await api('PUT', `/stations/${s.id}`, d); load(); } }); }
      if (q2('[data-dst]')) { if (await confirmBox('Delete station?', 'Items keep working but show on all kitchen screens.')) { await api('DELETE', `/stations/${q2('[data-dst]').dataset.dst}`); load(); } }
      if (q2('[data-exp]')) { const f = q2('[data-exp]').dataset.exp; downloadFile(`/menu/export.${f}`, `pixberry-menu.${f}`); }
      if (q2('[data-imp]')) {
        const file = $('#imp').files[0]; if (!file) return toast('Choose a file first', 'bad');
        const r = await api('POST', '/menu/import', await file.text());
        toast(`Imported: ${r.created} new, ${r.updated} updated`, 'ok'); load();
      }
    } catch (err) { toast(err.message, 'bad'); }
  });
  await load();
}
