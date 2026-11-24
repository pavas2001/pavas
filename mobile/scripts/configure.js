'use strict';
// Writes capacitor.config.json for your café. The app opens your Pixberry server's staff app.
//   PIXBERRY_URL=https://pos.mycafe.in npm run sync
// Optional: APP_ID (default in.pixberry.signal), APP_NAME (default "Pixberry Signal").
const fs = require('node:fs');
const path = require('node:path');

const raw = process.env.PIXBERRY_URL || '';
let url;
try { url = new URL(raw); } catch { url = null; }
if (!url || url.protocol !== 'https:') {
  console.error('Set PIXBERRY_URL to your Pixberry address, starting with https:// (for example https://pos.mycafe.in).');
  process.exit(1);
}
const base = url.origin;
const config = {
  appId: process.env.APP_ID || 'in.pixberry.signal',
  appName: process.env.APP_NAME || 'Pixberry Signal',
  webDir: 'www',
  server: {
    url: `${base}/signal/app`,   // the app shows your server's staff app (or the counter display, if chosen)
    errorPath: 'offline.html',   // shown when the server can't be reached
    cleartext: false,
  },
  android: { allowMixedContent: false },
  plugins: { PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] } },
};
fs.writeFileSync(path.join(__dirname, '..', 'capacitor.config.json'), `${JSON.stringify(config, null, 2)}\n`);
console.log(`capacitor.config.json → ${config.server.url}`);
