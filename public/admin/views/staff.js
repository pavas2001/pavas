// Staff accounts & roles, attendance (clock in/out), shift roster, per-staff activity.
import { api, session } from '/assets/staff.js';
import { esc, $, money, modal, formModal, tableHtml, tabs, toast, chip, today } from '/admin/ui.js';
import { fmtDate } from '/assets/lib.js';

export async function render(el) {
  let tab = 'staff', staff = [], date = today();
  el.innerHTML = `<div class="tabs" id="st"></div><div id="sc"></div>`;
  tabs($('#st'), [['staff', 'Staff accounts'], ['attendance', 'Attendance'], ['shifts', 'Shift roster']], tab, t => { tab = t; draw(); });
  const roles = [['admin', 'Admin'], ['manager', 'Manager'], ['cashier', 'Cashier'], ['kitchen', 'Kitchen']];
  const branchOpts = [['', 'All branches'], ...session.me.branches.map(b => [b.id, b.name])];
  const hrs = h => `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m`;
  async function draw() {
    const c = $('#sc');
    staff = await api('GET', '/staff');
    if (tab === 'staff') {
      c.innerHTML = `<div class="toolbar"><button class="btn primary" data-new>＋ Add staff</button><span class="faint">Change what each role can do in Settings › Roles & permissions.</span></div>` +
        tableHtml([{ label: 'Name', render: u => `<b>${esc(u.name)}</b><div class="faint">@${esc(u.username)} ${esc(u.phone)}</div>` }, { label: 'Role', render: u => chip(u.role, u.role === 'admin' ? 'brand' : 'info') }, { label: 'Branch', render: u => esc(u.branch_name || 'All') }, { label: 'On shift', render: u => u.clocked_in_at ? chip(`since ${new Date(u.clocked_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, 'ok') : '' }, { label: 'Status', render: u => u.active ? chip('Active', 'ok') : chip('Disabled', 'bad') }, { label: '', render: u => `<button class="btn sm ghost" data-act="${u.id}">Activity</button> <button class="btn sm ghost" data-edit="${u.id}">Edit</button>` }], staff);
    } else if (tab === 'attendance') {
      const rows = await api('GET', '/attendance');
      const totals = {};
      rows.forEach(r => { totals[r.user_name] = (totals[r.user_name] || 0) + (r.hours || 0); });
      c.innerHTML = `<div class="card" style="margin-bottom:12px"><h3>Hours (last 14 days)</h3>${Object.entries(totals).map(([n, h]) => `${chip(`${n}: ${hrs(h)}`, 'brand')}`).join(' ') || '<span class="faint">No attendance yet.</span>'}</div>` +
        tableHtml([{ label: 'Staff', key: 'user_name' }, { label: 'Clock in', render: r => esc(fmtDate(r.clock_in)) }, { label: 'Clock out', render: r => r.clock_out ? esc(fmtDate(r.clock_out)) : chip('On shift', 'ok') }, { label: 'Hours', render: r => hrs(r.hours || 0), r: 1 }, { label: 'Notes', key: 'notes' }, { label: '', render: r => `<button class="btn sm ghost" data-eatt="${r.id}">Edit</button>` }], rows, { empty: 'No attendance records. Staff clock in with the ⏱ button at the top.' });
      c.onclick = e => {
        const b = e.target.closest('[data-eatt]'); if (!b) return;
        const r = rows.find(x => x.id === Number(b.dataset.eatt));
        const local = iso => iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
        formModal({ title: `Edit attendance · ${r.user_name}`, defs: [{ name: 'clock_in', label: 'Clock in', type: 'datetime-local' }, { name: 'clock_out', label: 'Clock out', type: 'datetime-local' }, { name: 'notes', label: 'Notes', span: 1 }], values: { clock_in: local(r.clock_in), clock_out: local(r.clock_out), notes: r.notes },
          submit: async d => { await api('PUT', `/attendance/${r.id}`, d); draw(); } });
      };
      return;
    } else {
      const rows = await api('GET', `/shifts?date=${date}`);
      c.innerHTML = `<div class="toolbar"><button class="btn primary" data-newshift>＋ Add shift</button><input type="date" id="sd" value="${date}"></div>` +
        tableHtml([{ label: 'Staff', key: 'user_name' }, { label: 'Date', key: 'date' }, { label: 'From', key: 'start_time' }, { label: 'To', key: 'end_time' }, { label: 'Notes', key: 'notes' }, { label: '', render: s => `<button class="btn sm ghost" data-dshift="${s.id}">Remove</button>` }], rows, { empty: 'No shifts planned for this day.' });
      c.querySelector('#sd').onchange = e => { date = e.target.value; draw(); };
      c.onclick = async e => {
        if (e.target.closest('[data-newshift]')) formModal({ title: 'Add shift', defs: [{ name: 'user_id', label: 'Staff', type: 'select', options: staff.filter(u => u.active).map(u => [u.id, u.name]), required: true }, { name: 'date', label: 'Date', type: 'date', required: true, default: date }, { name: 'start_time', label: 'From', type: 'time', required: true, default: '09:00' }, { name: 'end_time', label: 'To', type: 'time', required: true, default: '17:00' }, { name: 'notes', label: 'Notes', span: 1 }], submit: async d => { await api('POST', '/shifts', d); draw(); } });
        const ds = e.target.closest('[data-dshift]'); if (ds) { await api('DELETE', `/shifts/${ds.dataset.dshift}`); draw(); }
      };
      return;
    }
    c.onclick = null;
  }
  const defs = edit => [{ name: 'name', label: 'Full name', required: true }, { name: 'username', label: 'Username', required: !edit }, { name: 'role', label: 'Role', type: 'select', options: roles }, { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'branch_id', label: 'Branch', type: 'select', options: branchOpts }, { name: 'password', label: edit ? 'New password (leave blank to keep)' : 'Password (8+ characters)', type: 'password', required: !edit }, ...(edit ? [{ name: 'active', label: 'Account active', type: 'checkbox' }] : [])];
  el.addEventListener('click', async e => {
    const q = s => e.target.closest(s);
    try {
      if (q('[data-new]')) formModal({ title: 'Add staff member', defs: defs(false), values: { role: 'cashier' }, submit: async d => { await api('POST', '/staff', d); toast('Staff added', 'ok'); draw(); } });
      if (q('[data-edit]')) { const u = staff.find(x => x.id === Number(q('[data-edit]').dataset.edit)); formModal({ title: `Edit ${u.name}`, defs: defs(true).filter(d => d.name !== 'username'), values: u, submit: async d => { if (!d.password) delete d.password; await api('PUT', `/staff/${u.id}`, d); toast('Saved', 'ok'); draw(); } }); }
      if (q('[data-act]')) {
        const u = staff.find(x => x.id === Number(q('[data-act]').dataset.act));
        const a = await api('GET', `/staff/${u.id}/activity`);
        modal({ title: `${u.name} · activity`, wide: true, body: `<div class="kpis"><div class="kpi"><div class="l">Paid orders created</div><div class="v">${a.orders.n}</div><div class="d">${money(a.orders.total)}</div></div>${a.payments.map(p => `<div class="kpi"><div class="l">${esc(p.kind)} · ${esc(p.method)}</div><div class="v">${p.n}</div><div class="d">${money(p.amount)}</div></div>`).join('')}</div>
          ${tableHtml([{ label: 'When', render: x => esc(fmtDate(x.created_at)) }, { label: 'Action', key: 'action' }, { label: 'Ref', render: x => x.entity ? `${esc(x.entity)} ${x.entity_id ?? ''}` : '' }, { label: 'Details', render: x => `<code style="font-size:11px">${esc(x.details || '')}</code>` }], a.audit, { empty: 'No actions recorded.' })}`, actions: [{ label: 'Close' }] });
      }
    } catch (err) { toast(err.message, 'bad'); }
  });
  await draw();
}
