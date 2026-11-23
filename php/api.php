<?php
declare(strict_types=1);
require __DIR__ . '/lib.php';

set_exception_handler(function (Throwable $e) {
    error_log('[pixberry] ' . $e->getMessage());
    fail('Something went wrong. Please try again.', 500);
});

$a = $_GET['a'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];
$b = body();

function table_by_token(): array {
    $t = q('SELECT * FROM pb_tables WHERE token = ? AND active = 1', [(string)($_GET['t'] ?? '')])->fetch();
    if (!$t) fail('This QR code is not valid any more. Please ask the staff.', 404);
    return $t;
}
function throttle(string $key, int $max, int $window): void {
    start_session();
    $now = time(); $hits = array_filter($_SESSION['rl'][$key] ?? [], fn($t) => $now - $t < $window);
    if (count($hits) >= $max) fail('Too many requests — please wait a moment.', 429);
    $hits[] = $now; $_SESSION['rl'][$key] = array_values($hits);
}
function item_row(array $r): array {
    return ['id' => (int)$r['id'], 'name' => $r['name'], 'desc' => $r['descr'], 'price' => (float)$r['price'], 'cat' => $r['cat'], 'diet' => $r['diet'], 'sold_out' => (bool)$r['sold_out'], 'photo' => $r['photo'] ? 'uploads/' . $r['photo'] : ''];
}
function save_image(array $file, int $max = 900): string {
    if (($file['error'] ?? 1) !== UPLOAD_ERR_OK) fail('Upload failed. Try a smaller image (under 5 MB).');
    if ($file['size'] > 5 * 1024 * 1024) fail('Image must be under 5 MB.');
    $info = @getimagesize($file['tmp_name']);
    if (!$info || !in_array($info[2], [IMAGETYPE_JPEG, IMAGETYPE_PNG, IMAGETYPE_WEBP], true)) fail('Upload a JPG, PNG or WebP image.');
    $name = bin2hex(random_bytes(10));
    if (function_exists('imagecreatefromstring')) { // re-encode: resizes and strips anything that isn't pixels
        $src = @imagecreatefromstring(file_get_contents($file['tmp_name']));
        if (!$src) fail('That image could not be read.');
        [$w, $hgt] = [imagesx($src), imagesy($src)]; $k = min(1, $max / max($w, $hgt));
        $dst = imagecreatetruecolor((int)round($w * $k), (int)round($hgt * $k));
        imagefill($dst, 0, 0, imagecolorallocate($dst, 255, 255, 255));
        imagecopyresampled($dst, $src, 0, 0, 0, 0, imagesx($dst), imagesy($dst), $w, $hgt);
        imagejpeg($dst, __DIR__ . "/uploads/$name.jpg", 84);
        return "$name.jpg";
    }
    $ext = [IMAGETYPE_JPEG => 'jpg', IMAGETYPE_PNG => 'png', IMAGETYPE_WEBP => 'webp'][$info[2]];
    move_uploaded_file($file['tmp_name'], __DIR__ . "/uploads/$name.$ext");
    return "$name.$ext";
}
function remove_upload(string $f): void { if (preg_match('/^[a-f0-9]{20}\.(jpg|png|webp)$/', $f)) @unlink(__DIR__ . "/uploads/$f"); }
function order_or_404(int $id): array { $o = q('SELECT * FROM pb_orders WHERE id = ?', [$id])->fetch(); if (!$o) fail('Order not found', 404); return $o; }

switch ($a) {
// ================= Guest (QR) =================
case 'menu':
    $t = table_by_token(); $s = settings();
    $items = array_map('item_row', q('SELECT * FROM pb_items ORDER BY cat, sort, name')->fetchAll());
    out(['cafe' => ['name' => $s['cafe_name'], 'logo' => $s['logo'] ? 'uploads/' . $s['logo'] : ''],
         'page' => ['title' => $s['title'], 'welcome' => $s['welcome'], 'tagline' => $s['tagline'], 'accent' => $s['accent'], 'instagram' => $s['instagram']],
         'table' => ['label' => $t['label'], 'kind' => $t['kind']], 'currency' => $s['currency'],
         'gst' => ['rate' => (float)$s['gst'], 'mode' => $s['gst_mode']],
         'geofence' => ['enabled' => (bool)$s['geofence'], 'radius_m' => (int)$s['radius_m'], 'configured' => $s['lat'] !== null],
         'items' => $items]);

case 'locate':
    table_by_token(); throttle('locate', 30, 60);
    out(geofence($b));

case 'order':
    if ($method !== 'POST') fail('POST only', 405);
    $t = table_by_token(); throttle('order', 10, 60);
    $g = geofence($b['location'] ?? null);
    if (!$g['allowed']) fail($g['reason'], 403, ['geofence' => $g]);   // the real enforcement
    $ref = isset($b['client_ref']) ? substr(preg_replace('/[^A-Za-z0-9_-]/', '', (string)$b['client_ref']), 0, 64) : null;
    if ($ref) { $dup = q('SELECT * FROM pb_orders WHERE client_ref = ?', [$ref])->fetch(); if ($dup) out(['order' => public_order($dup), 'duplicate' => true]); }
    $lines = [];
    foreach (array_slice((array)($b['items'] ?? []), 0, 50) as $l) {
        $it = q('SELECT * FROM pb_items WHERE id = ?', [(int)($l['id'] ?? 0)])->fetch();
        if (!$it) fail('An item in your cart is no longer on the menu. Please refresh.', 409);
        if ($it['sold_out']) fail("{$it['name']} is sold out.", 409);
        $qty = max(1, min(50, (int)($l['qty'] ?? 1)));
        $lines[] = ['id' => (int)$it['id'], 'name' => $it['name'], 'price' => (float)$it['price'], 'qty' => $qty];   // price from the database, never the phone
    }
    if (!$lines) fail('Your cart is empty.');
    $customer = trim(mb_substr((string)($b['customer'] ?? ''), 0, 80));
    if ($t['kind'] === 'counter' && $customer === '') fail('Please enter your name for the takeaway order.');
    [$sub, $tax, $total] = bill(array_sum(array_map(fn($l) => $l['price'] * $l['qty'], $lines)));
    $pdo = db(); $pdo->beginTransaction();
    $day = date('Y-m-d');
    $num = (int)q('SELECT COALESCE(MAX(number), 0) + 1 FROM pb_orders WHERE day = ? FOR UPDATE', [$day])->fetchColumn();
    $key = token(16);
    q('INSERT INTO pb_orders (day, number, okey, client_ref, table_label, kind, customer, items, note, sub, tax, total, distance_m, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [$day, $num, $key, $ref ?: null, $t['label'], $t['kind'] === 'counter' ? 'takeaway' : 'dine_in', $customer, json_encode($lines, JSON_UNESCAPED_UNICODE),
       mb_substr(trim((string)($b['note'] ?? '')), 0, 200), $sub, $tax, $total, $g['distance_m'] ?? null, 'qr', now(), now()]);
    $pdo->commit();
    out(['order' => public_order(q('SELECT * FROM pb_orders WHERE okey = ?', [$key])->fetch())], 201);

case 'status':
    $keys = array_slice(array_filter(explode(',', (string)($_GET['keys'] ?? ''))), 0, 20);
    if (!$keys) out([]);
    $rows = q('SELECT * FROM pb_orders WHERE okey IN (' . implode(',', array_fill(0, count($keys), '?')) . ') ORDER BY id DESC', $keys)->fetchAll();
    out(array_map('public_order', $rows));

case 'request':
    if ($method !== 'POST') fail('POST only', 405);
    table_by_token(); throttle('request', 6, 60);
    $g = geofence($b['location'] ?? null);
    if (!$g['allowed']) fail($g['reason'], 403, ['geofence' => $g]);
    $o = q('SELECT * FROM pb_orders WHERE okey = ? AND paid = 0 AND status != \'cancelled\'', [(string)($b['key'] ?? '')])->fetch();
    if (!$o) fail('No open order found for you.');
    q('UPDATE pb_orders SET ' . (($b['type'] ?? '') === 'bill' ? 'bill_requested' : 'waiter_called') . ' = 1, updated_at = ? WHERE id = ?', [now(), $o['id']]);
    out(['ok' => true]);

// ================= Staff =================
case 'login':
    if ($method !== 'POST') fail('POST only', 405);
    start_session(); throttle('login', 8, 600);
    $u = q('SELECT * FROM pb_staff WHERE username = ? AND active = 1', [(string)($b['username'] ?? '')])->fetch();
    if (!$u || !password_verify((string)($b['password'] ?? ''), $u['pass_hash'])) fail('Incorrect username or password', 401);
    session_regenerate_id(true);
    $_SESSION['uid'] = (int)$u['id']; $_SESSION['csrf'] = token(24);
    out(['ok' => true]);

case 'logout':
    start_session(); $_SESSION = []; session_destroy(); out(['ok' => true]);

case 'me':
    $u = staff(); if (!$u) fail('Please sign in.', 401);
    $s = settings();
    out(['user' => $u, 'areas' => PB_ROLES[$u['role']], 'csrf' => $_SESSION['csrf'], 'cafe' => $s['cafe_name'], 'currency' => $s['currency'], 'late_min' => (int)$s['late_min']]);

case 'orders':
    require_staff('kitchen');
    $rows = q("SELECT * FROM pb_orders WHERE (paid = 0 AND status != 'cancelled') OR day = ? ORDER BY id DESC LIMIT 300", [date('Y-m-d')])->fetchAll();
    out(array_map('staff_order', $rows));

case 'order_status':
    require_staff('kitchen');
    $st = (string)($b['status'] ?? '');
    if (!in_array($st, ['new', 'preparing', 'ready', 'served'], true)) fail('Invalid status');
    order_or_404((int)($b['id'] ?? 0));
    q('UPDATE pb_orders SET status = ?, updated_at = ? WHERE id = ? AND status != \'cancelled\'', [$st, now(), (int)$b['id']]);
    out(['ok' => true]);

case 'pay':
    require_staff('counter');
    $m = (string)($b['method'] ?? '');
    if (!in_array($m, ['Cash', 'UPI', 'Card'], true)) fail('Choose Cash, UPI or Card');
    $o = order_or_404((int)($b['id'] ?? 0));
    if ($o['paid'] || $o['status'] === 'cancelled') fail('This order is already closed.', 409);
    q("UPDATE pb_orders SET paid = 1, method = ?, paid_at = ?, status = 'served', bill_requested = 0, waiter_called = 0, updated_at = ? WHERE id = ?", [$m, now(), now(), $o['id']]);
    out(['ok' => true]);

case 'cancel':
    require_staff('counter');
    $o = order_or_404((int)($b['id'] ?? 0));
    if ($o['paid']) fail('Paid orders cannot be cancelled here.', 409);
    q("UPDATE pb_orders SET status = 'cancelled', updated_at = ? WHERE id = ?", [now(), $o['id']]);
    out(['ok' => true]);

case 'waiter_done':
    require_staff('counter');
    q('UPDATE pb_orders SET waiter_called = 0, updated_at = ? WHERE id = ?', [now(), (int)($b['id'] ?? 0)]);
    out(['ok' => true]);

case 'items':
    require_staff('menu');
    out(array_map('item_row', q('SELECT * FROM pb_items ORDER BY cat, sort, name')->fetchAll()));

case 'item_save':
    require_staff('menu');
    $name = trim(mb_substr((string)($b['name'] ?? ''), 0, 80)); $price = (float)($b['price'] ?? -1);
    if ($name === '' || $price < 0 || $price > 1000000) fail('Enter a name and a valid price.');
    $diet = in_array($b['diet'] ?? '', ['veg', 'egg', 'nonveg'], true) ? $b['diet'] : 'veg';
    $vals = [$name, mb_substr(trim((string)($b['desc'] ?? '')), 0, 200), round($price, 2), mb_substr(trim((string)($b['cat'] ?? '')), 0, 40) ?: 'Menu', $diet, !empty($b['sold_out']) ? 1 : 0];
    if (!empty($b['id'])) { q('UPDATE pb_items SET name=?, descr=?, price=?, cat=?, diet=?, sold_out=? WHERE id=?', [...$vals, (int)$b['id']]); $id = (int)$b['id']; }
    else { q('INSERT INTO pb_items (name, descr, price, cat, diet, sold_out) VALUES (?,?,?,?,?,?)', $vals); $id = (int)db()->lastInsertId(); }
    out(item_row(q('SELECT * FROM pb_items WHERE id = ?', [$id])->fetch()));

case 'item_soldout':
    require_staff('menu');
    q('UPDATE pb_items SET sold_out = ? WHERE id = ?', [!empty($b['sold_out']) ? 1 : 0, (int)($b['id'] ?? 0)]);
    out(['ok' => true]);

case 'item_delete':
    require_staff('menu');
    $it = q('SELECT photo FROM pb_items WHERE id = ?', [(int)($b['id'] ?? 0)])->fetch();
    if ($it) { remove_upload($it['photo']); q('DELETE FROM pb_items WHERE id = ?', [(int)$b['id']]); }
    out(['ok' => true]);

case 'item_photo':
    require_staff('menu');
    $id = (int)($_POST['id'] ?? 0);
    $it = q('SELECT photo FROM pb_items WHERE id = ?', [$id])->fetch(); if (!$it) fail('Item not found', 404);
    if (!empty($_POST['remove'])) { remove_upload($it['photo']); q("UPDATE pb_items SET photo = '' WHERE id = ?", [$id]); out(['photo' => '']); }
    $f = save_image($_FILES['photo'] ?? []);
    remove_upload($it['photo']);
    q('UPDATE pb_items SET photo = ? WHERE id = ?', [$f, $id]);
    out(['photo' => "uploads/$f"]);

case 'tables':
    require_staff('tables');
    out(q('SELECT id, label, token, kind FROM pb_tables WHERE active = 1 ORDER BY sort, id')->fetchAll());

case 'tables_count':
    require_staff('tables');
    $n = max(1, min(60, (int)($b['count'] ?? 0)));
    $cur = q("SELECT id, label FROM pb_tables WHERE kind = 'table' AND active = 1 ORDER BY sort, id")->fetchAll();
    for ($i = count($cur) + 1; $i <= $n; $i++) q('INSERT INTO pb_tables (label, token, sort) VALUES (?, ?, ?)', ["T$i", token(), $i]);
    foreach (array_slice($cur, $n) as $r) q('UPDATE pb_tables SET active = 0, token = ? WHERE id = ?', [token(), $r['id']]);
    out(['ok' => true]);

case 'table_regen':
    require_staff('tables');
    q('UPDATE pb_tables SET token = ? WHERE id = ?', [token(), (int)($b['id'] ?? 0)]);
    out(['ok' => true]);

case 'sales':
    require_staff('sales');
    $day = preg_match('/^\d{4}-\d{2}-\d{2}$/', (string)($_GET['day'] ?? '')) ? $_GET['day'] : date('Y-m-d');
    $rows = q('SELECT * FROM pb_orders WHERE day = ?', [$day])->fetchAll();
    $paid = array_values(array_filter($rows, fn($o) => $o['paid']));
    $items = []; $methods = [];
    foreach ($paid as $o) {
        $methods[$o['method']] = ($methods[$o['method']] ?? 0) + (float)$o['total'];
        foreach (json_decode($o['items'], true) as $l) $items[$l['name']] = ($items[$l['name']] ?? 0) + $l['qty'];
    }
    arsort($items); arsort($methods);
    $gross = array_sum(array_map(fn($o) => (float)$o['total'], $paid));
    out(['day' => $day, 'orders' => count($paid), 'gross' => round($gross, 2), 'tax' => round(array_sum(array_map(fn($o) => (float)$o['tax'], $paid)), 2),
         'avg' => $paid ? round($gross / count($paid), 2) : 0, 'cancelled' => count(array_filter($rows, fn($o) => $o['status'] === 'cancelled')),
         'items' => array_slice($items, 0, 10, true), 'methods' => $methods]);

case 'settings':
    require_staff('setup');
    $s = settings(); $s['logo_url'] = $s['logo'] ? 'uploads/' . $s['logo'] : '';
    out($s);

case 'settings_save':
    require_staff('setup');
    $p = [];
    foreach (['cafe_name' => 80, 'title' => 40, 'welcome' => 120, 'tagline' => 200, 'instagram' => 60] as $k => $len) if (isset($b[$k])) $p[$k] = mb_substr(trim((string)$b[$k]), 0, $len);
    if (isset($b['accent'])) { if (!preg_match('/^#[0-9a-fA-F]{6}$/', (string)$b['accent'])) fail('Accent colour must look like #a8d672'); $p['accent'] = $b['accent']; }
    if (array_key_exists('lat', $b) || array_key_exists('lng', $b)) {
        $lat = $b['lat'] ?? null; $lng = $b['lng'] ?? null;
        if ($lat === null || $lat === '' || $lng === null || $lng === '') { $p['lat'] = null; $p['lng'] = null; }
        else { if (!is_numeric($lat) || abs((float)$lat) > 90 || !is_numeric($lng) || abs((float)$lng) > 180) fail('Latitude must be -90…90 and longitude -180…180'); $p['lat'] = (float)$lat; $p['lng'] = (float)$lng; }
    }
    $num = function ($k, $min, $max, $msg) use ($b, &$p) { if (isset($b[$k])) { $v = (float)$b[$k]; if ($v < $min || $v > $max) fail($msg); $p[$k] = $v; } };
    $num('radius_m', 10, 50000, 'Radius must be 10 m to 50 km'); $num('tolerance_m', 0, 500, 'GPS allowance must be 0–500 m');
    $num('max_accuracy_m', 20, 10000, 'Precision must be 20–10000 m'); $num('gst', 0, 28, 'GST must be 0–28%'); $num('late_min', 1, 120, 'Kitchen time must be 1–120 min');
    if (isset($b['geofence'])) $p['geofence'] = (bool)$b['geofence'];
    if (isset($b['gst_mode'])) $p['gst_mode'] = $b['gst_mode'] === 'inclusive' ? 'inclusive' : 'exclusive';
    save_settings($p);
    out(['ok' => true]);

case 'geofence_test':
    require_staff('setup');
    out(geofence($b));

case 'logo':
    require_staff('setup');
    $f = save_image($_FILES['logo'] ?? [], 600);
    remove_upload((string)settings()['logo']);
    save_settings(['logo' => $f]);
    out(['logo_url' => "uploads/$f"]);

case 'staff':
    require_staff('setup');
    out(q('SELECT id, username, name, role, active FROM pb_staff ORDER BY active DESC, name')->fetchAll());

case 'staff_save':
    $me = require_staff('setup');
    $role = in_array($b['role'] ?? '', ['admin', 'cashier', 'kitchen'], true) ? $b['role'] : 'cashier';
    $name = trim(mb_substr((string)($b['name'] ?? ''), 0, 100)); $pw = (string)($b['password'] ?? '');
    if ($name === '') fail('Enter a name');
    if (!empty($b['id'])) {
        $id = (int)$b['id']; $active = !empty($b['active']) ? 1 : 0;
        if ($id === (int)$me['id'] && ($active === 0 || $role !== 'admin')) fail("You can't remove your own admin access.");
        q('UPDATE pb_staff SET name = ?, role = ?, active = ? WHERE id = ?', [$name, $role, $active, $id]);
        if ($pw !== '') { if (strlen($pw) < 8) fail('Password must be at least 8 characters'); q('UPDATE pb_staff SET pass_hash = ? WHERE id = ?', [password_hash($pw, PASSWORD_DEFAULT), $id]); }
    } else {
        $user = trim((string)($b['username'] ?? ''));
        if (!preg_match('/^[A-Za-z0-9_.-]{3,40}$/', $user)) fail('Username: 3–40 letters, numbers, dots, dashes or underscores');
        if (strlen($pw) < 8) fail('Password must be at least 8 characters');
        if (q('SELECT id FROM pb_staff WHERE username = ?', [$user])->fetch()) fail('That username is taken');
        q('INSERT INTO pb_staff (username, name, pass_hash, role) VALUES (?,?,?,?)', [$user, $name, password_hash($pw, PASSWORD_DEFAULT), $role]);
    }
    out(['ok' => true]);

default:
    fail('Unknown action', 404);
}
