'use strict';
// windows-config.js (the JSON config file the Windows installer writes, read instead of relying on
// machine environment variables) and closing-watch.js (the end-of-day backup/shutdown task).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixberry-windows-'));
const node = process.execPath;
const scriptsDir = path.join(__dirname, '..', 'scripts');

function run(script, env, args = []) {
  return execFileSync(node, ['--disable-warning=ExperimentalWarning', path.join(scriptsDir, script), ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
}

test('windows-config.js is a no-op without PIXBERRY_CONFIG', () => {
  const out = run('windows-config.js', {}); // requiring it alone does nothing visible; wrap it in a one-liner that reports the env
  assert.equal(out, ''); // the module itself prints nothing when there's no file to load
});

test('windows-config.js loads settings from its JSON file, without overriding ones already set', () => {
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ ADMIN_PASSWORD: 'from-file', PORT: '4100', ALREADY_SET: 'from-file-too' }));
  const code = `require(${JSON.stringify(path.join(scriptsDir, 'windows-config.js'))}); console.log(JSON.stringify({ a: process.env.ADMIN_PASSWORD, p: process.env.PORT, k: process.env.ALREADY_SET }));`;
  const out = execFileSync(node, ['-e', code], { env: { PATH: process.env.PATH, PIXBERRY_CONFIG: cfgPath, ALREADY_SET: 'from-env' }, encoding: 'utf8' });
  const result = JSON.parse(out);
  assert.equal(result.a, 'from-file');
  assert.equal(result.p, '4100');
  assert.equal(result.k, 'from-env', 'an existing environment variable is never overwritten by the config file');
});

test('windows-config.js is silent and harmless when the file is missing', () => {
  const code = `require(${JSON.stringify(path.join(scriptsDir, 'windows-config.js'))}); console.log('ok');`;
  const out = execFileSync(node, ['-e', code], { env: { PATH: process.env.PATH, PIXBERRY_CONFIG: path.join(dir, 'nope.json') }, encoding: 'utf8' });
  assert.match(out, /^ok/);
});

test('closing-watch.js: backs up once, then does nothing more the same day', () => {
  const dbFile = path.join(dir, 'closing.db');
  const backupDir = path.join(dir, 'backups');
  const env = { PIXBERRY_DB: dbFile, PIXBERRY_BACKUP_DIR: backupDir, ADMIN_PASSWORD: 'closing-test-pw-123' };
  execFileSync(node, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'seed.js')], { env: { PATH: process.env.PATH, ...env } });

  // force the café closed every day of the week
  execFileSync(node, ['--disable-warning=ExperimentalWarning', '-e', `
    const U = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'util.js'))});
    const closed = {}; for (let d = 0; d < 7; d++) closed[d] = { open: '09:00', close: '18:00', closed: true };
    U.setSetting('hours', closed);
  `], { env: { PATH: process.env.PATH, ...env } });

  const first = run('closing-watch.js', env);
  assert.match(first, /Running the end-of-day backup/);
  assert.match(first, /Backup written/);
  assert.equal(fs.readdirSync(backupDir).filter(f => f.includes('closing')).length, 1);

  const second = run('closing-watch.js', env);
  assert.match(second, /Already handled closing for/);
  assert.equal(fs.readdirSync(backupDir).filter(f => f.includes('closing')).length, 1, 'no second backup the same day');
});

test('closing-watch.js does nothing while the café is open', () => {
  const dbFile = path.join(dir, 'open.db');
  const backupDir = path.join(dir, 'open-backups');
  const env = { PIXBERRY_DB: dbFile, PIXBERRY_BACKUP_DIR: backupDir, ADMIN_PASSWORD: 'open-test-pw-123' };
  execFileSync(node, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'seed.js')], { env: { PATH: process.env.PATH, ...env } });
  const out = run('closing-watch.js', env);
  assert.match(out, /Still open/);
  assert.ok(!fs.existsSync(backupDir) || fs.readdirSync(backupDir).length === 0);
});

test('closing-watch.js --shutdown is harmless off Windows', () => {
  const dbFile = path.join(dir, 'shutdown.db');
  const backupDir = path.join(dir, 'shutdown-backups');
  const env = { PIXBERRY_DB: dbFile, PIXBERRY_BACKUP_DIR: backupDir, ADMIN_PASSWORD: 'shutdown-test-pw-123' };
  execFileSync(node, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'seed.js')], { env: { PATH: process.env.PATH, ...env } });
  execFileSync(node, ['--disable-warning=ExperimentalWarning', '-e', `
    const U = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'util.js'))});
    const closed = {}; for (let d = 0; d < 7; d++) closed[d] = { open: '09:00', close: '18:00', closed: true };
    U.setSetting('hours', closed);
  `], { env: { PATH: process.env.PATH, ...env } });
  const out = run('closing-watch.js', env, ['--shutdown']);
  assert.match(out, /Backup written/);
  if (process.platform !== 'win32') assert.match(out, /only does anything on Windows/);
});
