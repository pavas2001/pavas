'use strict';
// Startup file for hosting panels (cPanel "Setup Node.js App", Hostinger, Plesk, Passenger).
// Set "Application startup file" to app.js. Needs Node.js 22.13 or newer.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Pixberry ERP needs Node.js 22.13 or newer (this server has ${process.versions.node}). Choose a newer Node.js version in your hosting panel.`);
  process.exit(1);
}
process.removeAllListeners('warning');
require('./server/index.js').start();
