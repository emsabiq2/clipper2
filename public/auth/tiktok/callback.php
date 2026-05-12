<?php
$code = isset($_GET['code']) ? trim($_GET['code']) : '';
$state = isset($_GET['state']) ? trim($_GET['state']) : '';
$error = isset($_GET['error']) ? trim($_GET['error']) : '';
$errorDescription = isset($_GET['error_description']) ? trim($_GET['error_description']) : '';
$redirectUri = 'https://clipper2.emsa.pro/auth/tiktok/callback.php';
$dashboardUrl = 'https://clipper2.emsa.pro/login-tiktok.php';
$continueUrl = $code
  ? $dashboardUrl . '?tiktok_code=' . rawurlencode($code) . ($state ? '&tiktok_state=' . rawurlencode($state) : '')
  : $dashboardUrl;

if ($code && !$error) {
  header('Location: ' . $continueUrl, true, 302);
  exit;
}

function e($value) {
  return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8');
}
?>
<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TikTok Authorization</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 40px;
      line-height: 1.5;
      color: #161616;
    }
    code, textarea {
      font-family: Consolas, monospace;
      font-size: 14px;
    }
    textarea {
      width: 100%;
      min-height: 90px;
    }
    .box {
      max-width: 820px;
    }
  </style>
</head>
<body>
  <div class="box">
    <h1>TikTok Authorization</h1>

    <?php if ($error): ?>
      <p>Login TikTok gagal.</p>
      <p><strong>Error:</strong> <code><?= e($error) ?></code></p>
      <?php if ($errorDescription): ?>
        <p><strong>Detail:</strong> <?= e($errorDescription) ?></p>
      <?php endif; ?>
    <?php elseif ($code): ?>
      <p>Authorization code diterima. Lanjutkan ke halaman TikTok Direct Post untuk menyelesaikan koneksi.</p>
      <p><a href="<?= e($continueUrl) ?>">Continue to TikTok Direct Post</a></p>
      <p>Jika perlu fallback manual, jalankan command ini di project lokal:</p>
      <textarea readonly>node src/tiktok-token-fastcheck.js --code "<?= e($code) ?>" --redirect-uri "<?= e($redirectUri) ?>" --persist-local</textarea>
      <p><strong>Redirect URI:</strong> <code><?= e($redirectUri) ?></code></p>
      <?php if ($state): ?>
        <p><strong>State:</strong> <code><?= e($state) ?></code></p>
      <?php endif; ?>
    <?php else: ?>
      <p>Callback aktif. Gunakan URL ini sebagai Redirect URI di TikTok Developer:</p>
      <p><code><?= e($redirectUri) ?></code></p>
    <?php endif; ?>
  </div>
</body>
</html>
