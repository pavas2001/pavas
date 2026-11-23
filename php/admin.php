<?php require __DIR__ . '/lib.php'; $s = settings(); ?><!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#2b1f47"><title><?= h($s['cafe_name']) ?> — Back office</title>
<link rel="stylesheet" href="assets/admin.css"></head>
<body>
<div id="login" class="center" hidden>
  <form class="card narrow" id="lf">
    <div class="row"><div class="mark">P</div><div><h1><?= h($s['cafe_name']) ?></h1><div class="muted">Back office sign in</div></div></div>
    <label>Username<input id="lu" autocomplete="username" required></label>
    <label>Password<input id="lp" type="password" autocomplete="current-password" required></label>
    <p class="hint" id="le" role="alert" style="color:var(--bad)"></p>
    <button class="btn primary">Sign in</button>
  </form>
</div>
<div id="app" hidden>
  <header class="head"><div class="in">
    <div class="mark">P</div>
    <div class="grow"><h1 id="cafeName"></h1><div class="sub" id="who"></div></div>
    <button class="btn light sm" id="logout">Sign out</button>
  </div></header>
  <nav class="tabs" id="tabs"></nav>
  <main id="view"></main>
</div>
<div id="toasts" aria-live="polite"></div>
<script src="assets/qrcode.js"></script>
<script src="assets/art.js"></script>
<script src="assets/admin.js"></script>
</body></html>
