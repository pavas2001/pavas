// Customers (with consent), order history & preferences, loyalty points, coupons/offers, feedback & ratings.
import { api, can } from '/assets/staff.js';
import { esc, $, money, rupees, modal, formModal, tableHtml, tabs, toast, chip } from '/admin/ui.js';
import { fmtDate } from '/assets/lib.js';

export async function render(el) {
  let tab = 'customers', q = '';
  el.innerHTML = `<div class="tabs" id="ct"></div><div id="cc"></div>`;
  tabs($('#ct'), [['customers', 'Customers'], ['coupons', 'Coupons & offers'], ['feedback', 'Feedback & ratings']], tab, t => { tab = t; draw(); });
  const custDefs = [{ name: 'name', label: 'Name' }, { name: 'phone', label: 'Phone', required: true, type: 'tel' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'preferences', label: 'Preferences', type: 'textarea', span: 1, placeholder: 'e.g. oat milk, no onion, window seat' }, { name: 'consent', label: 'Customer consents to storing details and receiving messages', type: 'checkbox', span: 1 }];
  const couponDefs = [{ name: 'code', label: 'Code', required: true }, { name: 'description', label: 'Description' }, { name: 'type', label: 'Type', type: 'select', options: [['percent', 'Percent off'], ['flat', 'Flat amount off']] }, { name: 'value', label: 'Value (% or ₹)', type: 'number', step: '0.01', required: true }, { name: 'min_order', label: 'Minimum order (₹)', type: 'money' }, { name: 'max_discount', label: 'Max discount (₹)', type: 'money' }, { name: 'max_uses', label: 'Max uses', type: 'number' }, { name: 'expires_at', label: 'Expires on', type: 'date' }, { name: 'active', label: 'Active', type: 'checkbox', default: true }];
  const couponOut = d => ({ ...d, value: d.type === 'flat' ? Math.round(Number(d.value) * 100) : Math.round(Number(d.value)) });

  async function draw() {
    const c = $('#cc');
    if (tab === 'customers') {
      const rows = await api('GET', `/customers?q=${encodeURIComponent(q)}`);
      const repeat = rows.filter(r => r.visits > 1).length;
      c.innerHTML = `<div class="toolbar"><button class="btn primary" data-new>＋ New customer</button><input id="cq" type="search" class="grow" placeholder="Search name, phone or email" value="${esc(q)}"><span class="faint">${rows.length} customers · ${repeat} repeat</span></div>` +
        tableHtml([{ label: 'Customer', render: r => `<b>${esc(r.name || '—')}</b><div class="faint">${esc(r.phone)} ${esc(r.email)}</div>` }, { label: 'Visits', key: 'visits', r: 1 }, { label: 'Spent', render: r => money(r.spent), r: 1 }, { label: 'Points', key: 'points', r: 1 }, { label: 'Last visit', render: r => esc(fmtDate(r.last_visit)) }, { label: 'Consent', render: r => r.consent ? chip('Yes', 'ok') : chip('No') }, { label: 'Tag', render: r => r.visits >= 5 ? chip('Regular', 'brand') : r.visits > 1 ? chip('Repeat', 'info') : '' }],
          rows, { empty: 'No customers yet. Customers are saved when they share their phone with consent.', rowAttr: r => `class="click" data-c="${r.id}"` });
    } else if (tab === 'coupons') {
      const rows = await api('GET', '/coupons');
      c.innerHTML = `<div class="toolbar"><button class="btn primary" data-newc>＋ New coupon</button></div>` +
        tableHtml([{ label: 'Code', render: r => `<b>${esc(r.code)}</b><div class="faint">${esc(r.description)}</div>` }, { label: 'Offer', render: r => r.type === 'percent' ? `${r.value}% off${r.max_discount ? ` (max ${money(r.max_discount)})` : ''}` : `${money(r.value)} off` }, { label: 'Min order', render: r => r.min_order ? money(r.min_order) : '—', r: 1 }, { label: 'Used', render: r => `${r.used}${r.max_uses ? ` / ${r.max_uses}` : ''}`, r: 1 }, { label: 'Expires', render: r => esc(r.expires_at || '—') }, { label: 'Status', render: r => r.active ? chip('Active', 'ok') : chip('Off') }, { label: '', render: r => `<button class="btn sm ghost" data-ec="${r.id}">Edit</button>` }], rows, { empty: 'No coupons yet.' });
      c.onclick = e => {
        if (e.target.closest('[data-newc]')) formModal({ title: 'New coupon', defs: couponDefs, values: { type: 'percent', active: true }, submit: async d => { await api('POST', '/coupons', couponOut(d)); draw(); } });
        const ec = e.target.closest('[data-ec]');
        if (ec) { const r = rows.find(x => x.id === Number(ec.dataset.ec)); formModal({ title: `Edit ${r.code}`, defs: couponDefs, values: { ...r, value: r.type === 'flat' ? rupees(r.value) : r.value }, submit: async d => { await api('PUT', `/coupons/${r.id}`, couponOut(d)); draw(); } }); }
      };
      return;
    } else {
      const f = await api('GET', '/feedback');
      c.innerHTML = `<div class="kpis"><div class="kpi"><div class="l">Average rating</div><div class="v">${f.summary.avg ?? '—'} ★</div><div class="d">${f.summary.n} reviews</div></div></div>` +
        tableHtml([{ label: 'When', render: r => esc(fmtDate(r.created_at)) }, { label: 'Rating', render: r => `<span style="color:#f2b01e">${'★'.repeat(r.rating)}</span><span class="faint">${'★'.repeat(5 - r.rating)}</span>` }, { label: 'Comment', key: 'comment' }, { label: 'Order', render: r => r.number ? `#${r.number}` : '' }, { label: 'Customer', render: r => esc(r.customer_name || r.phone || 'Guest') }], f.items, { empty: 'No feedback yet. Guests can rate their visit after paying.' });
    }
    c.onclick = null;
  }
  async function openCustomer(id) {
    const [cst, h] = await Promise.all([api('GET', `/customers/${id}`), api('GET', `/customers/${id}/history`)]);
    modal({ title: cst.name || cst.phone, wide: true, body: `
      <div class="kpis"><div class="kpi"><div class="l">Points</div><div class="v">${cst.points}</div></div><div class="kpi"><div class="l">Visits</div><div class="v">${h.orders.filter(o => o.status === 'paid').length}</div></div><div class="kpi"><div class="l">Favourites</div><div class="d" style="font-size:13px">${esc(h.favourites.map(f => `${f.name} ×${f.qty}`).join(', ') || '—')}</div></div></div>
      ${cst.preferences ? `<p class="banner info">Preferences: ${esc(cst.preferences)}</p>` : ''}
      <h3>Orders</h3>${tableHtml([{ label: 'Order', render: o => `#${o.number}` }, { label: 'Date', render: o => esc(fmtDate(o.created_at)) }, { label: 'Type', key: 'type' }, { label: 'Total', render: o => money(o.total), r: 1 }, { label: 'Status', key: 'status' }], h.orders, { empty: 'No orders.' })}
      <h3 style="margin-top:16px">Loyalty</h3>${tableHtml([{ label: 'Date', render: l => esc(fmtDate(l.created_at)) }, { label: 'Points', render: l => `${l.points > 0 ? '+' : ''}${l.points}`, r: 1 }, { label: 'Reason', key: 'reason' }], h.loyalty, { empty: 'No points yet.' })}`,
      actions: [
        { label: 'Adjust points', onClick: () => { formModal({ title: 'Adjust points', defs: [{ name: 'points', label: 'Points (+/−)', type: 'number', required: true }, { name: 'reason', label: 'Reason', required: true }], submit: async d => { await api('POST', `/customers/${id}/points`, d); toast('Points updated', 'ok'); } }); } },
        ...(cst.consent ? [{ label: 'Send message', onClick: () => { formModal({ title: 'Message customer', defs: [{ name: 'body', label: 'Message', type: 'textarea', required: true, span: 1 }], submit: async d => { await api('POST', `/customers/${id}/message`, d); toast('Message queued', 'ok'); } }); } }] : []),
        { label: 'Edit', kind: 'primary', onClick: () => { formModal({ title: 'Edit customer', defs: custDefs, values: cst, submit: async d => { await api('PUT', `/customers/${id}`, d); draw(); } }); } },
      ] });
  }
  let t;
  el.addEventListener('input', e => { if (e.target.id === 'cq') { q = e.target.value; clearTimeout(t); t = setTimeout(async () => { await draw(); const i = $('#cq'); i.focus(); i.setSelectionRange(q.length, q.length); }, 300); } });
  el.addEventListener('click', e => {
    if (e.target.closest('[data-new]')) formModal({ title: 'New customer', defs: custDefs, submit: async d => { await api('POST', '/customers', d); draw(); } });
    const r = e.target.closest('[data-c]'); if (r) openCustomer(Number(r.dataset.c)).catch(err => toast(err.message, 'bad'));
  });
  void can;
  await draw();
}
