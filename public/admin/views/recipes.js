// Recipes & food costing: ingredients per item (optionally per size), cost per item, margin, low-margin items.
import { api } from '/assets/staff.js';
import { esc, $, $$, money, modal, tableHtml, toast, chip } from '/admin/ui.js';

export async function render(el) {
  let target = 35, data, ings = [], onlyLow = false;
  el.innerHTML = `<div class="toolbar"><label style="margin:0">Target food cost</label><input id="tp" type="number" min="1" max="100" value="${target}" style="width:80px"> %
    <label class="check"><input type="checkbox" id="ol"> Only low-margin items</label><span class="grow"></span><span class="faint">Costs use each ingredient's latest purchase price; they update automatically when you receive goods at a new price.</span></div><div id="rc"></div>`;
  async function load() { [data, ings] = await Promise.all([api('GET', `/costing?target_pct=${target}`), api('GET', '/ingredients')]); draw(); }
  function draw() {
    const rows = data.items.filter(r => !onlyLow || r.low_margin);
    const withRecipe = data.items.filter(r => r.has_recipe);
    const avg = withRecipe.length ? (withRecipe.reduce((s, r) => s + (r.food_cost_pct || 0), 0) / withRecipe.length).toFixed(1) : '—';
    $('#rc').innerHTML = `<div class="kpis"><div class="kpi"><div class="l">Items with recipes</div><div class="v">${new Set(withRecipe.map(r => r.item_id)).size} / ${new Set(data.items.map(r => r.item_id)).size}</div></div>
      <div class="kpi"><div class="l">Average food cost</div><div class="v">${avg}%</div></div><div class="kpi"><div class="l">Low-margin lines</div><div class="v">${data.items.filter(r => r.low_margin).length}</div><div class="d">food cost above ${target}%</div></div></div>` +
      tableHtml([
        { label: 'Item', render: r => `<b>${esc(r.name)}</b>${r.variant ? ` · ${esc(r.variant)}` : ''}<div class="faint">${esc(r.category || '')}</div>` },
        { label: 'Price (net of tax)', render: r => money(r.net_price), r: 1 }, { label: 'Food cost', render: r => r.has_recipe ? money(r.cost) : '—', r: 1 },
        { label: 'Food cost %', render: r => r.has_recipe ? `<b style="color:${r.low_margin ? 'var(--bad)' : 'var(--ok)'}">${r.food_cost_pct}%</b>` : '—', r: 1 },
        { label: 'Gross margin', render: r => r.has_recipe ? money(r.margin) : '—', r: 1 },
        { label: '', render: r => `${r.low_margin ? chip('Low margin', 'bad') : ''} ${r.has_recipe ? '' : chip('No recipe')} <button class="btn sm ghost" data-rec="${r.item_id}">Recipe</button>` },
      ], rows, { empty: 'No items.' });
  }
  async function editRecipe(itemId) {
    const r = await api('GET', `/recipes/${itemId}`);
    const vopts = [['', r.variants.length ? 'All sizes' : '—'], ...r.variants.map(v => [v.id, v.name])];
    const row = (l = {}) => `<div class="row rl" style="margin-bottom:6px"><select data-ing class="grow" style="width:auto">${ings.map(i => `<option value="${i.id}" ${i.id === l.ingredient_id ? 'selected' : ''}>${esc(i.name)} (${esc(i.unit)}, ${money(i.cost_per_unit)}/${esc(i.unit)})</option>`).join('')}</select>
      <input type="number" step="any" min="0" data-q value="${l.qty ?? ''}" placeholder="Qty" style="width:100px">${r.variants.length ? `<select data-v style="width:130px">${vopts.map(([v, n]) => `<option value="${v}" ${String(v) === String(l.variant_id ?? '') ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>` : ''}<button class="btn sm ghost" data-rm>✕</button></div>`;
    const calc = root => {
      const lines = $$('.rl', root).map(x => ({ ing: ings.find(i => i.id === Number($('[data-ing]', x).value)), q: Number($('[data-q]', x).value) || 0, v: $('[data-v]', x)?.value || '' }));
      const groups = r.variants.length ? r.variants.map(v => [v.name, v.price, lines.filter(l => !l.v || l.v === String(v.id))]) : [['Item', r.item.price, lines]];
      $('#rcost', root).innerHTML = groups.map(([n, p, ls]) => { const c = ls.reduce((s, l) => s + l.q * (l.ing?.cost_per_unit || 0), 0); return `<div class="sumrow"><span>${esc(n)} · price ${money(p)}</span><span class="num">cost <b>${money(Math.round(c))}</b> · ${p ? Math.round(c / p * 100) : 0}%</span></div>`; }).join('');
    };
    modal({ title: `Recipe · ${r.item.name}`, wide: true, body: `<p class="hint">Quantities are per one portion. Lines set to “All sizes” apply to every size unless that size has its own lines. Stock is deducted automatically when the item is ordered.</p>
      <div id="rlines">${r.lines.map(row).join('')}</div><button class="btn sm" data-add>＋ Add ingredient</button><div class="card" style="box-shadow:none;margin-top:12px" id="rcost"></div>`,
      onOpen: m => { calc(m.body); m.body.addEventListener('click', e => { if (e.target.closest('[data-add]')) { $('#rlines', m.body).insertAdjacentHTML('beforeend', row()); calc(m.body); } if (e.target.closest('[data-rm]')) { e.target.closest('.rl').remove(); calc(m.body); } }); m.body.addEventListener('input', () => calc(m.body)); m.body.addEventListener('change', () => calc(m.body)); },
      actions: [{ label: 'Cancel' }, { label: 'Save recipe', kind: 'primary', onClick: async ({ el: root }) => {
        const lines = $$('.rl', root).map(x => ({ ingredient_id: Number($('[data-ing]', x).value), qty: Number($('[data-q]', x).value), variant_id: $('[data-v]', x)?.value || null })).filter(l => l.qty > 0);
        await api('PUT', `/recipes/${itemId}`, { lines }); toast('Recipe saved', 'ok'); load();
      } }] });
  }
  el.addEventListener('change', e => { if (e.target.id === 'tp') { target = Number(e.target.value) || 35; load(); } if (e.target.id === 'ol') { onlyLow = e.target.checked; draw(); } });
  el.addEventListener('click', e => { const b = e.target.closest('[data-rec]'); if (b) editRecipe(Number(b.dataset.rec)).catch(err => toast(err.message, 'bad')); });
  await load();
}
