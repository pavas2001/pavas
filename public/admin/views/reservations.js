import { api } from '/assets/staff.js';
import { onLive } from '/admin/app.js';
import { esc, $, formModal, tableHtml, tabs, toast, statusChip, today } from '/admin/ui.js';
import { ago } from '/assets/lib.js';

export async function render(el) {
  let tab = 'res', date = today(), status = '', tables = [];
  el.innerHTML = `<div class="tabs" id="rt"></div><div id="rc"></div>`;
  tabs($('#rt'), [['res', 'Reservations'], ['wait', 'Walk-ins & waiting list']], tab, t => { tab = t; load(); });
  tables = (await api('GET', '/tables')).filter(t => t.kind === 'table');
  const tableOpts = () => [['', '— assign later —'], ...tables.map(t => [t.id, `${t.label} (${t.seats})`])];
  const resDefs = [
    { name: 'name', label: 'Guest name', required: true }, { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'email', label: 'Email', type: 'email' },
    { name: 'guests', label: 'Guests', type: 'number', required: true, default: 2 }, { name: 'date', label: 'Date', type: 'date', required: true, default: today() },
    { name: 'time', label: 'Time', type: 'time', required: true, default: '19:00' }, { name: 'table_id', label: 'Table', type: 'select', options: tableOpts() },
    { name: 'status', label: 'Status', type: 'select', options: [['booked', 'Booked'], ['arrived', 'Arrived'], ['seated', 'Seated'], ['cancelled', 'Cancelled'], ['no_show', 'No-show']] },
    { name: 'notes', label: 'Notes', type: 'textarea', span: 1, placeholder: 'Birthday, high chair, allergies…' },
  ];
  const waitDefs = [{ name: 'name', label: 'Name', required: true }, { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'guests', label: 'Guests', type: 'number', required: true, default: 2 }, { name: 'quoted_minutes', label: 'Quoted wait (min)', type: 'number', default: 15 }, { name: 'notes', label: 'Notes', span: 1 }];
  async function load() {
    const c = $('#rc');
    if (tab === 'res') {
      const rows = await api('GET', `/reservations?${new URLSearchParams({ date, status })}`);
      c.innerHTML = `<div class="toolbar"><button class="btn primary" data-new>＋ New reservation</button><input type="date" id="rd" value="${date}"><select id="rs"><option value="">All statuses</option>${['booked', 'arrived', 'seated', 'cancelled', 'no_show'].map(s => `<option ${s === status ? 'selected' : ''}>${s}</option>`).join('')}</select><span class="grow"></span><span class="faint">${rows.reduce((s, r) => s + (['cancelled', 'no_show'].includes(r.status) ? 0 : r.guests), 0)} guests expected</span></div>` +
        tableHtml([{ label: 'Time', render: r => `<b>${esc(r.time)}</b>` }, { label: 'Guest', render: r => `${esc(r.name)}<div class="faint">${esc(r.phone)}</div>` }, { label: 'Guests', key: 'guests', r: 1 }, { label: 'Table', render: r => esc(r.table_label || '—') }, { label: 'Notes', key: 'notes' }, { label: 'Status', render: r => statusChip(r.status) },
          { label: '', render: r => `${r.status === 'booked' ? `<button class="btn sm" data-st="arrived" data-id="${r.id}">Arrived</button> ` : ''}${['booked', 'arrived'].includes(r.status) ? `<button class="btn sm primary" data-st="seated" data-id="${r.id}">Seat</button> <button class="btn sm ghost" data-st="cancelled" data-id="${r.id}">Cancel</button> <button class="btn sm ghost" data-remind="${r.id}">Remind</button>` : ''} <button class="btn sm ghost" data-edit="${r.id}">Edit</button>` }],
          rows, { empty: 'No reservations for this day.' });
      c.querySelector('#rd').onchange = e => { date = e.target.value; load(); };
      c.querySelector('#rs').onchange = e => { status = e.target.value; load(); };
      c.onclick = async e => {
        const q = s => e.target.closest(s);
        try {
          if (q('[data-new]')) formModal({ title: 'New reservation', defs: resDefs, values: { date, status: 'booked' }, submit: async d => { await api('POST', '/reservations', d); toast('Reservation saved — confirmation sent if messaging is connected', 'ok'); load(); } });
          if (q('[data-edit]')) { const r = rows.find(x => x.id === Number(q('[data-edit]').dataset.edit)); formModal({ title: 'Edit reservation', defs: resDefs, values: r, submit: async d => { await api('PUT', `/reservations/${r.id}`, d); load(); } }); }
          if (q('[data-st]')) {
            const r = rows.find(x => x.id === Number(q('[data-st]').dataset.id));
            if (q('[data-st]').dataset.st === 'seated' && !r.table_id) { formModal({ title: `Seat ${r.name}`, defs: [{ name: 'table_id', label: 'Table', type: 'select', options: tableOpts(), required: true }], submit: async d => { await api('PUT', `/reservations/${r.id}`, { status: 'seated', table_id: Number(d.table_id) }); load(); } }); return; }
            await api('PUT', `/reservations/${r.id}`, { status: q('[data-st]').dataset.st }); load();
          }
          if (q('[data-remind]')) { await api('POST', `/reservations/${q('[data-remind]').dataset.remind}/remind`); toast('Reminder queued', 'ok'); }
        } catch (err) { toast(err.message, 'bad'); }
      };
    } else {
      const rows = await api('GET', '/waitlist');
      const waiting = rows.filter(r => r.status === 'waiting');
      c.innerHTML = `<div class="toolbar"><button class="btn primary" data-new>＋ Add walk-in</button><span class="grow"></span><span class="faint">${waiting.length} parties · ${waiting.reduce((s, r) => s + r.guests, 0)} guests waiting</span></div>` +
        tableHtml([{ label: '#', render: (_, i) => i + 1 }, { label: 'Name', render: r => `${esc(r.name)}<div class="faint">${esc(r.phone)}</div>` }, { label: 'Guests', key: 'guests', r: 1 }, { label: 'Waiting', render: r => `${ago(r.created_at)}${r.quoted_minutes ? ` <span class="faint">(quoted ${r.quoted_minutes} min)</span>` : ''}` }, { label: 'Notes', key: 'notes' }, { label: 'Status', render: r => statusChip(r.status) },
          { label: '', render: r => r.status === 'waiting' ? `<button class="btn sm" data-notify="${r.id}">Notify</button> <button class="btn sm primary" data-st="seated" data-id="${r.id}">Seated</button> <button class="btn sm ghost" data-st="left" data-id="${r.id}">Left</button>` : '' }],
          rows.filter(r => r.status === 'waiting' || Date.now() - Date.parse(r.created_at) < 6 * 3600e3), { empty: 'Nobody waiting.' });
      c.onclick = async e => {
        const q = s => e.target.closest(s);
        try {
          if (q('[data-new]')) formModal({ title: 'Add walk-in', defs: waitDefs, submit: async d => { await api('POST', '/waitlist', d); load(); } });
          if (q('[data-st]')) { await api('PUT', `/waitlist/${q('[data-st]').dataset.id}`, { status: q('[data-st]').dataset.st }); load(); }
          if (q('[data-notify]')) { await api('POST', `/waitlist/${q('[data-notify]').dataset.notify}/notify`); toast('Guest notified (if messaging is connected)', 'ok'); }
        } catch (err) { toast(err.message, 'bad'); }
      };
    }
  }
  await load();
  onLive(t => { if (t === 'reservations.changed' || t === 'waitlist.changed') load(); });
}
