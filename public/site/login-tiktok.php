<?php
session_start();

$defaultRedirectUri = 'https://clipper2.emsa.pro/auth/tiktok/callback.php';
$config = [
  'client_key' => getenv('TIKTOK_CLIENT_KEY') ?: '',
  'client_secret' => getenv('TIKTOK_CLIENT_SECRET') ?: '',
  'redirect_uri' => getenv('TIKTOK_REDIRECT_URI') ?: $defaultRedirectUri,
  'scopes' => getenv('TIKTOK_AUTH_SCOPES') ?: 'user.info.basic,video.upload,video.publish',
  'direct_post_audited' => getenv('TIKTOK_DIRECT_POST_AUDITED') ?: 'false',
];

foreach ([
  __DIR__ . '/config/tiktok.php',
  __DIR__ . '/config/tiktok-production.php',
  __DIR__ . '/config/tiktok-' . implode('', ['sand', 'box']) . '.php',
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
$creatorError = '';
$statusResult = null;

if (empty($_SESSION['tiktok_review_token']) && !empty($_SESSION['tiktok_demo_token'])) {
  $_SESSION['tiktok_review_token'] = $_SESSION['tiktok_demo_token'];
}
if (empty($_SESSION['tiktok_review_logged_in']) && !empty($_SESSION['tiktok_demo_logged_in'])) {
  $_SESSION['tiktok_review_logged_in'] = true;
}

function e($value) {
  return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8');
}

function mask_value($value) {
  $text = (string) $value;
  if ($text === '') return 'empty';
  if (strlen($text) <= 10) return 'configured';
  return substr($text, 0, 6) . '...' . substr($text, -4);
}

function normalize_text($value, $max = 2200) {
  $text = preg_replace("/[ \t]+\n/", "\n", (string) $value);
  $text = preg_replace("/\n{3,}/", "\n\n", $text);
  $text = trim($text);
  if (function_exists('mb_substr')) return mb_substr($text, 0, $max);
  return substr($text, 0, $max);
}

function caption_source_credit_block($video) {
  $sourceUrl = trim((string) ($video['source_url'] ?? ''));
  if ($sourceUrl === '') return '';
  $sourceTitle = trim((string) ($video['source_title'] ?? $video['title'] ?? ''));
  $lines = [];
  if ($sourceTitle !== '') $lines[] = 'Sumber video lengkap: ' . $sourceTitle;
  $lines[] = $sourceUrl;
  $lines[] = 'Terima kasih kepada pemilik podcast sumber. Clip ini dibuat sebagai highlight dari podcast tersebut. Untuk versi lengkapnya, klik dan tonton video sumber di link di atas.';
  return implode("\n", $lines);
}

function ensure_caption_source_credit($caption, $video, $max = 2200) {
  $sourceUrl = trim((string) ($video['source_url'] ?? ''));
  $caption = normalize_text($caption, $max);
  if ($sourceUrl === '') return $caption;

  $hasSource = strpos($caption, $sourceUrl) !== false;
  $hasThanks = preg_match('/terima\s+kasih/i', $caption) && preg_match('/(highlight|podcast|sumber)/i', $caption);
  if ($hasSource && $hasThanks) return normalize_text($caption, $max);

  $creditLines = [];
  if (!$hasSource) {
    $sourceTitle = trim((string) ($video['source_title'] ?? $video['title'] ?? ''));
    if ($sourceTitle !== '') $creditLines[] = 'Sumber video lengkap: ' . $sourceTitle;
    $creditLines[] = $sourceUrl;
  }
  if (!$hasThanks) {
    $creditLines[] = 'Terima kasih kepada pemilik podcast sumber. Clip ini dibuat sebagai highlight dari podcast tersebut. Untuk versi lengkapnya, klik dan tonton video sumber di link di atas.';
  }

  $credit = implode("\n", $creditLines);
  $separator = $caption !== '' ? "\n\n" : '';
  $available = $max - strlen($separator) - strlen($credit);
  if ($available < strlen($caption)) {
    $caption = substr($caption, 0, max(0, $available));
    $caption = trim(preg_replace('/\s+\S*$/', '', $caption));
  }

  return normalize_text(trim($caption . $separator . $credit), $max);
}

function privacy_label($value) {
  $map = [
    'PUBLIC_TO_EVERYONE' => 'Everyone',
    'MUTUAL_FOLLOW_FRIENDS' => 'Friends',
    'FOLLOWER_OF_CREATOR' => 'Followers',
    'SELF_ONLY' => 'Only me',
  ];
  return $map[$value] ?? $value;
}

function platform_status_label($value) {
  if (!$value) return 'Status belum tersedia';
  if (is_array($value)) {
    $state = $value['status'] ?? $value['publish_status'] ?? $value['state'] ?? '';
    return $state ? (string) $state : json_encode($value, JSON_UNESCAPED_SLASHES);
  }
  return (string) $value;
}

function bool_config($value, $fallback = false) {
  if ($value === null || $value === '') return $fallback;
  if (is_bool($value)) return $value;
  return in_array(strtolower((string) $value), ['1', 'true', 'yes', 'on'], true);
}

function is_unaudited_error($message) {
  return strpos((string) $message, 'unaudited_client_can_only_post_to_private_accounts') !== false;
}

function build_auth_url($config) {
  $params = [
    'client_key' => $config['client_key'],
    'response_type' => 'code',
    'scope' => $config['scopes'],
    'redirect_uri' => $config['redirect_uri'],
    'state' => bin2hex(random_bytes(16)),
  ];
  $_SESSION['tiktok_review_state'] = $params['state'];
  return 'https://www.tiktok.com/v2/auth/authorize/?' . http_build_query($params);
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
  if ($raw === false) throw new Exception('TikTok OAuth curl error: ' . $curlError);
  $data = json_decode($raw, true);
  if (!is_array($data)) throw new Exception('TikTok OAuth returned non JSON response.');
  if ($status < 200 || $status >= 300) {
    $detail = $data['error_description'] ?? $data['message'] ?? json_encode($data);
    throw new Exception('TikTok OAuth failed: ' . $detail);
  }
  $data['saved_at'] = time();
  return $data;
}

function curl_json($url, $token, $payload) {
  $jsonPayload = ($payload === []) ? '{}' : json_encode($payload);
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $jsonPayload,
    CURLOPT_HTTPHEADER => [
      'Authorization: Bearer ' . $token,
      'Content-Type: application/json; charset=UTF-8',
    ],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 120,
  ]);
  $raw = curl_exec($ch);
  $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  $curlError = curl_error($ch);
  curl_close($ch);
  if ($raw === false) throw new Exception('TikTok API curl error: ' . $curlError);
  $data = json_decode($raw, true);
  if (!is_array($data)) throw new Exception('TikTok API returned non JSON response.');
  $apiError = $data['error'] ?? [];
  $code = $data['error_code'] ?? ($apiError['code'] ?? '');
  if ($status < 200 || $status >= 300 || ($code && $code !== 'ok')) {
    $detail = $apiError['message'] ?? $data['error_description'] ?? $data['message'] ?? json_encode($data);
    $logId = $data['log_id'] ?? ($apiError['log_id'] ?? '');
    throw new Exception('TikTok API failed: ' . $detail . ($code ? ' [' . $code . ']' : '') . ($logId ? ' log_id=' . $logId : ''));
  }
  return $data;
}

function refresh_access_token($config, $token) {
  $refreshToken = $token['refresh_token'] ?? '';
  if (!$refreshToken) return $token;
  $next = curl_form('https://open.tiktokapis.com/v2/oauth/token/', [
    'client_key' => $config['client_key'],
    'client_secret' => $config['client_secret'],
    'grant_type' => 'refresh_token',
    'refresh_token' => $refreshToken,
  ]);
  if (empty($next['refresh_token'])) $next['refresh_token'] = $refreshToken;
  return array_merge($token, $next);
}

function ensure_access_token($config) {
  $token = $_SESSION['tiktok_review_token'] ?? null;
  if (!is_array($token) || empty($token['access_token'])) {
    throw new Exception('Akun TikTok belum terhubung.');
  }
  $savedAt = (int) ($token['saved_at'] ?? 0);
  $expiresIn = (int) ($token['expires_in'] ?? 0);
  if (!empty($token['refresh_token']) && $expiresIn > 0 && $savedAt > 0 && time() >= ($savedAt + $expiresIn - 300)) {
    $token = refresh_access_token($config, $token);
    $_SESSION['tiktok_review_token'] = $token;
  }
  return $token['access_token'];
}

function query_creator_info($config) {
  $accessToken = ensure_access_token($config);
  try {
    $data = curl_json('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', $accessToken, []);
    return $data['data'] ?? [];
  } catch (Throwable $error) {
    if (strpos($error->getMessage(), 'access_token_invalid') === false && strpos($error->getMessage(), 'expired') === false) {
      throw $error;
    }
    $token = refresh_access_token($config, $_SESSION['tiktok_review_token'] ?? []);
    $_SESSION['tiktok_review_token'] = $token;
    $data = curl_json('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', $token['access_token'], []);
    return $data['data'] ?? [];
  }
}

function tiktok_chunk_info($fileSize) {
  $defaultChunkSize = 10 * 1000 * 1000;
  $chunkSize = $fileSize <= 64 * 1000 * 1000 ? $fileSize : $defaultChunkSize;
  $totalChunkCount = $fileSize <= $chunkSize ? 1 : (int) ceil($fileSize / $chunkSize);
  return [$chunkSize, max(1, $totalChunkCount)];
}

function upload_chunks($uploadUrl, $filePath, $fileSize, $chunkSize, $totalChunkCount) {
  $handle = fopen($filePath, 'rb');
  if (!$handle) throw new Exception('Tidak bisa membaca file video.');
  try {
    for ($index = 0; $index < $totalChunkCount; $index++) {
      $start = $index * $chunkSize;
      $end = $index === $totalChunkCount - 1 ? $fileSize - 1 : min($start + $chunkSize, $fileSize) - 1;
      $length = $end - $start + 1;
      fseek($handle, $start);
      $chunk = fread($handle, $length);
      $ch = curl_init($uploadUrl);
      curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => 'PUT',
        CURLOPT_POSTFIELDS => $chunk,
        CURLOPT_HTTPHEADER => [
          'Content-Type: video/mp4',
          'Content-Length: ' . strlen($chunk),
          'Content-Range: bytes ' . $start . '-' . $end . '/' . $fileSize,
        ],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 900,
      ]);
      $raw = curl_exec($ch);
      $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
      $curlError = curl_error($ch);
      curl_close($ch);
      if ($raw === false || $status < 200 || $status >= 300) {
        throw new Exception('TikTok upload chunk failed: ' . ($curlError ?: $raw));
      }
    }
  } finally {
    fclose($handle);
  }
}

function read_jobs_file() {
  foreach ([
    __DIR__ . '/ig-generated/state/jobs.json',
    dirname(__DIR__, 2) . '/generated/state/jobs.json',
  ] as $file) {
    if (!is_file($file)) continue;
    $jobs = json_decode(file_get_contents($file), true);
    if (is_array($jobs)) return $jobs;
  }
  return [];
}

function latest_video() {
  $jobs = read_jobs_file();
  usort($jobs, function ($a, $b) {
    $left = (string) ($b['updated_at'] ?? $b['published_at'] ?? $b['created_at'] ?? '');
    $right = (string) ($a['updated_at'] ?? $a['published_at'] ?? $a['created_at'] ?? '');
    return strcmp($left, $right);
  });
  foreach ($jobs as $job) {
    if (empty($job['public_video_url'])) continue;
    $title = $job['source_title'] ?? $job['title'] ?? $job['job_id'] ?? 'Clipper Emsa Pro video';
    $caption = $job['caption'] ?? $job['description'] ?? $title;
    if (!$caption) $caption = 'Clipper Emsa Pro video';
    return [
      'job_id' => $job['job_id'] ?? '',
      'title' => $title,
      'source_title' => $job['source_title'] ?? $job['title'] ?? '',
      'source_url' => $job['source_url'] ?? $job['url'] ?? '',
      'caption' => ensure_caption_source_credit($caption, [
        'source_url' => $job['source_url'] ?? $job['url'] ?? '',
        'source_title' => $job['source_title'] ?? $job['title'] ?? '',
      ]),
      'url' => $job['public_video_url'],
      'cover_url' => $job['public_thumbnail_url'] ?? $job['thumbnail_url'] ?? '',
      'duration_seconds' => $job['duration_seconds'] ?? $job['clip_duration_seconds'] ?? $job['selected_duration_seconds'] ?? null,
    ];
  }
  return null;
}

function local_video_path($videoUrl) {
  $parts = parse_url($videoUrl);
  if (($parts['host'] ?? '') !== 'clipper2.emsa.pro') return '';
  $path = rawurldecode($parts['path'] ?? '');
  if (strpos($path, '/ig-generated/videos/') !== 0) return '';
  $candidate = realpath(__DIR__ . $path);
  $root = realpath(__DIR__ . '/ig-generated/videos');
  if (!$candidate || !$root || strpos($candidate, $root) !== 0) return '';
  return $candidate;
}

function validate_publish_input($creator, $directPostAudited, $video) {
  $options = array_values(array_filter(array_map('strval', $creator['privacy_level_options'] ?? [])));
  $title = normalize_text($_POST['title'] ?? '');
  $privacy = trim((string) ($_POST['privacy_level'] ?? ''));
  $commercial = !empty($_POST['commercial_content']);
  $brandOrganic = $commercial && !empty($_POST['brand_organic']);
  $brandContent = $commercial && !empty($_POST['brand_content']);

  if ($title === '') throw new Exception('Title atau caption wajib diisi.');
  $title = ensure_caption_source_credit($title, $video);
  if ($privacy === '') throw new Exception('Privacy status wajib dipilih manual.');
  if (!in_array($privacy, $options, true)) throw new Exception('Privacy status tidak sesuai pilihan TikTok terbaru.');
  if (!$directPostAudited && $privacy !== 'SELF_ONLY') {
    throw new Exception('App TikTok belum lolos audit Direct Post. Untuk testing sebelum audit approved, pilih privacy Only me dan pastikan akun TikTok dalam mode private.');
  }
  if ($commercial && !$brandOrganic && !$brandContent) {
    throw new Exception('Commercial content aktif, pilih Your brand, Branded content, atau keduanya.');
  }
  if ($brandContent && $privacy === 'SELF_ONLY') {
    throw new Exception('Branded content tidak bisa memakai privacy Only me.');
  }
  if (empty($_POST['consent'])) {
    throw new Exception('Consent TikTok wajib dicentang sebelum publish.');
  }

  return [
    'title' => $title,
    'privacy_level' => $privacy,
    'allow_comment' => !empty($_POST['allow_comment']) && empty($creator['comment_disabled']),
    'allow_duet' => !empty($_POST['allow_duet']) && empty($creator['duet_disabled']),
    'allow_stitch' => !empty($_POST['allow_stitch']) && empty($creator['stitch_disabled']),
    'brand_organic' => $brandOrganic,
    'brand_content' => $brandContent,
  ];
}

function direct_post_payload($video, $input, $sourceInfo) {
  return [
    'post_info' => [
      'title' => $input['title'],
      'privacy_level' => $input['privacy_level'],
      'disable_duet' => !$input['allow_duet'],
      'disable_comment' => !$input['allow_comment'],
      'disable_stitch' => !$input['allow_stitch'],
      'brand_content_toggle' => $input['brand_content'],
      'brand_organic_toggle' => $input['brand_organic'],
      'is_aigc' => false,
      'video_cover_timestamp_ms' => 1000,
    ],
    'source_info' => $sourceInfo,
  ];
}

function publish_direct_to_tiktok($config, $video, $input) {
  $accessToken = ensure_access_token($config);
  try {
    $init = curl_json('https://open.tiktokapis.com/v2/post/publish/video/init/', $accessToken, direct_post_payload($video, $input, [
      'source' => 'PULL_FROM_URL',
      'video_url' => $video['url'],
    ]));
    return [
      'publish_id' => $init['data']['publish_id'] ?? '',
      'source' => 'PULL_FROM_URL',
      'mode' => 'direct',
    ];
  } catch (Throwable $error) {
    if (is_unaudited_error($error->getMessage())) {
      throw new Exception('App TikTok belum lolos audit Direct Post. TikTok hanya mengizinkan posting SELF_ONLY dari akun private sampai audit disetujui. Ubah akun TikTok ke private, pilih privacy Only me, lalu coba lagi.');
    }
    if (strpos($error->getMessage(), 'url_ownership_unverified') === false) throw $error;
    $videoPath = local_video_path($video['url']);
    if (!$videoPath || !is_file($videoPath)) throw $error;
    $fileSize = filesize($videoPath);
    [$chunkSize, $totalChunkCount] = tiktok_chunk_info($fileSize);
    $init = curl_json('https://open.tiktokapis.com/v2/post/publish/video/init/', $accessToken, direct_post_payload($video, $input, [
      'source' => 'FILE_UPLOAD',
      'video_size' => $fileSize,
      'chunk_size' => $chunkSize,
      'total_chunk_count' => $totalChunkCount,
    ]));
    $uploadUrl = $init['data']['upload_url'] ?? '';
    if (!$uploadUrl) throw new Exception('TikTok tidak mengembalikan upload_url.');
    upload_chunks($uploadUrl, $videoPath, $fileSize, $chunkSize, $totalChunkCount);
    return [
      'publish_id' => $init['data']['publish_id'] ?? '',
      'source' => 'FILE_UPLOAD',
      'mode' => 'direct',
    ];
  }
}

function fetch_publish_status($config, $publishId) {
  if (!$publishId) return null;
  try {
    $accessToken = ensure_access_token($config);
    $status = curl_json('https://open.tiktokapis.com/v2/post/publish/status/fetch/', $accessToken, [
      'publish_id' => $publishId,
    ]);
    return $status['data'] ?? null;
  } catch (Throwable $error) {
    return ['status_error' => $error->getMessage()];
  }
}

try {
  if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'login') {
    $_SESSION['tiktok_review_logged_in'] = true;
    header('Location: /login-tiktok.php');
    exit;
  }

  if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'logout') {
    unset($_SESSION['tiktok_review_logged_in'], $_SESSION['tiktok_review_token'], $_SESSION['tiktok_review_publish']);
    unset($_SESSION['tiktok_demo_logged_in'], $_SESSION['tiktok_demo_token'], $_SESSION['tiktok_demo_publish']);
    header('Location: /login-tiktok.php');
    exit;
  }

  if (!empty($_GET['tiktok_code'])) {
    if (!$config['client_key'] || !$config['client_secret']) {
      throw new Exception('TikTok client key/secret belum dikonfigurasi di server.');
    }
    $expectedState = $_SESSION['tiktok_review_state'] ?? '';
    $actualState = trim((string) ($_GET['tiktok_state'] ?? ''));
    if ($expectedState && $actualState && !hash_equals($expectedState, $actualState)) {
      throw new Exception('State TikTok tidak valid. Ulangi Connect TikTok.');
    }
    $token = curl_form('https://open.tiktokapis.com/v2/oauth/token/', [
      'client_key' => $config['client_key'],
      'client_secret' => $config['client_secret'],
      'code' => trim($_GET['tiktok_code']),
      'grant_type' => 'authorization_code',
      'redirect_uri' => $config['redirect_uri'],
    ]);
    $_SESSION['tiktok_review_logged_in'] = true;
    $_SESSION['tiktok_review_token'] = $token;
    header('Location: /login-tiktok.php?connected=1');
    exit;
  }

  if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'publish') {
    $videoForPost = latest_video();
    if (!$videoForPost) throw new Exception('Belum ada video hasil workflow.');
    $creatorForPost = query_creator_info($config);
    $input = validate_publish_input($creatorForPost, bool_config($config['direct_post_audited'] ?? false, false), $videoForPost);
    if (!empty($creatorForPost['max_video_post_duration_sec']) && !empty($videoForPost['duration_seconds'])) {
      if ((float) $videoForPost['duration_seconds'] > (float) $creatorForPost['max_video_post_duration_sec']) {
        throw new Exception('Durasi video melebihi batas TikTok untuk akun ini.');
      }
    }
    $result = publish_direct_to_tiktok($config, $videoForPost, $input);
    $statusResult = fetch_publish_status($config, $result['publish_id'] ?? '');
    $_SESSION['tiktok_review_publish'] = [
      'ok' => true,
      'at' => date(DATE_ATOM),
      'job_id' => $videoForPost['job_id'],
      'title' => $input['title'],
      'privacy_level' => $input['privacy_level'],
      'publish_id' => $result['publish_id'] ?: 'submitted',
      'source' => $result['source'],
      'mode' => $result['mode'],
      'status' => $statusResult,
    ];
    header('Location: /login-tiktok.php?published=1');
    exit;
  }
} catch (Throwable $caught) {
  $error = $caught->getMessage();
}

$loggedIn = !empty($_SESSION['tiktok_review_logged_in']);
$token = $_SESSION['tiktok_review_token'] ?? null;
$connected = is_array($token) && !empty($token['access_token']);
$publish = $_SESSION['tiktok_review_publish'] ?? null;
$video = latest_video();
$authUrl = ($config['client_key'] && $config['redirect_uri']) ? build_auth_url($config) : '';
$creator = null;
$directPostAudited = bool_config($config['direct_post_audited'] ?? false, false);

if ($connected) {
  try {
    $creator = query_creator_info($config);
  } catch (Throwable $caught) {
    $creatorError = $caught->getMessage();
  }
}

if (isset($_GET['connected'])) $message = 'Akun TikTok berhasil terhubung.';
if (isset($_GET['published'])) $message = 'Video sudah dikirim ke TikTok. Proses tampil di profile bisa butuh beberapa menit.';

$privacyOptions = array_values(array_filter(array_map('strval', $creator['privacy_level_options'] ?? [])));
$maxDuration = $creator['max_video_post_duration_sec'] ?? null;
$creatorReady = $connected && is_array($creator) && !empty($privacyOptions);
$durationOk = !$maxDuration || !$video || empty($video['duration_seconds']) || (float) $video['duration_seconds'] <= (float) $maxDuration;
$canOpenForm = $loggedIn && $connected && $creatorReady && $video && $durationOk;
$captionDefault = $video ? $video['caption'] : '';
?>
<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#090909">
  <title>Clipper Emsa Pro - TikTok Direct Post</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #090909;
      --panel: rgba(18, 18, 20, 0.86);
      --panel-strong: rgba(8, 8, 10, 0.9);
      --line: rgba(255, 255, 255, 0.14);
      --line-strong: rgba(255, 255, 255, 0.26);
      --text: #fbfbfb;
      --muted: #b7b7c0;
      --cyan: #25f4ee;
      --pink: #fe2c55;
      --lime: #d8fb54;
      --warn: #ffd166;
      --bad: #ff8b8b;
      --ink: #050505;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      color: var(--text);
      font-family: "Segoe UI", Arial, sans-serif;
      background:
        linear-gradient(135deg, rgba(254, 44, 85, 0.2), transparent 26%),
        linear-gradient(315deg, rgba(37, 244, 238, 0.18), transparent 28%),
        #090909;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image: linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px);
      background-size: 48px 48px;
      mask-image: linear-gradient(to bottom, rgba(0,0,0,.75), transparent 80%);
    }
    a { color: inherit; }
    .siteHeader, main, footer {
      width: min(1180px, calc(100% - 32px));
      margin-inline: auto;
      position: relative;
    }
    .siteHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 0;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-weight: 900;
      text-decoration: none;
    }
    .brandMark {
      display: grid;
      place-items: center;
      width: 38px;
      height: 38px;
      border-radius: 8px;
      color: var(--ink);
      background: linear-gradient(135deg, var(--cyan), #fff 48%, var(--pink));
      font-weight: 1000;
    }
    nav, footer {
      display: flex;
      align-items: center;
      gap: 14px;
      flex-wrap: wrap;
    }
    nav a, footer a {
      color: var(--muted);
      font-size: 14px;
      text-decoration: none;
    }
    main { padding: 18px 0 54px; }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 0.92fr) minmax(340px, 1.08fr);
      gap: 18px;
      align-items: stretch;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.34);
      backdrop-filter: blur(18px);
    }
    .intro { padding: 24px; }
    .eyebrow {
      margin: 0 0 9px;
      color: var(--cyan);
      font-size: 12px;
      font-weight: 900;
      letter-spacing: .14em;
      text-transform: uppercase;
    }
    h1, h2, h3, p { margin-top: 0; }
    h1 {
      margin-bottom: 14px;
      font-size: clamp(38px, 7vw, 72px);
      line-height: .95;
      letter-spacing: 0;
    }
    h2 { margin-bottom: 6px; font-size: 20px; letter-spacing: 0; }
    h3 { margin-bottom: 8px; font-size: 15px; letter-spacing: 0; }
    p, li { line-height: 1.55; }
    .lead {
      max-width: 640px;
      color: #e7e7ed;
      font-size: 17px;
    }
    .statusRow, .actions, .creator, .optionRow, .publishLine {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .status {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: 5px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      background: rgba(0,0,0,.32);
      font-size: 12px;
      font-weight: 900;
    }
    .status.ok { color: #0e3b2b; background: #a7f3d0; border-color: #a7f3d0; }
    .status.warn { color: #3f2f02; background: var(--warn); border-color: var(--warn); }
    .status.bad { color: #4a1010; background: var(--bad); border-color: var(--bad); }
    .btn {
      appearance: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 44px;
      border: 1px solid var(--line-strong);
      border-radius: 8px;
      padding: 0 16px;
      color: var(--text);
      background: rgba(255,255,255,.05);
      font-weight: 900;
      text-decoration: none;
      cursor: pointer;
    }
    .btn.primary {
      color: var(--ink);
      border-color: transparent;
      background: linear-gradient(135deg, var(--cyan), #fff 50%, var(--pink));
    }
    .btn:disabled { opacity: .52; cursor: not-allowed; }
    .notice {
      margin-bottom: 14px;
      border-radius: 8px;
      padding: 12px 14px;
      font-weight: 800;
    }
    .notice.ok { color: #07331f; background: #a7f3d0; }
    .notice.err { color: #4a1010; background: #ffb4b4; }
    .preview {
      display: grid;
      grid-template-rows: auto 1fr;
      min-height: 520px;
      overflow: hidden;
      background: #000;
    }
    .previewTop {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      background: rgba(255,255,255,.04);
    }
    .videoShell {
      display: grid;
      place-items: center;
      min-height: 460px;
      padding: 18px;
      background: radial-gradient(circle at 50% 20%, rgba(255,255,255,.12), transparent 35%), #050505;
    }
    video {
      width: min(100%, 300px);
      max-height: 72vh;
      aspect-ratio: 9 / 16;
      border-radius: 8px;
      object-fit: cover;
      background: #000;
      box-shadow: 0 24px 80px rgba(0,0,0,.62);
    }
    .emptyPreview {
      display: grid;
      place-items: center;
      width: min(100%, 300px);
      aspect-ratio: 9 / 16;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--muted);
      text-align: center;
      padding: 22px;
      background: linear-gradient(160deg, rgba(37,244,238,.16), rgba(254,44,85,.16));
    }
    .flow {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 12px;
      margin-top: 18px;
    }
    .step {
      min-height: 124px;
      padding: 14px;
      border-radius: 8px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,.055);
    }
    .step span {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      margin-bottom: 11px;
      border-radius: 999px;
      background: var(--text);
      color: var(--ink);
      font-weight: 1000;
    }
    .step small {
      display: block;
      margin-top: 5px;
      color: var(--muted);
      line-height: 1.35;
    }
    .reviewGrid {
      display: grid;
      grid-template-columns: minmax(0, .84fr) minmax(360px, 1.16fr);
      gap: 18px;
      margin-top: 18px;
    }
    .stack { display: grid; gap: 14px; }
    .card { padding: 18px; }
    .muted { color: var(--muted); }
    .creator img {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      object-fit: cover;
      background: var(--line);
    }
    .creatorName strong, .creatorName small { display: block; }
    .creatorName small { color: var(--muted); margin-top: 2px; }
    label { display: block; color: #f4f4f6; font-weight: 850; }
    .field { display: grid; gap: 8px; margin-top: 14px; }
    .field small { color: var(--muted); line-height: 1.4; }
    textarea, select, input[type="text"] {
      width: 100%;
      border: 1px solid var(--line-strong);
      border-radius: 8px;
      color: var(--text);
      background: rgba(0,0,0,.38);
      font: inherit;
      line-height: 1.45;
      padding: 12px;
      outline: none;
    }
    textarea { min-height: 174px; resize: vertical; }
    select { min-height: 44px; }
    input[type="checkbox"] {
      width: 18px;
      height: 18px;
      accent-color: var(--cyan);
    }
    .check, .toggleLine {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255,255,255,.04);
    }
    .check.disabled {
      color: var(--muted);
      opacity: .62;
    }
    .check span, .toggleLine span { display: grid; gap: 2px; }
    .check small, .toggleLine small { color: var(--muted); }
    .commercialBox {
      display: none;
      gap: 10px;
      margin-top: 10px;
    }
    .commercialBox.active { display: grid; }
    .policyText {
      border-left: 3px solid var(--cyan);
      padding: 10px 12px;
      background: rgba(37,244,238,.08);
      color: #e9ffff;
      border-radius: 0 8px 8px 0;
    }
    .publishPanel {
      position: sticky;
      top: 12px;
    }
    .statusBox {
      margin-top: 12px;
      border-radius: 8px;
      border: 1px solid var(--line);
      background: rgba(0,0,0,.32);
      padding: 12px;
      overflow-wrap: anywhere;
    }
    code, pre { font-family: Consolas, monospace; }
    pre {
      margin: 0;
      white-space: pre-wrap;
      color: #e7e7ed;
      font-size: 12px;
    }
    footer {
      border-top: 1px solid var(--line);
      padding: 18px 0 28px;
      color: var(--muted);
    }
    @media (max-width: 980px) {
      .hero, .reviewGrid, .flow { grid-template-columns: 1fr; }
      .preview { min-height: auto; }
      .publishPanel { position: static; }
    }
    @media (max-width: 720px) {
      .siteHeader, nav, footer { align-items: flex-start; flex-direction: column; }
      .intro, .card { padding: 16px; }
      .videoShell { min-height: 360px; }
    }
  </style>
</head>
<body>
  <header class="siteHeader">
    <a class="brand" href="/"><span class="brandMark">CE</span><span>Clipper Emsa Pro</span></a>
    <nav>
      <a href="/privacy-policy">Privacy Policy</a>
      <a href="/terms-of-service">Terms</a>
      <a class="loginLink" href="/login-tiktok.php">TikTok Direct Post</a>
    </nav>
  </header>

  <main>
    <?php if ($message): ?><div class="notice ok"><?= e($message) ?></div><?php endif; ?>
    <?php if ($error): ?><div class="notice err"><?= e($error) ?></div><?php endif; ?>
    <?php if ($creatorError): ?><div class="notice err"><?= e($creatorError) ?></div><?php endif; ?>

    <section class="hero">
      <div class="panel intro">
        <p class="eyebrow">TikTok Direct Post</p>
        <h1>Clipper Emsa Pro</h1>
        <p class="lead">Dashboard publish untuk review TikTok: akun creator terbaru, title yang bisa diedit, privacy manual, interaction control, commercial disclosure, preview, consent, dan status publish dalam satu halaman.</p>
        <div class="statusRow">
          <span class="status <?= $loggedIn ? 'ok' : 'warn' ?>"><?= $loggedIn ? 'Logged in' : 'Login required' ?></span>
          <span class="status <?= $connected ? 'ok' : 'warn' ?>"><?= $connected ? 'TikTok connected' : 'TikTok not connected' ?></span>
          <span class="status <?= $creatorReady ? 'ok' : 'warn' ?>"><?= $creatorReady ? 'Creator info ready' : 'Creator info needed' ?></span>
          <span class="status <?= $video ? 'ok' : 'warn' ?>"><?= $video ? 'Video ready' : 'No video yet' ?></span>
        </div>
        <div class="actions" style="margin-top:18px">
          <?php if (!$loggedIn): ?>
            <form method="post"><input type="hidden" name="action" value="login"><button class="btn primary" type="submit">Login</button></form>
          <?php elseif (!$connected && $authUrl): ?>
            <a class="btn primary" href="<?= e($authUrl) ?>">Connect TikTok</a>
          <?php elseif ($connected): ?>
            <form method="post"><input type="hidden" name="action" value="logout"><button class="btn" type="submit">Disconnect</button></form>
          <?php else: ?>
            <button class="btn primary" type="button" disabled>Client key belum siap</button>
          <?php endif; ?>
        </div>
      </div>

      <section class="panel preview" aria-label="Video preview">
        <div class="previewTop">
          <strong>Preview</strong>
          <?php if ($video): ?><span class="status ok"><?= e($video['job_id'] ?: 'latest video') ?></span><?php endif; ?>
        </div>
        <div class="videoShell">
          <?php if ($video): ?>
            <video controls playsinline preload="metadata" poster="<?= e($video['cover_url'] ?? '') ?>">
              <source src="<?= e($video['url']) ?>" type="video/mp4">
            </video>
          <?php else: ?>
            <div class="emptyPreview">Video hasil workflow akan muncul di sini.</div>
          <?php endif; ?>
        </div>
      </section>
    </section>

    <section class="flow" aria-label="TikTok required UX order">
      <div class="step"><span>1</span><strong>Creator account</strong><small>Nickname dan permission TikTok terbaru.</small></div>
      <div class="step"><span>2</span><strong>Post details</strong><small>Title, privacy, comment, duet, stitch.</small></div>
      <div class="step"><span>3</span><strong>Commercial content</strong><small>Your brand dan branded content.</small></div>
      <div class="step"><span>4</span><strong>Consent</strong><small>Policy confirmation sebelum publish.</small></div>
      <div class="step"><span>5</span><strong>Preview & status</strong><small>Konten terlihat dan status dipantau.</small></div>
    </section>

    <section class="reviewGrid">
      <div class="stack">
        <section class="panel card">
          <h2>1. Creator Account</h2>
          <?php if ($creatorReady): ?>
            <div class="creator">
              <?php if (!empty($creator['creator_avatar_url'])): ?>
                <img src="<?= e($creator['creator_avatar_url']) ?>" alt="">
              <?php endif; ?>
              <span class="creatorName">
                <strong><?= e($creator['creator_nickname'] ?? 'TikTok creator') ?></strong>
                <small><?= e($creator['creator_username'] ? '@' . $creator['creator_username'] : 'Connected account') ?></small>
              </span>
            </div>
            <p class="muted" style="margin:12px 0 0">Max video duration: <?= e($maxDuration ?: 'not limited by response') ?> seconds.</p>
            <?php if (!$durationOk): ?>
              <p class="status bad">Durasi video melebihi batas akun TikTok ini.</p>
            <?php endif; ?>
          <?php elseif ($connected): ?>
            <p class="muted">Creator info belum bisa dibaca. Coba connect ulang atau pastikan scope <code>video.publish</code> aktif.</p>
          <?php else: ?>
            <p class="muted">Login lalu connect TikTok untuk menampilkan akun creator.</p>
          <?php endif; ?>
        </section>

        <section class="panel card">
          <h2>App Settings</h2>
          <p class="muted">Credential dibaca server-side dan tidak ditampilkan ke browser.</p>
          <p><strong>Client Key:</strong> <code><?= e(mask_value($config['client_key'])) ?></code></p>
          <p><strong>Redirect URI:</strong><br><code><?= e($config['redirect_uri']) ?></code></p>
          <p><strong>Scopes:</strong><br><code><?= e($config['scopes']) ?></code></p>
        </section>
      </div>

      <form class="panel card publishPanel" method="post" data-publish-form data-ready="<?= $canOpenForm ? '1' : '0' ?>" data-audited="<?= $directPostAudited ? '1' : '0' ?>">
        <input type="hidden" name="action" value="publish">
        <h2>2. Post Details</h2>
        <div class="field">
          <label for="title">Title / caption</label>
          <textarea id="title" name="title" maxlength="2200" <?= $canOpenForm ? '' : 'disabled' ?>><?= e($captionDefault) ?></textarea>
          <small>Preset text tetap bisa diedit sebelum konten dikirim ke TikTok.</small>
        </div>

        <div class="field">
          <label for="privacy_level">Privacy status</label>
          <select id="privacy_level" name="privacy_level" <?= $canOpenForm ? '' : 'disabled' ?> data-privacy>
            <option value="">Pilih privacy status</option>
            <?php foreach ($privacyOptions as $option): ?>
              <option value="<?= e($option) ?>" <?= (!$directPostAudited && $option !== 'SELF_ONLY') ? 'disabled' : '' ?>><?= e(privacy_label($option)) ?></option>
            <?php endforeach; ?>
          </select>
          <small><?= $directPostAudited ? 'Privacy harus dipilih manual dari pilihan yang dikembalikan TikTok.' : 'Sebelum audit Direct Post disetujui, TikTok hanya menerima Only me dari akun private.' ?></small>
        </div>

        <div class="field">
          <label>Interaction ability</label>
          <label class="check <?= !empty($creator['comment_disabled']) ? 'disabled' : '' ?>">
            <input type="checkbox" name="allow_comment" value="1" <?= (!$canOpenForm || !empty($creator['comment_disabled'])) ? 'disabled' : '' ?>>
            <span><strong>Allow Comment</strong><small><?= !empty($creator['comment_disabled']) ? 'Disabled by creator privacy settings.' : 'Off by default.' ?></small></span>
          </label>
          <label class="check <?= !empty($creator['duet_disabled']) ? 'disabled' : '' ?>">
            <input type="checkbox" name="allow_duet" value="1" <?= (!$canOpenForm || !empty($creator['duet_disabled'])) ? 'disabled' : '' ?>>
            <span><strong>Allow Duet</strong><small><?= !empty($creator['duet_disabled']) ? 'Disabled by creator privacy settings.' : 'Off by default.' ?></small></span>
          </label>
          <label class="check <?= !empty($creator['stitch_disabled']) ? 'disabled' : '' ?>">
            <input type="checkbox" name="allow_stitch" value="1" <?= (!$canOpenForm || !empty($creator['stitch_disabled'])) ? 'disabled' : '' ?>>
            <span><strong>Allow Stitch</strong><small><?= !empty($creator['stitch_disabled']) ? 'Disabled by creator privacy settings.' : 'Off by default.' ?></small></span>
          </label>
        </div>

        <div class="field">
          <h2>3. Commercial Content</h2>
          <label class="toggleLine">
            <input type="checkbox" name="commercial_content" value="1" <?= $canOpenForm ? '' : 'disabled' ?> data-commercial>
            <span><strong>Content disclosure setting</strong><small>Off by default.</small></span>
          </label>
          <div class="commercialBox" data-commercial-box>
            <label class="check">
              <input type="checkbox" name="brand_organic" value="1" <?= $canOpenForm ? '' : 'disabled' ?> data-brand-organic>
              <span><strong>Your brand</strong><small>Your photo/video will be labeled as 'Promotional content'.</small></span>
            </label>
            <label class="check" data-brand-content-row>
              <input type="checkbox" name="brand_content" value="1" <?= $canOpenForm ? '' : 'disabled' ?> data-brand-content>
              <span><strong>Branded content</strong><small>Your photo/video will be labeled as 'Paid partnership'.</small></span>
            </label>
            <small class="muted" data-commercial-help>You need to indicate if your content promotes yourself, a third party, or both.</small>
          </div>
        </div>

        <div class="field">
          <h2>4. Consent</h2>
          <div class="policyText" data-policy-text>By posting, you agree to TikTok's <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer">Music Usage Confirmation</a>.</div>
          <label class="check">
            <input type="checkbox" name="consent" value="1" <?= $canOpenForm ? '' : 'disabled' ?> data-consent>
            <span><strong>I agree</strong><small>Content will only be sent after this confirmation.</small></span>
          </label>
        </div>

        <div class="field">
          <h2>5. Preview & Status</h2>
          <div class="publishLine">
            <button class="btn primary" type="submit" <?= $canOpenForm ? '' : 'disabled' ?> data-submit>Post to TikTok</button>
            <span class="status <?= is_array($publish) ? 'ok' : 'warn' ?>"><?= is_array($publish) ? 'Submitted' : 'Waiting' ?></span>
          </div>
          <small class="muted">Setelah publish, TikTok bisa butuh beberapa menit sebelum video terlihat di profile.</small>
          <?php if (is_array($publish)): ?>
            <div class="statusBox">
              <strong>Publish ID:</strong> <code><?= e($publish['publish_id'] ?? '') ?></code><br>
              <strong>Mode:</strong> <code><?= e($publish['mode'] ?? '') ?></code><br>
              <strong>Status:</strong> <code><?= e(platform_status_label($publish['status'] ?? null)) ?></code>
            </div>
          <?php endif; ?>
        </div>
      </form>
    </section>
  </main>

  <footer>
    <span>Clipper Emsa Pro</span>
    <a href="/privacy-policy">Privacy Policy</a>
    <a href="/terms-of-service">Terms of Service</a>
  </footer>

  <script>
    const form = document.querySelector("[data-publish-form]");
    if (form) {
      const privacy = form.querySelector("[data-privacy]");
      const title = form.querySelector("#title");
      const consent = form.querySelector("[data-consent]");
      const submit = form.querySelector("[data-submit]");
      const commercial = form.querySelector("[data-commercial]");
      const commercialBox = form.querySelector("[data-commercial-box]");
      const organic = form.querySelector("[data-brand-organic]");
      const branded = form.querySelector("[data-brand-content]");
      const brandedRow = form.querySelector("[data-brand-content-row]");
      const policyText = form.querySelector("[data-policy-text]");
      const formReady = form.dataset.ready === "1";
      const directPostAudited = form.dataset.audited === "1";
      const brandedPolicy = "<a href=\"https://www.tiktok.com/legal/page/global/bc-policy/en\" target=\"_blank\" rel=\"noreferrer\">Branded Content Policy</a>";
      const musicPolicy = "<a href=\"https://www.tiktok.com/legal/page/global/music-usage-confirmation/en\" target=\"_blank\" rel=\"noreferrer\">Music Usage Confirmation</a>";

      function enabled(input) {
        return input && !input.disabled;
      }

      function update() {
        const commercialOn = enabled(commercial) && commercial.checked;
        commercialBox.classList.toggle("active", commercialOn);
        const privateOnly = privacy && privacy.value === "SELF_ONLY";
        if (branded && brandedRow) {
          branded.disabled = !commercialOn || privateOnly;
          brandedRow.classList.toggle("disabled", branded.disabled);
          if (branded.disabled) branded.checked = false;
        }
        if (organic) organic.disabled = !commercialOn;
        const needsCommercialChoice = commercialOn && !(organic?.checked || branded?.checked);
        const usesBrandedPolicy = commercialOn && branded?.checked;
        if (policyText) {
          policyText.innerHTML = usesBrandedPolicy
            ? "By posting, you agree to TikTok's " + brandedPolicy + " and " + musicPolicy + "."
            : "By posting, you agree to TikTok's " + musicPolicy + ".";
        }
        const ok = formReady
          && title
          && title.value.trim().length > 0
          && privacy
          && privacy.value
          && (directPostAudited || privacy.value === "SELF_ONLY")
          && consent
          && consent.checked
          && !needsCommercialChoice;
        if (submit) submit.disabled = !ok;
      }

      ["input", "change"].forEach((eventName) => {
        form.addEventListener(eventName, update);
      });
      update();
    }
  </script>
</body>
</html>
