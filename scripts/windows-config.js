'use strict';
// Loads settings the Windows installer saved into %ProgramData%\Pixberry\config.json (so the admin
// password and data paths don't have to live in machine-wide environment variables) and copies them
// into process.env, without overwriting anything already set there.
//
// Required at the very top of an entry script, before requiring server/db or server/util — those
// read PIXBERRY_DB / PIXBERRY_BACKUP_DIR from process.env as soon as they are loaded.
//
// A no-op everywhere else: off Windows, or when the file is missing, nothing changes. Set
// PIXBERRY_CONFIG to point at a different file (handy for testing this on any platform).
const fs = require('node:fs');
const path = require('node:path');

const file = process.env.PIXBERRY_CONFIG || (process.platform === 'win32' ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'Pixberry', 'config.json') : null);
if (file) {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(cfg)) {
      if (process.env[k] === undefined && v != null && v !== '') process.env[k] = String(v);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[pixberry] could not read ${file}: ${e.message}`);
  }
}

module.exports = {}; // loaded for its side effect
