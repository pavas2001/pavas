// Suppliers & purchase orders: create PO, receive goods (batches/expiry, price updates), invoices & payment status, history.
import { api } from '/assets/staff.js';
import { esc, $, $$, money, rupees, paise, modal, formModal, tableHtml, tabs, toast, statusChip } from '/admin/ui.js';
import { fmtDate } from '/assets/lib.js';

export async function render(el) {
  let tab = 'po', pos = [], suppliers = [], ings = [], stock = null, statusF = '';
  el.innerHTML = `<div class="tabs" id="pt"></div><div id="pc"></div>`;
  tabs($('#pt'), [['po', 'Purchase orders'], ['suppliers', 'Suppliers']], tab, t => { tab = t; draw(); });
  async function load() { [pos, suppliers, ings, stock] = await Promise.all([api('GET', `/purchase-orders${statusF ? `?status=${statusF}` : ''}`), api('GET', '/suppliers'), api('GET', '/ingredients'), api('GET', '/stock').catch(() => null)]); draw(); }
  const supDefs = [{ name: 'name', label: 'Name', required: true }, { name: 'contact_person', label: 'Contact person' }, { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'gstin', label: 'GSTIN' }, { name: 'address', label: 'Address' }, { name: 'notes', label: 'Notes', type: 'textarea', span: 1 }, { name: 'active', label: 'Active', type: 'checkbox', default: true }];

  function draw() {
    const c = $('#pc');
    if (tab === 'po') {
      c.innerHTML = `<div class="toolbar"><button class="btn primary" data-newpo>＋ New purchase order</button><button class="btn" data-lowpo>＋ PO from low stock</button><select id="sf"><option value="">All</option>${['draft', 'ordered', 'received', 'cancelled'].map(s => `<option ${s === statusF ? 'selected' : ''}>${s}</option>`).join('')}</select></div>` +
        tableHtml([{ label: 'PO', render: p => `<b>PO-${p.id}</b>` }, { label: 'Date', render: p => esc(fmtDate(p.created_at)) }, { label: 'Supplier', key: 'supplier_name' }, { label: 'Lines', render: p => p.lines.length, r: 1 }, { label: 'Total', render: p => money(p.invoice_amount || p.total), r: 1 }, { label: 'Invoice', render: p => esc(p.invoice_no || '—') }, { label: 'Status', render: p => statusChip(p.status) }, { label: 'Payment', render: p => p.status === 'received' ? `${statusChip(p.payment_status)} <span class="faint">${money(p.amount_paid)}</span>` : '' }, { label: '', render: p => `<button class="btn sm ghost" data-open="${p.id}">Open</button>` }],
          pos, { empty: 'No purchase orders yet.' });
    } else {
      c.innerHTML = `<div class="toolbar"><button class="btn primary" data-newsup>＋ New supplier</button></div>` +
        tableHtml([{ label: 'Supplier', render: s => `<b>${esc(s.name)}</b><div class="faint">${esc(s.contact_person)}</div>` }, { label: 'Phone', key: 'phone' }, { label: 'Email', key: 'email' }, { label: 'GSTIN', key: 'gstin' }, { label: 'Supplies', render: s => esc(ings.filter(i => i.preferred_supplier_id === s.id).map(i => i.name).join(', ')) }, { label: '', render: s => `<button class="btn sm ghost" data-hist="${s.id}">History</button> <button class="btn sm ghost" data-esup="${s.id}">Edit</button>` }], suppliers, { empty: 'No suppliers yet.' });
    }
  }
  function poEditor(po = null, prefill = []) {
    const lines = po ? po.lines : prefill;
    const row = (l = {}) => `<div class="row pl" style="margin-bottom:6px"><select data-i class="grow" style="width:auto">${ings.map(i => `<option value="${i.id}" ${i.id === l.ingredient_id ? 'selected' : ''}>${esc(i.name)} (${esc(i.unit)})</option>`).join('')}</select><input type="number" step="any" data-q value="${l.qty ?? ''}" placeholder="Qty" style="width:100px"><input type="number" step="any" data-c value="${l.unit_cost ?? ''}" placeholder="Paise / unit" style="width:120px" title="Unit cost in paise"><button class="btn sm ghost" data-rm>✕</button></div>`;
    modal({ title: po ? `PO-${po.id}` : 'New purchase order', wide: true, body: `
      <div class="grid g2"><div class="field"><label>Supplier</label><select id="ps">${suppliers.map(s => `<option value="${s.id}" ${s.id === (po?.supplier_id ?? prefill[0]?.supplier_id) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div><div class="field"><label>Notes</label><input id="pn" value="${esc(po?.notes || '')}"></div></div>
      <h4>Lines <span class="faint">(unit cost in paise — e.g. 120 = ₹1.20 per g)</span></h4><div id="plines">${lines.map(row).join('')}</div><button class="btn sm" data-add>＋ Add line</button>`,
      onOpen: m => m.body.addEventListener('click', e => { if (e.target.closest('[data-add]')) $('#plines', m.body).insertAdjacentHTML('beforeend', row()); if (e.target.closest('[data-rm]')) e.target.closest('.pl').remove(); }),
      actions: [{ label: 'Cancel' }, ...['draft', 'ordered'].map(st => ({ label: st === 'draft' ? 'Save draft' : 'Save as ordered', kind: st === 'ordered' ? 'primary' : '', onClick: async ({ el: root }) => {
        const body = { supplier_id: Number($('#ps', root).value), notes: $('#pn', root).value, status: st, lines: $$('.pl', root).map(r => ({ ingredient_id: Number($('[data-i]', r).value), qty: Number($('[data-q]', r).value), unit_cost: Number($('[data-c]', r).value) || 0 })).filter(l => l.qty > 0) };
        if (!body.lines.length) { toast('Add at least one line', 'bad'); return false; }
        await api(po ? 'PUT' : 'POST', po ? `/purchase-orders/${po.id}` : '/purchase-orders', body); toast('Purchase order saved', 'ok'); load();
      } }))] });
  }
  function openPo(po) {
    const editable = ['draft', 'ordered'].includes(po.status);
    modal({ title: `PO-${po.id} · ${po.supplier_name}`, wide: true, body: `<p>${statusChip(po.status)} ${po.status === 'received' ? `${statusChip(po.payment_status)} received ${esc(fmtDate(po.received_at))} into ${esc(po.location_name || '')}` : ''}</p>
      ${editable ? `<div class="grid g2"><div class="field"><label>Supplier invoice no.</label><input id="inv" value="${esc(po.invoice_no)}"></div><div class="field"><label>Invoice amount (₹)</label><input id="ia" type="number" step="0.01" value="${rupees(po.total)}"></div>
        <div class="field"><label>Receive into</label><select id="rl">${(stock?.locations || []).map(l => `<option value="${l.id}" ${l.id === po.location_id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div></div>` : `<p>Invoice <b>${esc(po.invoice_no || '—')}</b> · ${money(po.invoice_amount)} · paid ${money(po.amount_paid)}</p>`}
      <div class="table-wrap"><table class="data"><thead><tr><th>Item</th><th class="r">Ordered</th><th class="r">${editable ? 'Received qty' : 'Received'}</th><th class="r">Unit cost (paise)</th>${editable ? '<th>Batch</th><th>Expiry</th>' : '<th>Batch / expiry</th>'}<th class="r">Line total</th></tr></thead><tbody>
      ${po.lines.map(l => `<tr data-l="${l.id}"><td>${esc(l.ingredient)}</td><td class="r">${l.qty} ${esc(l.unit)}</td>${editable ? `<td class="r"><input type="number" step="any" data-rq value="${l.qty}" style="width:90px"></td><td class="r"><input type="number" step="any" data-rc value="${l.unit_cost}" style="width:90px"></td><td><input data-rb style="width:100px"></td><td><input type="date" data-re style="width:150px"></td>` : `<td class="r">${l.received_qty}</td><td class="r">${l.unit_cost}</td><td>${esc([l.batch_no, l.expiry_date].filter(Boolean).join(' · '))}</td>`}<td class="r num">${money(Math.round(l.qty * l.unit_cost))}</td></tr>`).join('')}
      </tbody></table></div>`,
      actions: [
        ...(editable ? [{ label: 'Cancel PO', kind: 'danger', onClick: async () => { await api('PUT', `/purchase-orders/${po.id}`, { status: 'cancelled' }); load(); } }, { label: 'Edit lines', onClick: () => { poEditor(po); } }, { label: po.status === 'draft' ? 'Mark ordered' : 'Close', onClick: async () => { if (po.status === 'draft') { await api('PUT', `/purchase-orders/${po.id}`, { status: 'ordered' }); load(); } } },
          { label: 'Receive goods', kind: 'primary', onClick: async ({ el: root }) => {
            const lines = $$('[data-l]', root).map(r => ({ id: Number(r.dataset.l), received_qty: $('[data-rq]', r).value, unit_cost: $('[data-rc]', r).value, batch_no: $('[data-rb]', r).value, expiry_date: $('[data-re]', r).value || null }));
            await api('POST', `/purchase-orders/${po.id}/receive`, { lines, invoice_no: $('#inv', root).value, invoice_amount: paise($('#ia', root).value), location_id: Number($('#rl', root).value) });
            toast('Goods received — stock and costs updated', 'ok'); load();
          } }] : []),
        ...(po.status === 'received' && po.payment_status !== 'paid' ? [{ label: 'Record payment', kind: 'primary', onClick: () => { formModal({ title: 'Supplier payment', defs: [{ name: 'amount', label: 'Amount (₹)', type: 'money', required: true }], values: { amount: (po.invoice_amount || po.total) - po.amount_paid }, submit: async d => { await api('POST', `/purchase-orders/${po.id}/pay`, d); load(); } }); } }] : []),
        ...(!editable ? [{ label: 'Close' }] : []),
      ] });
  }
  el.addEventListener('change', e => { if (e.target.id === 'sf') { statusF = e.target.value; load(); } });
  el.addEventListener('click', async e => {
    const q = s => e.target.closest(s);
    try {
      if (q('[data-newpo]')) { if (!suppliers.length) return toast('Add a supplier first', 'bad'); poEditor(); }
      if (q('[data-lowpo]')) {
        const low = (stock?.items || []).filter(i => i.low);
        if (!low.length) return toast('Nothing is low on stock 🎉');
        poEditor(null, low.map(i => ({ ingredient_id: i.id, qty: Math.max(i.low_stock_level * 2 - i.total, i.low_stock_level), unit_cost: i.cost_per_unit, supplier_id: i.preferred_supplier_id })));
      }
      if (q('[data-open]')) openPo(pos.find(p => p.id === Number(q('[data-open]').dataset.open)));
      if (q('[data-newsup]')) formModal({ title: 'New supplier', defs: supDefs, values: { active: true }, submit: async d => { await api('POST', '/suppliers', d); load(); } });
      if (q('[data-esup]')) { const s = suppliers.find(x => x.id === Number(q('[data-esup]').dataset.esup)); formModal({ title: `Edit ${s.name}`, defs: supDefs, values: s, submit: async d => { await api('PUT', `/suppliers/${s.id}`, d); load(); } }); }
      if (q('[data-hist]')) {
        const s = suppliers.find(x => x.id === Number(q('[data-hist]').dataset.hist));
        const h = await api('GET', `/suppliers/${s.id}/history`);
        modal({ title: `${s.name} · history`, wide: true, body: `<h3>Purchase orders</h3>${tableHtml([{ label: 'PO', render: p => `PO-${p.id}` }, { label: 'Date', render: p => esc(fmtDate(p.created_at)) }, { label: 'Total', render: p => money(p.invoice_amount || p.total), r: 1 }, { label: 'Status', render: p => statusChip(p.status) }, { label: 'Payment', render: p => statusChip(p.payment_status) }], h.orders)}
          <h3 style="margin-top:16px">Purchase prices</h3>${tableHtml([{ label: 'Item', key: 'ingredient' }, { label: 'Unit cost', render: p => `${money(p.unit_cost)} / ${esc(p.unit)}`, r: 1 }, { label: 'Received', render: p => esc(fmtDate(p.received_at)) }], h.prices)}`, actions: [{ label: 'Close' }] });
      }
    } catch (err) { toast(err.message, 'bad'); }
  });
  await load();
}
