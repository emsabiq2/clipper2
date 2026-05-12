<?php
$query = $_SERVER['QUERY_STRING'] ?? '';
header('Location: /login-tiktok.php' . ($query ? '?' . $query : ''), true, 302);
exit;
