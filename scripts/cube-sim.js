'use strict';
// Signal Cube simulator: acts like a real cube so you can test without hardware.
//   npm run cube -- <device key> <face>        face: service | bill | water | order | togo | rest
//   npm run cube -- <device key> cancel        (two quick shakes)
//   npm run cube -- <device key> heartbeat [battery] [on|off]
// Set PIXBERRY_URL if the server isn't on http://localhost:3000.
const [key, action = 'heartbeat', ...rest] = process.argv.slice(2);
const base = (process.env.PIXBERRY_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
if (!key) { console.error('Usage: npm run cube -- <device key> <service|bill|water|order|togo|rest|cancel|heartbeat>'); process.exit(1); }

async function main() {
  let path = '/api/device/heartbeat', body = { battery: 80, on_coaster: true, firmware: 'sim-1.0' };
  if (action === 'cancel') path = '/api/device/cancel';
  else if (action === 'heartbeat') body = { battery: Number(rest[0] ?? 80), on_coaster: rest[1] !== 'off', firmware: 'sim-1.0' };
  else { path = '/api/device/face'; body = { face: action, on_coaster: true }; }
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-key': key }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`✗ ${res.status}: ${out.error || 'request failed'}`); process.exit(1); }
  const r = out.request;
  console.log(`✓ ${out.table || 'cube'}: light ${out.light}${r ? ` · ${r.type}${r.acknowledged ? ' (staff on the way)' : ''}${r.late ? ' · LATE' : ''}` : ''}${out.cancelled != null ? ` · cancelled ${out.cancelled}` : ''}`);
}
main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
