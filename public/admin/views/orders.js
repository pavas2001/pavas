import { api } from '/assets/staff.js';
import { onLive } from '/admin/app.js';
import { esc, $, money, tableHtml, statusChip, chip, today } from '/admin/ui.js';
import { fmtDate } from '/assets/lib.js';
import { openOrder } from '/admin/views/orderpanel.js';

export async function render(el) {
  const f = { status: 'active', type: '', q: '', from: '', to: '' };
  el.innerHTML = `<div class="toolbar">
      <select id="fs"><option value="active">Active (open & billed)</option><option value="">All</option><option value="open">Open</option><option value="billed">Billed</option><option value="paid">Paid</option><option value="cancelled">Cancelled</option><option value="merged">Merged</option></select>
      <select id="ft"><option value="">All types</option><option value="dine_in">Dine-in</option><option value="takeaway">Takeaway</option><option value="pickup">Pickup</option></select>
      <input type="date" id="ff" aria-label="From"><input type="date" id="fto" aria-label="To">
      <input id="fq" type="search" class="grow" placeholder="Order no., invoice, customer or phone">
    </div><div id="list"></div>`;
  const load = async () => {
    const p = new URLSearchParams({ status: f.status, type: f.type, q: f.q });
    if (f.from) p.set('from', new Date(`${f.from}T00:00`).toISOString());
    if (f.to) p.set('to', new Date(new Date(`${f.to}T00:00`).getTime() + 86400e3).toISOString());
    const rows = await api('GET', `/orders?${p}`);
    $('#list').innerHTML = tableHtml([
      { label: 'No.', render: r => `<b>#${r.number}</b>` },
      { label: 'Invoice', render: r => esc(r.invoice_no || '—') },
      { label: 'Time', render: r => esc(fmtDate(r.created_at)) },
      { label: 'Where', render: r => `${esc(r.table_label || r.type.replace('_', '-'))}${r.pickup_code ? ` · ${esc(r.pickup_code)}` : ''}` },
      { label: 'Source', render: r => chip(r.source === 'qr' ? 'QR' : 'POS', r.source === 'qr' ? 'info' : '') },
      { label: 'Customer', render: r => esc(r.customer_name || r.customer_phone || '') },
      { label: 'Items', key: 'item_count', r: 1 },
      { label: 'Total', render: r => money(r.total), r: 1 },
      { label: 'Paid', render: r => money(r.paid - r.refunded), r: 1 },
      { label: 'Status', render: r => statusChip(r.status) },
      { label: 'Staff', render: r => esc(r.created_by_name || '') },
    ], rows, { empty: 'No orders match.', rowAttr: r => `class="click" data-o="${r.id}"` });
  };
  el.addEventListener('change', e => { if (e.target.id === 'fs') f.status = e.target.value; if (e.target.id === 'ft') f.type = e.target.value; if (e.target.id === 'ff') f.from = e.target.value; if (e.target.id === 'fto') f.to = e.target.value; load(); });
  let t; el.addEventListener('input', e => { if (e.target.id === 'fq') { f.q = e.target.value; clearTimeout(t); t = setTimeout(load, 300); } });
  el.addEventListener('click', e => { const r = e.target.closest('[data-o]'); if (r) openOrder(Number(r.dataset.o), { onChange: load }); });
  void today;
  await load();
  let d; onLive(type => { if (type.startsWith('order.')) { clearTimeout(d); d = setTimeout(load, 700); } });
}
