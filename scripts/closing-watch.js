'use strict';
// Runs at closing time: backs up the database, then (if asked) shuts the PC down.
//
// Meant to be run every 10–15 minutes by Windows Task Scheduler while Pixberry's service is
// running — not as a long-lived process of its own. Because the PC is off outside opening hours,
// in practice it only ever does anything once a day: the first time it runs after the café has
// just closed. It uses a marker in the database so a second run on the same day does nothing.
//
//   node scripts/closing-watch.js            backup only
//   node scripts/closing-watch.js --shutdown backup, then shut the PC down in 60 s (cancel with
//                                             `shutdown /a` within that time)
//
// Safe to run by hand, or on any platform: the shutdown step only does anything on Windows.
const { execFile } = require('node:child_process');
require('./windows-config'); // must load before server/db or server/util: they read PIXBERRY_DB etc. at require time
const { get, run } = require('../server/db');
const U = require('../server/util');

const MARKER_KEY = 'closing_watch_last_run';

function main() {
  const todaysOpen = U.isOpenNow();
  const today = U.localParts().date;
  const already = get(`SELECT value FROM settings WHERE key = ?`, MARKER_KEY);
  const lastDate = already ? JSON.parse(already.value) : null;

  if (todaysOpen.open) { console.log(`Still open (${todaysOpen.open === true ? 'ok' : todaysOpen.reason}). Nothing to do.`); return; }
  if (lastDate === today) { console.log(`Already handled closing for ${today}.`); return; }

  console.log(`Closed (${todaysOpen.reason || 'outside hours'}). Running the end-of-day backup…`);
  const { backupNow } = require('../server/routes/system');
  try {
    const file = backupNow('closing');
    console.log(`Backup written: ${file}`);
  } catch (e) {
    console.error(`Backup failed: ${e.message}`);
    return; // don't mark the day done, or shut down, if the backup didn't actually run
  }
  run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, MARKER_KEY, JSON.stringify(today));

  if (process.argv.includes('--shutdown')) {
    if (process.platform !== 'win32') { console.log('(--shutdown only does anything on Windows.)'); return; }
    console.log('Shutting this PC down in 60 seconds. To cancel, run: shutdown /a');
    execFile('shutdown', ['/s', '/t', '60', '/c', 'Pixberry: the café is closed for the day.'], e => { if (e) console.error(`Could not schedule shutdown: ${e.message}`); });
  }
}

main();
