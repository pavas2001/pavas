// Audit log: who changed what (prices, discounts, cancellations, refunds, settings, sign-ins…).
import { api } from '/assets/staff.js';
import { esc, $, tableHtml } from '/admin/ui.js';
import { fmtDate } from '/assets/lib.js';

export async function render(el) {
  let q = '', user = '';
  const staff = await api('GET', '/staff').catch(() => []);
  el.innerHTML = `<div class="toolbar"><select id="au"><option value="">All staff</option>${staff.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select><input id="aq" type="search" class="grow" placeholder="Filter by action or details (e.g. refund, discount, price, settings)"></div><div id="al"></div>`;
  async function load() {
    const rows = await api('GET', `/audit?${new URLSearchParams({ q, user_id: user })}`);
    $('#al').innerHTML = tableHtml([{ label: 'When', render: r => esc(fmtDate(r.created_at)) }, { label: 'Who', render: r => esc(r.user_name || 'system') }, { label: 'Action', render: r => `<b>${esc(r.action)}</b>` }, { label: 'Record', render: r => r.entity ? `${esc(r.entity)} ${r.entity_id ?? ''}` : '' }, { label: 'Details', render: r => `<code style="font-size:11px;word-break:break-all">${esc(r.details || '')}</code>` }], rows, { empty: 'No matching entries.' });
  }
  let t;
  el.addEventListener('input', e => { if (e.target.id === 'aq') { q = e.target.value; clearTimeout(t); t = setTimeout(load, 300); } });
  el.addEventListener('change', e => { if (e.target.id === 'au') { user = e.target.value; load(); } });
  await load();
}
