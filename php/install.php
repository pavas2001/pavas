<?php
declare(strict_types=1);
require __DIR__ . '/lib.php';

$installed = is_file(__DIR__ . '/config.php');
$err = ''; $done = false;
$v = fn($k, $d = '') => h($_POST[$k] ?? $d);

if (!$installed && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $host = trim($_POST['db_host'] ?? ''); $name = trim($_POST['db_name'] ?? ''); $user = trim($_POST['db_user'] ?? ''); $pass = (string)($_POST['db_pass'] ?? '');
    $cafe = trim($_POST['cafe'] ?? ''); $admin = trim($_POST['admin_user'] ?? ''); $apass = (string)($_POST['admin_pass'] ?? '');
    $tables = max(1, min(60, (int)($_POST['tables'] ?? 8)));
    try {
        if ($host === '' || $name === '' || $user === '') throw new RuntimeException('Fill in all the database details.');
        if ($cafe === '') throw new RuntimeException('Enter your café name.');
        if (!preg_match('/^[A-Za-z0-9_.-]{3,40}$/', $admin)) throw new RuntimeException('Admin username: 3–40 letters, numbers, dots, dashes or underscores.');
        if (strlen($apass) < 8) throw new RuntimeException('Admin password must be at least 8 characters.');
        $pdo = new PDO("mysql:host=$host;dbname=$name;charset=utf8mb4", $user, $pass, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        foreach (schema() as $sql) $pdo->exec($sql);
        $cfg = "<?php\n// Written by install.php. Keep this file private.\n"
             . 'const PB_DB_HOST = ' . var_export($host, true) . ";\n"
             . 'const PB_DB_NAME = ' . var_export($name, true) . ";\n"
             . 'const PB_DB_USER = ' . var_export($user, true) . ";\n"
             . 'const PB_DB_PASS = ' . var_export($pass, true) . ";\n"
             . "const PB_TZ = 'Asia/Kolkata';\n";
        if (@file_put_contents(__DIR__ . '/config.php', $cfg) === false) throw new RuntimeException('Could not write config.php. Check the folder is writable in File Manager.');
        require __DIR__ . '/config.php';
        q('INSERT INTO pb_staff (username, name, pass_hash, role) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE pass_hash = VALUES(pass_hash), role = \'admin\', active = 1',
          [$admin, 'Owner', password_hash($apass, PASSWORD_DEFAULT), 'admin']);
        save_settings(['cafe_name' => $cafe]);
        if ((int)q('SELECT COUNT(*) FROM pb_tables')->fetchColumn() === 0) {
            for ($i = 1; $i <= $tables; $i++) q('INSERT INTO pb_tables (label, token, sort) VALUES (?, ?, ?)', ["T$i", token(), $i]);
            q('INSERT INTO pb_tables (label, token, kind, sort) VALUES (?, ?, ?, ?)', ['Counter', token(), 'counter', 999]);
        }
        $done = true;
    } catch (PDOException $e) {
        $err = 'Could not connect to the database. Check the host, name, username and password from your hosting panel (MySQL Databases). Details: ' . $e->getMessage();
    } catch (Throwable $e) { $err = $e->getMessage(); }
}
?><!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Install Pixberry Café</title>
<link rel="stylesheet" href="assets/admin.css"></head>
<body class="center"><main class="card narrow">
<h1>Pixberry Café setup</h1>
<?php if ($installed && !$done): ?>
  <p>Pixberry is already installed. <a href="admin.php">Open the back office</a>.</p>
  <p class="hint">To reinstall, delete <code>config.php</code> in File Manager first. Your data in the database is kept.</p>
<?php elseif ($done): ?>
  <p class="banner ok">Installed! Your database is ready.</p>
  <ol><li><a href="admin.php">Open the back office</a> and sign in as <b><?= h($admin) ?></b>.</li>
  <li>In <b>Setup</b>, stand inside your café and press <b>Use my current location</b>, then add your menu.</li>
  <li>For safety, delete <code>install.php</code> in File Manager.</li></ol>
<?php else: ?>
  <p class="muted">Enter the MySQL details from your hosting panel (InfinityFree: <b>Control Panel → MySQL Databases</b>).</p>
  <?php if ($err): ?><p class="banner bad"><?= h($err) ?></p><?php endif; ?>
  <form method="post" class="grid">
    <label>MySQL host name<input name="db_host" required placeholder="sql123.infinityfree.com" value="<?= $v('db_host') ?>"></label>
    <label>MySQL database name<input name="db_name" required placeholder="if0_12345678_pixberry" value="<?= $v('db_name') ?>"></label>
    <label>MySQL username<input name="db_user" required placeholder="if0_12345678" value="<?= $v('db_user') ?>"></label>
    <label>MySQL password<input name="db_pass" type="password" placeholder="Your vPanel / hosting account password"></label>
    <hr>
    <label>Café name<input name="cafe" required value="<?= $v('cafe') ?>"></label>
    <label>Number of tables<input name="tables" type="number" min="1" max="60" value="<?= $v('tables', '8') ?>"></label>
    <label>Admin username<input name="admin_user" required value="<?= $v('admin_user', 'admin') ?>" autocomplete="username"></label>
    <label>Admin password (8+ characters)<input name="admin_pass" type="password" required minlength="8" autocomplete="new-password"></label>
    <button class="btn primary">Install</button>
  </form>
<?php endif; ?>
</main></body></html>
