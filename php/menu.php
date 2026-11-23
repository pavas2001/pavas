<?php require __DIR__ . '/lib.php'; $s = settings(); ?><!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#1e1535"><title><?= h($s['cafe_name']) ?> — Menu</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap">
<link rel="stylesheet" href="assets/guest.css"></head>
<body><div id="app"><p class="boot">Loading menu…</p></div><div id="toasts" aria-live="polite"></div>
<script src="assets/art.js"></script><script src="assets/guest.js"></script></body></html>
