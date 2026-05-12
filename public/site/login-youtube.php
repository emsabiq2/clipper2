<?php
session_start();

$defaultRedirectUri = 'https://clipper2.emsa.pro/auth/youtube/callback.php';
$config = [
  'client_id' => getenv('YOUTUBE_CLIENT_ID') ?: '',
  'client_secret' => getenv('YOUTUBE_CLIENT_SECRET') ?: '',
  'redirect_uri' => getenv('YOUTUBE_REDIRECT_URI') ?: $defaultRedirectUri,
  'scope' => getenv('YOUTUBE_AUTH_SCOPE') ?: 'https://www.googleapis.com/auth/youtube.upload',
  'app_name' => 'Clipper Emsa Pro',
  'homepage' => 'https://clipper2.emsa.pro',
  'privacy_url' => 'https://clipper2.emsa.pro/privacy-policy',
  'terms_url' => 'https://clipper2.emsa.pro/terms-of-service',
];

foreach ([
  __DIR__ . '/config/youtube.php',
  __DIR__ . '/config/youtube-production.php',
] as $configFile) {
  if (!is_file($configFile)) continue;
  $loadedConfig = include $configFile;
  if (is_array($loadedConfig)) {
    $config = array_merge($config, $loadedConfig);
    break;
  }
}

$message = '';
$error = '';
$tokenInfo = null;

function e($value) {
  return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8');
}

function mask_value($value) {
  $text = (string) $value;
  if ($text === '') return 'empty';
  if (strlen($text) <= 16) return 'configured';
  return substr($text, 0, 10) . '...' . substr($text, -8);
}

function is_enabled($value) {
  return in_array(strtolower((string) $value), ['1', 'true', 'yes', 'on'], true);
}

function build_auth_url($config) {
  if (empty($config['client_id'])) {
    throw new Exception('YOUTUBE_CLIENT_ID is not configured.');
  }
  if (empty($config['redirect_uri'])) {
    throw new Exception('YOUTUBE_REDIRECT_URI is not configured.');
  }

  $state = bin2hex(random_bytes(16));
  $_SESSION['youtube_review_state'] = $state;

  $params = [
    'client_id' => $config['client_id'],
    'redirect_uri' => $config['redirect_uri'],
    'response_type' => 'code',
    'scope' => $config['scope'],
    'access_type' => 'offline',
    'prompt' => 'consent',
    'include_granted_scopes' => 'false',
    'state' => $state,
  ];

  return 'https://accounts.google.com/o/oauth2/v2/auth?' . http_build_query($params);
}

function curl_form($url, $fields) {
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => http_build_query($fields),
    CURLOPT_HTTPHEADER => [
      'Content-Type: application/x-www-form-urlencoded',
      'Cache-Control: no-cache',
    ],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 60,
  ]);
  $raw = curl_exec($ch);
  $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  $curlError = curl_error($ch);
  curl_close($ch);
  if ($raw === false) throw new Exception('Google OAuth curl error: ' . $curlError);
  $data = json_decode($raw, true);
  if (!is_array($data)) throw new Exception('Google OAuth returned non JSON response.');
  if ($status < 200 || $status >= 300) {
    $detail = $data['error_description'] ?? $data['error'] ?? json_encode($data);
    throw new Exception('Google OAuth failed: ' . $detail);
  }
  $data['saved_at'] = time();
  return $data;
}

function curl_get_json($url) {
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 45,
  ]);
  $raw = curl_exec($ch);
  $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  $curlError = curl_error($ch);
  curl_close($ch);
  if ($raw === false) throw new Exception('Google API curl error: ' . $curlError);
  $data = json_decode($raw, true);
  if (!is_array($data)) throw new Exception('Google API returned non JSON response.');
  if ($status < 200 || $status >= 300) {
    $detail = $data['error_description'] ?? $data['error'] ?? json_encode($data);
    throw new Exception('Google API failed: ' . $detail);
  }
  return $data;
}

function exchange_youtube_code($config, $code) {
  if (empty($config['client_secret'])) {
    throw new Exception('YOUTUBE_CLIENT_SECRET is not configured.');
  }
  $token = curl_form('https://oauth2.googleapis.com/token', [
    'client_id' => $config['client_id'],
    'client_secret' => $config['client_secret'],
    'code' => $code,
    'redirect_uri' => $config['redirect_uri'],
    'grant_type' => 'authorization_code',
  ]);
  if (empty($token['refresh_token']) && !empty($_SESSION['youtube_review_token']['refresh_token'])) {
    $token['refresh_token'] = $_SESSION['youtube_review_token']['refresh_token'];
  }
  $_SESSION['youtube_review_token'] = $token;
  return $token;
}

function refresh_youtube_access_token($config, $token) {
  if (empty($token['refresh_token'])) {
    throw new Exception('Refresh token is missing. Click Reconnect YouTube again.');
  }
  if (empty($config['client_secret'])) {
    throw new Exception('YOUTUBE_CLIENT_SECRET is not configured.');
  }
  $next = curl_form('https://oauth2.googleapis.com/token', [
    'client_id' => $config['client_id'],
    'client_secret' => $config['client_secret'],
    'refresh_token' => $token['refresh_token'],
    'grant_type' => 'refresh_token',
  ]);
  $next['refresh_token'] = $token['refresh_token'];
  $_SESSION['youtube_review_token'] = array_merge($token, $next);
  return $_SESSION['youtube_review_token'];
}

function ensure_access_token($config) {
  $token = $_SESSION['youtube_review_token'] ?? null;
  if (!is_array($token) || empty($token['access_token'])) {
    throw new Exception('YouTube account is not connected.');
  }
  $savedAt = (int) ($token['saved_at'] ?? 0);
  $expiresIn = (int) ($token['expires_in'] ?? 0);
  if (!empty($token['refresh_token']) && $expiresIn > 0 && $savedAt > 0 && time() >= ($savedAt + $expiresIn - 300)) {
    $token = refresh_youtube_access_token($config, $token);
  }
  return $token['access_token'];
}

function get_token_info($accessToken) {
  return curl_get_json('https://oauth2.googleapis.com/tokeninfo?access_token=' . rawurlencode($accessToken));
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
  $action = $_POST['action'] ?? '';
  try {
    if ($action === 'disconnect') {
      unset($_SESSION['youtube_review_token'], $_SESSION['youtube_review_state']);
      $message = 'YouTube session disconnected for this testing app.';
    } elseif ($action === 'validate') {
      $tokenInfo = get_token_info(ensure_access_token($config));
      $message = 'Token validated successfully.';
    } elseif ($action === 'refresh') {
      $token = refresh_youtube_access_token($config, $_SESSION['youtube_review_token'] ?? []);
      $tokenInfo = get_token_info($token['access_token']);
      $message = 'Access token refreshed successfully using the stored refresh token.';
    }
  } catch (Throwable $exception) {
    $error = $exception->getMessage();
  }
}

if (isset($_GET['youtube_code']) && !$message && !$error) {
  try {
    $code = trim((string) $_GET['youtube_code']);
    $state = trim((string) ($_GET['youtube_state'] ?? ''));
    $expectedState = (string) ($_SESSION['youtube_review_state'] ?? '');
    if ($expectedState !== '' && $state !== $expectedState) {
      throw new Exception('OAuth state does not match. Please start Reconnect YouTube again.');
    }
    $token = exchange_youtube_code($config, $code);
    $tokenInfo = get_token_info($token['access_token']);
    $message = 'YouTube OAuth grant completed and token received.';
  } catch (Throwable $exception) {
    $error = $exception->getMessage();
  }
}

$connected = is_array($_SESSION['youtube_review_token'] ?? null) && !empty($_SESSION['youtube_review_token']['access_token']);
$token = $_SESSION['youtube_review_token'] ?? [];
$authUrl = '';
try {
  $authUrl = build_auth_url($config);
} catch (Throwable $exception) {
  if (!$error) $error = $exception->getMessage();
}

?>
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#f5f7fb">
    <title>YouTube Testing App - Clipper Emsa Pro</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f7fb;
        --surface: #ffffff;
        --surface-2: #eef4f8;
        --ink: #17202a;
        --muted: #607083;
        --line: #d9e2ea;
        --teal: #148f86;
        --green: #2f9b63;
        --blue: #3468a3;
        --red: #b42318;
        --amber: #9f6a13;
        --shadow: 0 18px 46px rgba(23, 32, 42, 0.12);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background:
          linear-gradient(180deg, rgba(20, 143, 134, 0.08), transparent 430px),
          var(--bg);
        color: var(--ink);
        font-family: "Segoe UI", Arial, sans-serif;
        font-size: 15px;
        line-height: 1.55;
      }
      a { color: var(--teal); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .page {
        width: min(1180px, calc(100% - 32px));
        margin: 0 auto;
      }
      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
        padding: 18px 0;
      }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 12px;
        color: var(--ink);
        font-weight: 800;
      }
      .mark {
        width: 40px;
        height: 40px;
        display: grid;
        place-items: center;
        border-radius: 8px;
        background: var(--teal);
        color: #ffffff;
        font-weight: 900;
      }
      .nav {
        display: flex;
        gap: 14px;
        flex-wrap: wrap;
        color: var(--muted);
        font-size: 14px;
        font-weight: 700;
      }
      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(340px, 460px);
        align-items: center;
        gap: 34px;
        padding: 42px 0 30px;
      }
      .eyebrow {
        margin: 0 0 12px;
        color: var(--teal);
        font-size: 12px;
        font-weight: 900;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      h1, h2, h3, p { margin: 0; }
      h1 {
        max-width: 760px;
        font-size: clamp(38px, 6vw, 68px);
        line-height: 0.98;
        letter-spacing: 0;
      }
      h2 { font-size: 22px; line-height: 1.2; }
      h3 { font-size: 15px; }
      .lead {
        max-width: 760px;
        margin-top: 20px;
        color: #3e4e60;
        font-size: 18px;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 26px;
      }
      .btn,
      button {
        min-height: 42px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0 16px;
        border-radius: 8px;
        border: 1px solid var(--line);
        background: var(--surface);
        color: var(--ink);
        font: inherit;
        font-weight: 800;
        cursor: pointer;
      }
      .btn.primary,
      button.primary {
        border-color: var(--teal);
        background: var(--teal);
        color: #ffffff;
      }
      .statusCard,
      .panel {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 8px;
        box-shadow: var(--shadow);
      }
      .statusCard { padding: 22px; }
      .statusLine {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 14px;
      }
      .dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: <?= $connected ? 'var(--green)' : 'var(--amber)' ?>;
      }
      .message,
      .error {
        margin-top: 14px;
        padding: 12px;
        border-radius: 8px;
      }
      .message {
        border: 1px solid #b8e0d0;
        background: #eefaf5;
        color: #215d43;
      }
      .error {
        border: 1px solid #f1b8b3;
        background: #fff2f0;
        color: var(--red);
      }
      .grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 18px;
        padding: 18px 0 48px;
      }
      .panel { padding: 22px; box-shadow: 0 10px 28px rgba(23, 32, 42, 0.07); }
      .panel.wide { grid-column: 1 / -1; }
      .panelHead {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 16px;
      }
      .badge {
        min-height: 24px;
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 0 10px;
        background: #e6f5f2;
        color: var(--teal);
        font-size: 11px;
        font-weight: 900;
        white-space: nowrap;
      }
      .detailTable {
        width: 100%;
        border-collapse: collapse;
      }
      .detailTable th,
      .detailTable td {
        padding: 12px 0;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
        text-align: left;
      }
      .detailTable th {
        width: 34%;
        color: var(--muted);
        font-size: 13px;
      }
      code {
        display: inline-block;
        max-width: 100%;
        padding: 2px 6px;
        border-radius: 6px;
        background: #eef4f8;
        color: #17384c;
        overflow-wrap: anywhere;
      }
      ol, ul { margin: 0; padding-left: 21px; }
      li { margin: 8px 0; color: #3e4e60; }
      .scopeGrid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 12px;
      }
      .scopeCard {
        padding: 16px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #fbfcfd;
      }
      .scopeCard strong {
        display: block;
        color: var(--teal);
      }
      .scopeCard p {
        margin-top: 8px;
        color: #3e4e60;
      }
      footer {
        width: min(1180px, calc(100% - 32px));
        margin: 0 auto;
        padding: 20px 0 34px;
        display: flex;
        justify-content: space-between;
        gap: 16px;
        color: var(--muted);
      }
      @media (max-width: 920px) {
        .hero,
        .grid,
        .scopeGrid {
          grid-template-columns: 1fr;
        }
        .topbar,
        footer {
          align-items: flex-start;
          flex-direction: column;
        }
      }
    </style>
  </head>
  <body>
    <header class="page topbar">
      <a class="brand" href="/">
        <span class="mark">CE</span>
        <span>Clipper Emsa Pro</span>
      </a>
      <nav class="nav" aria-label="Site navigation">
        <a href="/privacy-policy">Privacy Policy</a>
        <a href="/terms-of-service">Terms</a>
        <a href="/oauth-testing-instructions">Testing Instructions</a>
        <a href="/oauth-scopes-justification">Scopes</a>
      </nav>
    </header>

    <main class="page">
      <section class="hero">
        <div>
          <p class="eyebrow">YouTube Testing App</p>
          <h1>Connect YouTube and validate upload permission.</h1>
          <p class="lead">This page demonstrates the user-facing OAuth grant process for Clipper Emsa Pro. It shows the app details, OAuth client ID, redirect URI, requested scope, token validation, and the upload-only purpose.</p>
          <div class="actions">
            <?php if ($authUrl): ?>
              <a class="btn primary" href="<?= e($authUrl) ?>">Connect / Reconnect YouTube</a>
            <?php endif; ?>
            <a class="btn" href="/oauth-testing-instructions">Open Testing Instructions</a>
          </div>
        </div>

        <aside class="statusCard">
          <p class="eyebrow">Connection Status</p>
          <h2><?= $connected ? 'YouTube connected' : 'YouTube not connected' ?></h2>
          <div class="statusLine">
            <span class="dot"></span>
            <strong><?= $connected ? 'OAuth grant completed for this browser session.' : 'Click connect to start Google OAuth consent.' ?></strong>
          </div>
          <?php if ($message): ?>
            <div class="message"><?= e($message) ?></div>
          <?php endif; ?>
          <?php if ($error): ?>
            <div class="error"><?= e($error) ?></div>
          <?php endif; ?>
          <div class="actions">
            <form method="post">
              <input type="hidden" name="action" value="validate">
              <button type="submit">Validate Token</button>
            </form>
            <form method="post">
              <input type="hidden" name="action" value="refresh">
              <button type="submit">Refresh Access Token</button>
            </form>
            <form method="post">
              <input type="hidden" name="action" value="disconnect">
              <button type="submit">Disconnect</button>
            </form>
          </div>
        </aside>
      </section>

      <section class="grid">
        <article class="panel">
          <div class="panelHead">
            <h2>OAuth Client Details</h2>
            <span class="badge">Show in video</span>
          </div>
          <table class="detailTable">
            <tbody>
              <tr>
                <th>App name</th>
                <td><?= e($config['app_name']) ?></td>
              </tr>
              <tr>
                <th>Homepage</th>
                <td><code><?= e($config['homepage']) ?></code></td>
              </tr>
              <tr>
                <th>Privacy Policy</th>
                <td><code><?= e($config['privacy_url']) ?></code></td>
              </tr>
              <tr>
                <th>Terms of Service</th>
                <td><code><?= e($config['terms_url']) ?></code></td>
              </tr>
              <tr>
                <th>OAuth client type</th>
                <td>Web application</td>
              </tr>
              <tr>
                <th>OAuth client ID</th>
                <td><code><?= e($config['client_id'] ?: 'missing') ?></code></td>
              </tr>
              <tr>
                <th>Client secret</th>
                <td><code><?= e($config['client_secret'] ? 'configured, hidden' : 'missing') ?></code></td>
              </tr>
              <tr>
                <th>Redirect URI</th>
                <td><code><?= e($config['redirect_uri']) ?></code></td>
              </tr>
            </tbody>
          </table>
        </article>

        <article class="panel">
          <div class="panelHead">
            <h2>Token Status</h2>
            <span class="badge">Session only</span>
          </div>
          <table class="detailTable">
            <tbody>
              <tr>
                <th>Access token</th>
                <td><code><?= e(mask_value($token['access_token'] ?? '')) ?></code></td>
              </tr>
              <tr>
                <th>Refresh token</th>
                <td><code><?= e(!empty($token['refresh_token']) ? 'stored in session' : 'not received yet') ?></code></td>
              </tr>
              <tr>
                <th>Expires in</th>
                <td><?= e((string) ($token['expires_in'] ?? '')) ?> seconds</td>
              </tr>
              <tr>
                <th>Granted scope</th>
                <td><code><?= e($tokenInfo['scope'] ?? ($token['scope'] ?? 'not validated yet')) ?></code></td>
              </tr>
              <tr>
                <th>Audience</th>
                <td><code><?= e($tokenInfo['aud'] ?? 'not validated yet') ?></code></td>
              </tr>
            </tbody>
          </table>
        </article>

        <article class="panel wide">
          <div class="panelHead">
            <h2>OAuth Grant Process For Review</h2>
            <span class="badge">User flow</span>
          </div>
          <ol>
            <li>User opens <code>https://clipper2.emsa.pro/login-youtube.php</code>.</li>
            <li>User clicks <strong>Connect / Reconnect YouTube</strong>.</li>
            <li>Google shows the app name, OAuth client, and requested YouTube upload permission.</li>
            <li>User grants access and returns to <code><?= e($config['redirect_uri']) ?></code>.</li>
            <li>The app exchanges the authorization code for tokens, validates the granted scope, and stores the refresh token in the server-side session for this review flow.</li>
            <li>The production automation stores the long-lived refresh token as an encrypted GitHub Actions secret and uses it only to upload generated Shorts.</li>
          </ol>
        </article>

        <article class="panel wide">
          <div class="panelHead">
            <h2>Sensitive And Restricted Scope Usage</h2>
            <span class="badge">Upload only</span>
          </div>
          <div class="scopeGrid">
            <div class="scopeCard">
              <strong><code><?= e($config['scope']) ?></code></strong>
              <p>Used only to upload final generated short videos to the connected YouTube channel.</p>
            </div>
            <div class="scopeCard">
              <strong>No unrelated Google access</strong>
              <p>The app does not request Gmail, Drive, Calendar, Analytics, comment management, video deletion, or private channel-management scopes.</p>
            </div>
            <div class="scopeCard">
              <strong>Token handling</strong>
              <p>Access tokens are temporary. Refresh tokens are kept server-side and never shown in public UI. Users can revoke access from their Google Account.</p>
            </div>
          </div>
        </article>
      </section>
    </main>

    <footer>
      <span>Clipper Emsa Pro</span>
      <span>YouTube OAuth testing flow for Google app review</span>
    </footer>
  </body>
</html>
