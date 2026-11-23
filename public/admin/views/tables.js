// Floor view (live table status), service requests, table setup & QR codes, sections, merge/split tables.
import { api, can, openAuthed, session } from '/assets/staff.js';
import { onLive } from '/admin/app.js';
import { esc, $, money, modal, formModal, tableHtml, tabs, toast, statusChip, chip, confirmBox } from '/admin/ui.js';
import { ago } from '/assets/lib.js';
import { openOrder } from '/admin/views/orderpanel.js';

const ST = { available: 'Available', ordering: 'Ordering', occupied: 'Occupied', bill_requested: 'Bill requested', cleaning: 'Needs cleaning' };
const COLORS = { available: 'var(--ok)', ordering: 'var(--info)', occupied: 'var(--warn)', bill_requested: 'var(--accent)', cleaning: 'var(--text-3)' };

export async function render(el) {
  let tab = 'floor', tables = [], sections = [], reqs = [], section = '';
  el.innerHTML = `<div class="tabs" id="tt"></div><div id="tc"></div>`;
  const manage = can('tables.manage');
  tabs($('#tt'), [['floor', 'Floor'], ['requests', 'Service requests'], ...(manage ? [['setup', 'Tables & QR codes'], ['sections', 'Sections']] : [])], tab, t => { tab = t; draw(); });

  async function load() {
    [tables, sections, reqs] = await Promise.all([api('GET', '/tables'), api('GET', '/sections'), api('GET', '/service-requests').catch(() => [])]);
    draw();
  }
  function draw() {
    const c = $('#tc');
    if (tab === 'floor') {
      const list = tables.filter(t => t.kind === 'table' && (!section || String(t.section_id) === section));
      const openReq = id => reqs.filter(r => r.table_id === id && r.status === 'open');
      c.innerHTML = `<div class="toolbar"><select id="secf"><option value="">All sections</option>${sections.map(s => `<option value="${s.id}" ${String(s.id) === section ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
        <div class="legend grow">${Object.entries(ST).map(([k, v]) => `<span><i style="background:${COLORS[k]}"></i>${v}</span>`).join('')}</div></div>
        <div class="floor">${list.map(t => `<button class="tbl ${t.status}" data-t="${t.id}">
          <span class="row between"><span class="lb">${esc(t.label)}</span>${openReq(t.id).length ? chip(`🔔 ${openReq(t.id).map(r => r.type).join(', ')}`, 'bad') : ''}</span>
          <span class="faint">${esc(t.section_name || '')} · ${t.seats} seats</span>
          <span><b>${ST[t.status]}</b>${t.merged_into_label ? ` · joined to ${esc(t.merged_into_label)}` : ''}</span>
          ${t.order_id ? `<span class="num">#${t.order_number} · ${money(t.order_total)}${t.order_paid ? ` · paid ${money(t.order_paid)}` : ''}</span><span class="faint">${ago(t.order_created_at)}</span>` : ''}
        </button>`).join('') || '<div class="empty">No tables yet. Add some under “Tables & QR codes”.</div>'}</div>`;
    } else if (tab === 'requests') {
      c.innerHTML = tableHtml([
        { label: 'Table', render: r => `<b>${esc(r.table_label || '')}</b>` }, { label: 'Request', render: r => esc(r.type) + (r.note ? ` — ${esc(r.note)}` : '') },
        { label: 'When', render: r => `${ago(r.created_at)} ago` }, { label: 'Status', render: r => r.status === 'open' ? chip('open', 'bad') : chip('done', 'ok') },
        { label: '', render: r => r.status === 'open' ? `<button class="btn sm primary" data-res="${r.id}">Done</button>` : '' },
      ], reqs, { empty: 'No service requests right now.' });
    } else if (tab === 'setup') {
      c.innerHTML = `<div class="toolbar"><button class="btn primary" data-add>＋ Add tables</button><button class="btn" data-print>🖨 Print all QR codes</button><span class="grow"></span><span class="faint">Each QR opens the menu for that table. Regenerate a QR to make old printouts stop working.</span></div>` +
        tableHtml([
          { label: 'Table', render: t => `<b>${esc(t.label)}</b>` }, { label: 'Type', render: t => t.kind === 'counter' ? chip('Counter · takeaway/pickup', 'info') : 'Dine-in table' },
          { label: 'Section', render: t => esc(t.section_name || '—') }, { label: 'Seats', key: 'seats', r: 1 }, { label: 'Status', render: t => statusChip(t.status) },
          { label: 'Customer link', render: t => `<a href="/order/${esc(t.qr_token)}" target="_blank" rel="noopener">open</a>` },
          { label: '', render: t => `<button class="btn sm" data-qr="${t.id}">QR</button> <button class="btn sm ghost" data-edit="${t.id}">Edit</button> <button class="btn sm ghost" data-del="${t.id}">Remove</button>` },
        ], tables, { empty: 'No tables yet.' });
    } else if (tab === 'sections') {
      c.innerHTML = `<div class="toolbar"><button class="btn primary" data-addsec>＋ Add section</button></div>` + tableHtml([{ label: 'Section', key: 'name' }, { label: 'Tables', render: s => tables.filter(t => t.section_id === s.id).length, r: 1 }, { label: '', render: s => `<button class="btn sm ghost" data-esec="${s.id}">Rename</button> <button class="btn sm ghost" data-dsec="${s.id}">Delete</button>` }], sections, { empty: 'No sections. Sections group tables (e.g. Indoor, Patio, Rooftop).' });
    }
  }
  const secOpts = () => [['', '— none —'], ...sections.map(s => [s.id, s.name])];
  function tableActions(t) {
    const others = tables.filter(x => x.id !== t.id && x.kind === 'table' && !x.merged_into);
    modal({ title: `Table ${t.label}`, body: `
      <p>${statusChip(t.status)} ${t.order_id ? `Order <b>#${t.order_number}</b> · ${money(t.order_total)}` : 'No open order.'}</p>
      <div class="row">
        ${t.order_id ? `<button class="btn primary" data-a="open">Open order</button>` : can('orders.create') ? `<a class="btn primary" href="#/pos" data-a="pos">New order</a>` : ''}
        ${['cleaning', 'ordering'].includes(t.status) || (t.status === 'occupied' && !t.order_id) ? '<button class="btn" data-a="ready">✓ Mark ready / available</button>' : ''}
        ${t.status === 'available' ? '<button class="btn" data-a="occupy">Seat guests</button>' : ''}
        ${t.merged_into ? '<button class="btn" data-a="unmerge">Split from main table</button>' : tables.some(x => x.merged_into === t.id) ? '<button class="btn" data-a="unmerge">Split joined tables</button>' : ''}
      </div>
      ${can('orders.transfer') && !t.merged_into && others.length ? `<h4 style="margin-top:16px">Combine tables</h4><p class="hint">Join other tables to ${esc(t.label)} for a big group. Their QR codes add to this table's bill; open orders are combined.</p>
        <div class="row">${others.map(x => `<label class="check" style="margin-right:10px"><input type="checkbox" value="${x.id}" data-m> ${esc(x.label)}</label>`).join('')}</div><button class="btn sm" style="margin-top:8px" data-a="merge">Combine selected</button>` : ''}`,
      onOpen: m => m.body.addEventListener('click', async e => {
        const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
        try {
          if (a === 'open') { m.close(); openOrder(t.order_id, { onChange: load }); }
          if (a === 'pos') { localStorage.setItem('pb.pos.table', JSON.stringify(String(t.id))); m.close(); }
          if (a === 'ready') { await api('PUT', `/tables/${t.id}`, { status: 'available' }); m.close(); }
          if (a === 'occupy') { await api('PUT', `/tables/${t.id}`, { status: 'occupied' }); m.close(); }
          if (a === 'unmerge') { await api('POST', `/tables/${t.id}/unmerge`); m.close(); }
          if (a === 'merge') { const ids = [...m.body.querySelectorAll('[data-m]:checked')].map(x => Number(x.value)); if (!ids.length) return toast('Select tables'); await api('POST', `/tables/${t.id}/merge`, { table_ids: ids }); m.close(); }
          load();
        } catch (err) { toast(err.message, 'bad'); }
      }) });
  }
  el.addEventListener('change', e => { if (e.target.id === 'secf') { section = e.target.value; draw(); } });
  el.addEventListener('click', async e => {
    const q = s => e.target.closest(s);
    try {
      if (q('[data-t]')) tableActions(tables.find(t => t.id === Number(q('[data-t]').dataset.t)));
      if (q('[data-res]')) { await api('POST', `/service-requests/${q('[data-res]').dataset.res}/resolve`); load(); }
      if (q('[data-add]')) formModal({ title: 'Add tables', defs: [
        { name: 'mode', label: 'Add', type: 'select', options: [['one', 'One table'], ['many', 'Several numbered tables']] }, { name: 'kind', label: 'Type', type: 'select', options: [['table', 'Dine-in table'], ['counter', 'Counter QR (takeaway & pickup)']] },
        { name: 'label', label: 'Label (one table)', placeholder: 'e.g. T9 or Window 2' }, { name: 'prefix', label: 'Prefix (several)', default: 'T' },
        { name: 'start', label: 'Start number', type: 'number', default: tables.length + 1 }, { name: 'count', label: 'How many', type: 'number', default: 4 },
        { name: 'seats', label: 'Seats', type: 'number', default: 4 }, { name: 'section_id', label: 'Section', type: 'select', options: secOpts() }],
        submit: async d => { await api('POST', '/tables', { ...d, count: d.mode === 'many' ? d.count : 1 }); toast('Tables added', 'ok'); load(); } });
      if (q('[data-print]')) openAuthed(`/qr-sheet?branch_id=${session.branch}`);
      if (q('[data-qr]')) {
        const t = tables.find(x => x.id === Number(q('[data-qr]').dataset.qr));
        const res = await fetch(`/api/tables/${t.id}/qr.svg`, { headers: { authorization: `Bearer ${session.token}` } });
        const svg = await res.text();
        modal({ title: `QR · ${t.label}`, body: `<div style="max-width:280px;margin:0 auto;background:#fff;padding:12px;border-radius:12px">${svg}</div><p class="hint" style="text-align:center;word-break:break-all">${esc(location.origin)}/order/${esc(t.qr_token)}</p>`,
          actions: [{ label: 'Regenerate QR', kind: 'danger', onClick: async () => { if (await confirmBox('Regenerate QR?', 'The current printed QR for this table will stop working.')) { await api('POST', `/tables/${t.id}/regenerate-qr`); load(); } } },
            { label: 'Print', kind: 'primary', onClick: () => { openAuthed(`/qr-sheet?ids=${t.id}`); } }] });
      }
      if (q('[data-edit]')) {
        const t = tables.find(x => x.id === Number(q('[data-edit]').dataset.edit));
        formModal({ title: `Edit ${t.label}`, values: t, defs: [{ name: 'label', label: 'Label', required: true }, { name: 'seats', label: 'Seats', type: 'number' }, { name: 'section_id', label: 'Section', type: 'select', options: secOpts() }, { name: 'kind', label: 'Type', type: 'select', options: [['table', 'Dine-in table'], ['counter', 'Counter QR (takeaway & pickup)']] }, { name: 'sort', label: 'Sort order', type: 'number' }],
          submit: async d => { await api('PUT', `/tables/${t.id}`, d); load(); } });
      }
      if (q('[data-del]')) { const t = tables.find(x => x.id === Number(q('[data-del]').dataset.del)); if (await confirmBox(`Remove ${t.label}?`, 'Its QR code will stop working.')) { await api('DELETE', `/tables/${t.id}`); load(); } }
      if (q('[data-addsec]')) formModal({ title: 'Add section', defs: [{ name: 'name', label: 'Name', required: true }, { name: 'sort', label: 'Sort', type: 'number' }], submit: async d => { await api('POST', '/sections', d); load(); } });
      if (q('[data-esec]')) { const s = sections.find(x => x.id === Number(q('[data-esec]').dataset.esec)); formModal({ title: 'Rename section', values: s, defs: [{ name: 'name', label: 'Name', required: true }, { name: 'sort', label: 'Sort', type: 'number' }], submit: async d => { await api('PUT', `/sections/${s.id}`, d); load(); } }); }
      if (q('[data-dsec]')) { if (await confirmBox('Delete section?', 'Tables in it will become unsectioned.')) { await api('DELETE', `/sections/${q('[data-dsec]').dataset.dsec}`); load(); } }
    } catch (err) { toast(err.message, 'bad'); }
  });
  await load();
  let d; onLive(type => { if (type.startsWith('order.') || type === 'table.updated' || type === 'notification') { clearTimeout(d); d = setTimeout(load, 500); } });
}
