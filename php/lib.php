<?php
// Pixberry Café — PHP + MySQL edition (runs on shared hosting such as InfinityFree).
declare(strict_types=1);

if (!is_file(__DIR__ . '/config.php')) {
    if (basename($_SERVER['SCRIPT_NAME'] ?? '') !== 'install.php') { header('Location: install.php'); exit; }
} else {
    require __DIR__ . '/config.php';
}
date_default_timezone_set(defined('PB_TZ') ? PB_TZ : 'Asia/Kolkata');

const PB_DEFAULTS = [
    'cafe_name' => 'My Café', 'logo' => '', 'title' => 'MENU', 'welcome' => 'Welcome to {cafe}',
    'tagline' => 'Tap an item, place your order, and enjoy every bite with comfort & happiness ✨', 'accent' => '#a8d672', 'instagram' => '',
    'lat' => null, 'lng' => null, 'radius_m' => 100, 'geofence' => true, 'tolerance_m' => 30, 'max_accuracy_m' => 300,
    'gst' => 5, 'gst_mode' => 'exclusive', 'late_min' => 15, 'currency' => '₹',
];

function db(): PDO {
    static $pdo = null;
    if ($pdo) return $pdo;
    $pdo = new PDO('mysql:host=' . PB_DB_HOST . ';dbname=' . PB_DB_NAME . ';charset=utf8mb4', PB_DB_USER, PB_DB_PASS, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    $pdo->exec("SET time_zone = '+00:00'");
    return $pdo;
}
function q(string $sql, array $p = []): PDOStatement { $s = db()->prepare($sql); $s->execute($p); return $s; }

function schema(): array {
    return [
        "CREATE TABLE IF NOT EXISTS pb_settings (k VARCHAR(64) PRIMARY KEY, v TEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS pb_staff (id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(60) NOT NULL UNIQUE, name VARCHAR(100) NOT NULL,
           pass_hash VARCHAR(255) NOT NULL, role VARCHAR(20) NOT NULL DEFAULT 'cashier', active TINYINT NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS pb_tables (id INT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(40) NOT NULL, token VARCHAR(40) NOT NULL UNIQUE, kind VARCHAR(10) NOT NULL DEFAULT 'table',
           active TINYINT NOT NULL DEFAULT 1, sort INT NOT NULL DEFAULT 0) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS pb_items (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(80) NOT NULL, descr VARCHAR(200) NOT NULL DEFAULT '', price DECIMAL(10,2) NOT NULL,
           cat VARCHAR(40) NOT NULL DEFAULT 'Menu', diet VARCHAR(10) NOT NULL DEFAULT 'veg', sold_out TINYINT NOT NULL DEFAULT 0, photo VARCHAR(120) NOT NULL DEFAULT '', sort INT NOT NULL DEFAULT 0) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS pb_orders (id INT AUTO_INCREMENT PRIMARY KEY, day DATE NOT NULL, number INT NOT NULL, okey VARCHAR(40) NOT NULL UNIQUE, client_ref VARCHAR(64) NULL UNIQUE,
           table_label VARCHAR(40) NOT NULL, kind VARCHAR(10) NOT NULL DEFAULT 'dine_in', customer VARCHAR(80) NOT NULL DEFAULT '', items TEXT NOT NULL, note VARCHAR(200) NOT NULL DEFAULT '',
           status VARCHAR(12) NOT NULL DEFAULT 'new', paid TINYINT NOT NULL DEFAULT 0, method VARCHAR(12) NOT NULL DEFAULT '', sub DECIMAL(10,2) NOT NULL, tax DECIMAL(10,2) NOT NULL, total DECIMAL(10,2) NOT NULL,
           bill_requested TINYINT NOT NULL DEFAULT 0, waiter_called TINYINT NOT NULL DEFAULT 0, distance_m INT NULL, source VARCHAR(10) NOT NULL DEFAULT 'qr',
           created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, paid_at DATETIME NULL, INDEX (day), INDEX (status, paid)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
    ];
}

// ---------- settings ----------
function settings(): array {
    static $cache = null;
    if ($cache !== null) return $cache;
    $s = PB_DEFAULTS;
    foreach (q('SELECT k, v FROM pb_settings')->fetchAll() as $r) if (array_key_exists($r['k'], $s)) $s[$r['k']] = json_decode($r['v'], true);
    return $cache = $s;
}
function save_settings(array $patch): void {
    $st = db()->prepare('INSERT INTO pb_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)');
    foreach ($patch as $k => $v) if (array_key_exists($k, PB_DEFAULTS)) $st->execute([$k, json_encode($v, JSON_UNESCAPED_UNICODE)]);
}

// ---------- http ----------
function out($data, int $code = 200): never {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}
function fail(string $msg, int $code = 400, array $extra = []): never { out(['error' => $msg] + $extra, $code); }
function body(): array { static $b = null; if ($b === null) { $b = json_decode(file_get_contents('php://input') ?: '[]', true); if (!is_array($b)) $b = []; } return $b; }
function token(int $bytes = 12): string { return rtrim(strtr(base64_encode(random_bytes($bytes)), '+/', '-_'), '='); }
function now(): string { return gmdate('Y-m-d H:i:s'); }
function h(?string $s): string { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }

// ---------- staff sessions ----------
function start_session(): void {
    if (session_status() === PHP_SESSION_ACTIVE) return;
    session_name('pbsess');
    session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'httponly' => true, 'samesite' => 'Lax', 'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off']);
    session_start();
}
function staff(): ?array {
    start_session();
    if (empty($_SESSION['uid'])) return null;
    $u = q('SELECT id, username, name, role, active FROM pb_staff WHERE id = ?', [$_SESSION['uid']])->fetch();
    return $u && $u['active'] ? $u : null;
}
const PB_ROLES = ['admin' => ['kitchen', 'counter', 'menu', 'tables', 'sales', 'setup'], 'cashier' => ['kitchen', 'counter', 'sales'], 'kitchen' => ['kitchen']];
function require_staff(string $area): array {
    $u = staff();
    if (!$u) fail('Please sign in.', 401);
    if (!in_array($area, PB_ROLES[$u['role']] ?? [], true)) fail("Your role can't do this.", 403);
    if ($_SERVER['REQUEST_METHOD'] === 'POST' && !hash_equals($_SESSION['csrf'] ?? '', $_SERVER['HTTP_X_CSRF'] ?? '')) fail('Session expired. Reload the page.', 419);
    return $u;
}

// ---------- distance check (enforced on the server for every guest order / request) ----------
function distance_m(float $a, float $b, float $c, float $d): float {
    $r = M_PI / 180; $R = 6371008.8;
    $h = sin(($c - $a) * $r / 2) ** 2 + cos($a * $r) * cos($c * $r) * sin(($d - $b) * $r / 2) ** 2;
    return 2 * $R * asin(min(1, sqrt($h)));
}
function geofence($loc): array {
    $s = settings();
    if (!$s['geofence']) return ['allowed' => true, 'code' => 'off', 'radius_m' => $s['radius_m']];
    if ($s['lat'] === null || $s['lng'] === null) return ['allowed' => false, 'code' => 'unset', 'radius_m' => $s['radius_m'], 'reason' => 'Online ordering is not set up yet. Please order with the staff.'];
    $lat = $loc['lat'] ?? null; $lng = $loc['lng'] ?? null; $acc = (float)($loc['accuracy'] ?? 0);
    if (!is_numeric($lat) || !is_numeric($lng) || abs((float)$lat) > 90 || abs((float)$lng) > 180)
        return ['allowed' => false, 'code' => 'none', 'radius_m' => $s['radius_m'], 'reason' => 'Please allow location access so we can confirm you are at the café.'];
    if ($acc > $s['max_accuracy_m'])
        return ['allowed' => false, 'code' => 'rough', 'radius_m' => $s['radius_m'], 'reason' => 'Your location is too imprecise (±' . round($acc) . ' m). Turn on precise location / GPS and try again.'];
    $d = distance_m((float)$lat, (float)$lng, (float)$s['lat'], (float)$s['lng']);
    $ok = $d - min($acc, (float)$s['tolerance_m']) <= $s['radius_m'];
    $far = $d >= 1000 ? number_format($d / 1000, 1) . ' km' : round($d) . ' m';
    return ['allowed' => $ok, 'code' => $ok ? 'in' : 'out', 'distance_m' => (int)round($d), 'radius_m' => $s['radius_m'],
            'reason' => $ok ? null : "You appear to be about $far from the café. Orders can only be placed within {$s['radius_m']} m of the café."];
}

// ---------- bill ----------
function bill(float $sub): array {
    $s = settings(); $r = (float)$s['gst'] / 100;
    if ($s['gst_mode'] === 'inclusive') { $tax = round($sub - $sub / (1 + $r), 2); return [$sub, $tax, $sub]; }
    $tax = round($sub * $r, 2);
    return [$sub, $tax, round($sub + $tax, 2)];
}
function public_order(array $o): array {
    return ['key' => $o['okey'], 'number' => (int)$o['number'], 'table' => $o['table_label'], 'items' => json_decode($o['items'], true), 'note' => $o['note'],
            'status' => $o['status'], 'paid' => (bool)$o['paid'], 'sub' => (float)$o['sub'], 'tax' => (float)$o['tax'], 'total' => (float)$o['total'],
            'bill_requested' => (bool)$o['bill_requested'], 'created_at' => $o['created_at'] . 'Z'];
}
function staff_order(array $o): array {
    return public_order($o) + ['id' => (int)$o['id'], 'method' => $o['method'], 'waiter_called' => (bool)$o['waiter_called'], 'distance_m' => $o['distance_m'] === null ? null : (int)$o['distance_m'],
            'source' => $o['source'], 'customer' => $o['customer'], 'paid_at' => $o['paid_at'] ? $o['paid_at'] . 'Z' : null, 'updated_at' => $o['updated_at'] . 'Z'];
}
