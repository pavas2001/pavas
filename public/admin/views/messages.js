// Notifications (kitchen, managers, staff) and outgoing customer messages (WhatsApp / SMS / email).
import { api, can } from '/assets/staff.js';
import { onLive } from '/admin/app.js';
import { esc, $, tableHtml, tabs, statusChip, chip, formModal, toast } from '/admin/ui.js';
import { fmtDate } from '/assets/lib.js';

export async function render(el) {
  let tab = 'notifs';
  const showOutbox = can('settings.manage') || can('customers.manage');
  el.innerHTML = `<div class="tabs" id="nt"></div><div id="nc"></div>`;
  tabs($('#nt'), [['notifs', 'Notifications'], ...(showOutbox ? [['outbox', 'Outgoing messages']] : [])], tab, t => { tab = t; draw(); });
  const TYPES = { new_order: ['New order', 'info'], order_ready: ['Ready', 'ok'], delayed_order: ['Delayed', 'bad'], low_stock: ['Low stock', 'warn'], refund: ['Refund', 'warn'], request_bill: ['Bill request', 'bad'], request_waiter: ['Waiter call', 'info'], request_water: ['Water', 'info'], request_other: ['Request', 'info'] };
  async function draw() {
    const c = $('#nc');
    if (tab === 'notifs') {
      const rows = await api('GET', '/notifications');
      c.innerHTML = `<div class="toolbar"><button class="btn" data-readall>Mark all read</button></div>` + tableHtml([{ label: 'When', render: n => esc(fmtDate(n.created_at)) }, { label: 'Type', render: n => chip(...(TYPES[n.type] || [n.type])) }, { label: 'For', key: 'audience' }, { label: 'Message', render: n => n.is_read ? esc(n.message) : `<b>${esc(n.message)}</b>` }], rows, { empty: 'No notifications yet.' });
    } else {
      const rows = await api('GET', '/outbox');
      c.innerHTML = `<div class="toolbar"><button class="btn primary" data-send>＋ Send a message</button><span class="faint">“skipped” = that channel isn't connected yet. Connect WhatsApp, SMS or email in Settings › Messaging.</span></div>` +
        tableHtml([{ label: 'When', render: m => esc(fmtDate(m.created_at)) }, { label: 'Channel', render: m => chip(m.channel) }, { label: 'To', key: 'recipient' }, { label: 'Message', render: m => esc(m.body) }, { label: 'Status', render: m => `${statusChip(m.status)}${m.error ? `<div class="faint">${esc(m.error)}</div>` : ''}` }], rows, { empty: 'No messages sent yet.' });
    }
  }
  el.addEventListener('click', async e => {
    if (e.target.closest('[data-readall]')) { await api('POST', '/notifications/read-all'); draw(); }
    if (e.target.closest('[data-send]')) formModal({ title: 'Send a message', defs: [{ name: 'channel', label: 'Channel', type: 'select', options: [['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['email', 'Email']] }, { name: 'to', label: 'To (phone or email)', required: true }, { name: 'subject', label: 'Subject (email)' }, { name: 'body', label: 'Message', type: 'textarea', required: true, span: 1 }], submit: async d => { await api('POST', '/outbox/send', d); toast('Queued', 'ok'); draw(); } });
  });
  await draw();
  onLive(t => { if (t === 'notification' && tab === 'notifs') draw(); });
}
