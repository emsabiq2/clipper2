<?php
$code = isset($_GET['code']) ? trim($_GET['code']) : '';
$state = isset($_GET['state']) ? trim($_GET['state']) : '';
$error = isset($_GET['error']) ? trim($_GET['error']) : '';
$errorDescription = isset($_GET['error_description']) ? trim($_GET['error_description']) : '';
$redirectUri = 'https://clipper2.emsa.pro/auth/youtube/callback.php';
$dashboardUrl = 'https://clipper2.emsa.pro/login-youtube.php';
$continueUrl = $code
  ? $dashboardUrl . '?youtube_code=' . rawurlencode($code) . ($state ? '&youtube_state=' . rawurlencode($state) : '')
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
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>YouTube Authorization</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #f5f7fb;
      color: #17202a;
      font-family: Arial, sans-serif;
      line-height: 1.5;
    }
    .box {
      width: min(820px, calc(100% - 32px));
      padding: 26px;
      border: 1px solid #d9e2ea;
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 18px 46px rgba(23, 32, 42, 0.12);
    }
    code, textarea {
      font-family: Consolas, monospace;
      font-size: 14px;
    }
    textarea {
      width: 100%;
      min-height: 90px;
    }
    a {
      color: #148f86;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <div class="box">
    <h1>YouTube Authorization</h1>

    <?php if ($error): ?>
      <p>Google OAuth authorization failed.</p>
      <p><strong>Error:</strong> <code><?= e($error) ?></code></p>
      <?php if ($errorDescription): ?>
        <p><strong>Detail:</strong> <?= e($errorDescription) ?></p>
      <?php endif; ?>
      <p><a href="<?= e($dashboardUrl) ?>">Return to YouTube Testing App</a></p>
    <?php elseif ($code): ?>
      <p>Authorization code received. Continue to the YouTube Testing App to finish token exchange.</p>
      <p><a href="<?= e($continueUrl) ?>">Continue to YouTube Testing App</a></p>
      <p>Manual fallback command for local development:</p>
      <textarea readonly>node src/youtube-check.js</textarea>
      <p><strong>Redirect URI:</strong> <code><?= e($redirectUri) ?></code></p>
      <?php if ($state): ?>
        <p><strong>State:</strong> <code><?= e($state) ?></code></p>
      <?php endif; ?>
    <?php else: ?>
      <p>Callback is active. Use this URL as an authorized redirect URI in Google Cloud OAuth Client:</p>
      <p><code><?= e($redirectUri) ?></code></p>
      <p><a href="<?= e($dashboardUrl) ?>">Open YouTube Testing App</a></p>
    <?php endif; ?>
  </div>
</body>
</html>
