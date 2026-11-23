'use strict';
// Restore a backup: stop the server, then `npm run restore -- backups/pixberry-auto-....db`
const fs = require('node:fs');
const path = require('node:path');
const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('Usage: npm run restore -- <backup-file.db>'); process.exit(1); }
const DATA_DIR = process.env.PIXBERRY_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = process.env.PIXBERRY_DB || path.join(DATA_DIR, 'pixberry.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
if (fs.existsSync(DB_FILE)) {
  const keep = `${DB_FILE}.before-restore-${Date.now()}`;
  fs.copyFileSync(DB_FILE, keep);
  console.log(`Current database saved as ${keep}`);
}
for (const ext of ['-wal', '-shm']) if (fs.existsSync(DB_FILE + ext)) fs.unlinkSync(DB_FILE + ext);
fs.copyFileSync(file, DB_FILE);
console.log(`Restored ${file} -> ${DB_FILE}. Start the server again.`);
