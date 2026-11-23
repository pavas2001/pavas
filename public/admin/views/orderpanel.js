// Order detail: items, edit/cancel, discount/coupon/points, bill, payments (partial / split), transfer, combine, refund, receipt.
import { api, can } from '/assets/staff.js';
import { getSettings } from '/admin/app.js';
import { modal, confirmBox, esc, money, rupees, paise, toast, statusChip, chip } from '/admin/ui.js';
import { fmtDate } from '/assets/lib.js';

export async function openOrder(id, { onChange } = {}) {
  const settings = await getSettings();
  let o = await api('GET', `/orders/${id}`);
  const m = modal({ title: `Order #${o.number}`, wide: true, body: '' });
  const changed = async (next) => { o = next || await api('GET', `/orders/${id}`); draw(); onChange?.(o); };
  const active = () => ['open', 'billed'].includes(o.status);

  function draw() {
    m.el.querySelector('header h2').textContent = `Order #${o.number}${o.invoice_no ? ` · ${o.invoice_no}` : ''}`;
    const live = o.items.filter(i => i.kds_status !== 'cancelled');
    m.body.innerHTML = `
      <div class="row between" style="margin-bottom:12px">
        <div class="row">${statusChip(o.status)} ${chip(o.type.replace('_', '-'))} ${o.table_label ? chip(o.table_label, 'brand') : ''} ${o.source === 'qr' ? chip('QR order', 'info') : ''} ${o.pickup_code ? chip(`Pickup ${o.pickup_code}`, 'warn') : ''}</div>
        <small class="muted">${esc(fmtDate(o.created_at))}${o.created_by_name ? ` · by ${esc(o.created_by_name)}` : ''}${o.geo_distance_m != null ? ` · ordered ${Math.round(o.geo_distance_m)} m from café` : ''}</small>
      </div>
      ${o.customer_name || o.customer_phone ? `<p class="muted">Customer: <b>${esc(o.customer_name || '')}</b> ${esc(o.customer_phone || '')}</p>` : ''}
      ${o.notes ? `<p class="banner info">📝 ${esc(o.notes)}</p>` : ''}
      <div class="grid g2" style="align-items:start">
        <div>
          <div class="table-wrap"><table class="data"><thead><tr><th>Item</th><th>Kitchen</th><th class="r">Qty</th><th class="r">Amount</th><th></th></tr></thead><tbody>
          ${o.items.map(i => `<tr style="${i.kds_status === 'cancelled' ? 'opacity:.5;text-decoration:line-through' : ''}"><td><b>${esc(i.name)}</b>${i.variant_name ? ` · ${esc(i.variant_name)}` : ''}${i.modifiers.length ? `<div class="faint">+ ${esc(i.modifiers.map(x => x.name).join(', '))}</div>` : ''}${i.notes ? `<div class="faint">“${esc(i.notes)}”</div>` : ''}<div class="faint">KOT ${i.kot} · ${esc(i.added_by.startsWith('qr') ? 'QR' : 'staff')}</div></td>
            <td>${statusChip(i.kds_status)}</td><td class="r">${i.qty}</td><td class="r num">${money(i.unit_price * i.qty)}</td>
            <td class="r">${active() && i.kds_status !== 'cancelled' ? `${can('orders.edit') ? `<button class="btn sm ghost" data-edit="${i.id}" title="Edit">✎</button>` : ''}${can('orders.cancel') ? `<button class="btn sm ghost" data-cancel="${i.id}" title="Cancel item">✕</button>` : ''}` : ''}</td></tr>`).join('')}
          </tbody></table></div>
          ${active() && can('orders.create') ? `<p style="margin-top:8px"><a class="btn sm" href="#/pos/${o.id}" data-close>＋ Add items</a></p>` : ''}
        </div>
        <div class="card" style="box-shadow:none">
          <div class="sumrow"><span>Subtotal</span><span class="num">${money(o.subtotal)}</span></div>
          ${o.discount ? `<div class="sumrow"><span>Discount${o.coupon_code ? ` (${esc(o.coupon_code)})` : o.discount_type === 'percent' ? ` (${o.discount_value}%)` : ''}</span><span class="num">−${money(o.discount)}</span></div>` : ''}
          ${o.service_charge ? `<div class="sumrow"><span>Service charge</span><span class="num">${money(o.service_charge)}</span></div>` : ''}
          ${o.tax_breakdown.map(t => `<div class="sumrow"><span>${esc(t.label)}${o.tax_mode === 'inclusive' ? ' (incl.)' : ''}</span><span class="num">${money(t.amount)}</span></div>`).join('')}
          ${o.round_off ? `<div class="sumrow"><span>Round off</span><span class="num">${money(o.round_off)}</span></div>` : ''}
          <div class="sumrow big"><span>Total</span><span class="num">${money(o.total)}</span></div>
          ${o.payments.map(p => `<div class="sumrow faint"><span>${p.kind === 'refund' ? 'Refund' : 'Paid'} · ${esc(p.method.toUpperCase())}${p.note ? ` · ${esc(p.note)}` : ''}</span><span class="num">${p.kind === 'refund' ? '−' : ''}${money(p.amount)}</span></div>`).join('')}
          ${active() ? `<div class="sumrow big" style="color:var(--brand)"><span>Balance due</span><span class="num">${money(o.balance)}</span></div>` : ''}
          ${active() && can('payments.take') && live.length ? payBox() : ''}
        </div>
      </div>
      <hr>
      <div class="row">
        <a class="btn sm" href="/r/${encodeURIComponent(o.public_key)}?print=1" target="_blank" rel="noopener">🖨 Print bill</a>
        <button class="btn sm" data-act="share">📤 Send bill</button>
        ${active() && can('orders.discount') ? '<button class="btn sm" data-act="discount">％ Discount / coupon</button>' : ''}
        ${active() && can('orders.discount') && o.customer_id ? '<button class="btn sm" data-act="redeem">💜 Redeem points</button>' : ''}
        ${active() && o.status === 'open' ? '<button class="btn sm" data-act="bill">Mark billed</button>' : ''}
        ${active() && can('orders.transfer') && o.type === 'dine_in' ? '<button class="btn sm" data-act="transfer">⇄ Move table</button>' : ''}
        ${active() && can('orders.transfer') ? '<button class="btn sm" data-act="combine">⊕ Combine</button><button class="btn sm" data-act="split">✂ Split by item</button>' : ''}
        ${active() && can('orders.edit') ? '<button class="btn sm" data-act="customer">👤 Customer</button>' : ''}
        <span class="grow"></span>
        ${o.status === 'paid' && can('orders.refund') && o.paid - o.refunded > 0 ? '<button class="btn sm danger" data-act="refund">Refund</button>' : ''}
        ${active() && can('orders.cancel') ? '<button class="btn sm danger" data-act="cancel">Cancel order</button>' : ''}
      </div>`;
  }
  function payBox() {
    const methods = settings.payment_methods || ['cash', 'upi', 'card'];
    return `<div style="margin-top:12px"><label>Take payment</label>
      <div class="row"><input id="payAmt" type="number" step="0.01" min="0" value="${rupees(o.balance)}" style="width:120px"><input id="payRef" placeholder="Ref / UPI txn (optional)" class="grow" style="width:auto"></div>
      <div class="row" style="margin-top:8px">${methods.map(mt => `<button class="btn ${mt === 'cash' ? 'primary' : ''}" data-pay="${esc(mt)}">${esc(mt.toUpperCase())}</button>`).join('')}</div>
      <div class="row" style="margin-top:8px"><span class="faint">Split equally:</span>${[2, 3, 4].map(n => `<button class="btn sm ghost" data-ways="${n}">÷${n}</button>`).join('')}</div></div>`;
  }

  m.body.addEventListener('click', async e => {
    const t = e.target;
    try {
      if (t.closest('[data-close]')) { m.close(); return; }
      const pay = t.closest('[data-pay]');
      if (pay) {
        const amt = paise(m.body.querySelector('#payAmt').value);
        if (!amt) return toast('Enter an amount', 'bad');
        const r = await api('POST', `/orders/${o.id}/payments`, { method: pay.dataset.pay, amount: amt, reference: m.body.querySelector('#payRef').value });
        toast(r.change ? `Paid. Change to return: ${money(r.change)}` : r.order.status === 'paid' ? `Paid in full · ${r.order.invoice_no}` : `Part payment recorded. Balance ${money(r.order.balance)}`, 'ok');
        return changed(r.order);
      }
      const ways = t.closest('[data-ways]');
      if (ways) { const s = await api('GET', `/orders/${o.id}/split?ways=${ways.dataset.ways}`); m.body.querySelector('#payAmt').value = rupees(s.shares[0]); toast(`Each share: ${s.shares.map(x => money(x)).join(' / ')}. Take one payment per guest.`); return; }
      const ed = t.closest('[data-edit]');
      if (ed) {
        const it = o.items.find(i => i.id === Number(ed.dataset.edit));
        modal({ title: `Edit ${it.name}`, body: `<div class="grid g2"><div class="field"><label>Quantity</label><input id="eq" type="number" min="1" max="99" value="${it.qty}"></div><div class="field"><label>Notes</label><input id="en" value="${esc(it.notes)}"></div></div>`,
          actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async ({ el }) => changed(await api('PUT', `/orders/${o.id}/items/${it.id}`, { qty: Number(el.querySelector('#eq').value), notes: el.querySelector('#en').value })) }] });
        return;
      }
      const cn = t.closest('[data-cancel]');
      if (cn) { const reason = await confirmBox('Cancel item', 'This removes the item from the bill and tells the kitchen.', { input: 'Reason', label: 'Cancel item' }); if (reason) changed(await api('POST', `/orders/${o.id}/items/${cn.dataset.cancel}/cancel`, { reason })); return; }
      const act = t.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'bill') changed(await api('POST', `/orders/${o.id}/bill`));
      if (act === 'cancel') { const reason = await confirmBox(`Cancel order #${o.number}`, 'The whole order will be cancelled and stock returned.', { input: 'Reason', label: 'Cancel order' }); if (reason) changed(await api('POST', `/orders/${o.id}/cancel`, { reason })); }
      if (act === 'refund') {
        modal({ title: 'Refund', body: `<div class="grid g2"><div class="field"><label>Amount</label><input id="ra" type="number" step="0.01" value="${rupees(o.paid - o.refunded)}"></div><div class="field"><label>Method</label><select id="rm">${(settings.payment_methods || []).map(x => `<option>${esc(x)}</option>`).join('')}</select></div><div class="field" style="grid-column:1/-1"><label>Reason *</label><input id="rr"></div></div>`,
          actions: [{ label: 'Close' }, { label: 'Refund', kind: 'danger', onClick: async ({ el }) => changed(await api('POST', `/orders/${o.id}/refund`, { amount: paise(el.querySelector('#ra').value), method: el.querySelector('#rm').value, reason: el.querySelector('#rr').value })) }] });
      }
      if (act === 'discount') {
        const coupons = await api('GET', '/coupons').catch(() => []);
        modal({ title: 'Discount or coupon', body: `
          <div class="grid g2"><div class="field"><label>Discount type</label><select id="dt"><option value="">None</option><option value="percent" ${o.discount_type === 'percent' ? 'selected' : ''}>Percent %</option><option value="flat" ${o.discount_type === 'flat' ? 'selected' : ''}>Flat amount</option></select></div>
          <div class="field"><label>Value</label><input id="dv" type="number" step="0.01" min="0" value="${o.discount_type === 'flat' ? rupees(o.discount_value) : o.discount_value || ''}"></div></div>
          <div class="field"><label>…or coupon code</label><input id="dc" list="cpl" value="${esc(o.coupon_code || '')}" placeholder="e.g. WELCOME10"><datalist id="cpl">${coupons.filter(c => c.active).map(c => `<option value="${esc(c.code)}">${esc(c.description)}</option>`).join('')}</datalist></div>`,
          actions: [{ label: 'Remove discount', onClick: async () => changed(await api('POST', `/orders/${o.id}/discount`, {})) }, { label: 'Apply', kind: 'primary', onClick: async ({ el }) => {
            const code = el.querySelector('#dc').value.trim(), type = el.querySelector('#dt').value, v = el.querySelector('#dv').value;
            changed(await api('POST', `/orders/${o.id}/discount`, code ? { coupon_code: code } : { type, value: type === 'flat' ? paise(v) : Number(v) }));
          } }] });
      }
      if (act === 'redeem') {
        const c = await api('GET', `/customers/${o.customer_id}`);
        const pv = settings.loyalty?.point_value || 100;
        modal({ title: 'Redeem loyalty points', body: `<p>${esc(c.name || c.phone)} has <b>${c.points}</b> points (1 point = ${money(pv)}).</p><div class="field"><label>Points to redeem</label><input id="rp" type="number" min="1" max="${c.points}" value="${Math.min(c.points, Math.floor(o.balance / pv))}"></div>`,
          actions: [{ label: 'Cancel' }, { label: 'Redeem', kind: 'primary', onClick: async ({ el }) => { await api('POST', `/customers/${c.id}/points`, { points: -Number(el.querySelector('#rp').value), order_id: o.id, reason: `Redeemed on #${o.number}` }); await changed(); } }] });
      }
      if (act === 'transfer') {
        const tables = (await api('GET', '/tables')).filter(x => x.kind === 'table' && x.id !== o.table_id);
        modal({ title: 'Move to table', body: `<div class="field"><label>Table</label><select id="tt">${tables.map(x => `<option value="${x.id}" ${x.order_id ? 'disabled' : ''}>${esc(x.label)}${x.order_id ? ' (busy)' : ''}</option>`).join('')}</select></div>`,
          actions: [{ label: 'Cancel' }, { label: 'Move', kind: 'primary', onClick: async ({ el }) => changed(await api('POST', `/orders/${o.id}/transfer`, { table_id: Number(el.querySelector('#tt').value) })) }] });
      }
      if (act === 'combine') {
        const list = (await api('GET', '/orders?status=active')).filter(x => x.id !== o.id);
        if (!list.length) return toast('No other open orders to combine');
        modal({ title: `Combine into #${o.number}`, body: `<p class="muted">All items and payments of the selected order move into this one.</p><div class="field"><label>Order</label><select id="co">${list.map(x => `<option value="${x.id}">#${x.number} · ${esc(x.table_label || x.type)} · ${money(x.total)}</option>`).join('')}</select></div>`,
          actions: [{ label: 'Cancel' }, { label: 'Combine', kind: 'primary', onClick: async ({ el }) => changed(await api('POST', `/orders/${o.id}/combine`, { order_id: Number(el.querySelector('#co').value) })) }] });
      }
      if (act === 'split') {
        const live = o.items.filter(i => i.kds_status !== 'cancelled');
        modal({ title: 'Split by item', body: `<p class="muted">Selected items move to a new bill on the same table.</p>${live.map(i => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--border)"><label class="check grow"><input type="checkbox" data-sid="${i.id}"> ${esc(i.name)} ${esc(i.variant_name)}</label><input type="number" min="1" max="${i.qty}" value="${i.qty}" data-sq="${i.id}" style="width:70px"> / ${i.qty}</div>`).join('')}`,
          actions: [{ label: 'Cancel' }, { label: 'Split', kind: 'primary', onClick: async ({ el }) => {
            const lines = [...el.querySelectorAll('[data-sid]:checked')].map(c => ({ id: Number(c.dataset.sid), qty: Number(el.querySelector(`[data-sq="${c.dataset.sid}"]`).value) }));
            const r = await api('POST', `/orders/${o.id}/split-items`, { lines });
            toast(`New bill #${r.to.number} created`, 'ok'); changed(r.from);
          } }] });
      }
      if (act === 'customer') {
        modal({ title: 'Customer', body: `<div class="grid g2"><div class="field"><label>Name</label><input id="cuN" value="${esc(o.customer_name || '')}"></div><div class="field"><label>Phone</label><input id="cuP" value="${esc(o.customer_phone || '')}"></div></div><label class="check"><input type="checkbox" id="cuC"> Customer consents to saving details &amp; messages</label>`,
          actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async ({ el }) => changed(await api('PUT', `/orders/${o.id}`, { customer_name: el.querySelector('#cuN').value, customer_phone: el.querySelector('#cuP').value, consent: el.querySelector('#cuC').checked })) }] });
      }
      if (act === 'share') {
        modal({ title: 'Send bill', body: `<div class="grid g2"><div class="field"><label>Channel</label><select id="sc"><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option><option value="email">Email</option></select></div><div class="field"><label>To</label><input id="st" value="${esc(o.customer_phone || '')}" placeholder="Phone or email"></div></div>
          <p class="hint">Messages are sent through the channel configured in Settings › Messaging. Receipt link: <code>/r/${esc(o.public_key)}</code></p>`,
          actions: [{ label: 'Copy link', onClick: async () => { await navigator.clipboard?.writeText(`${location.origin}/r/${o.public_key}`); toast('Link copied'); } }, { label: 'Send', kind: 'primary', onClick: async ({ el }) => { const r = await api('POST', `/orders/${o.id}/send-receipt`, { channel: el.querySelector('#sc').value, to: el.querySelector('#st').value }); toast(r.status === 'skipped' ? 'Saved — that channel is not connected yet (see Settings › Messaging)' : 'Bill queued for sending', r.status === 'skipped' ? '' : 'ok'); } }] });
      }
    } catch (err) { toast(err.message, 'bad'); }
  });
  draw();
  return m;
}
