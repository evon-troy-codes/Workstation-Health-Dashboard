<?php
header('Content-Type: application/json');

// Only accept POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

// Parse JSON body
$data = json_decode(file_get_contents('php://input'), true);
if (!$data) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid request body']);
    exit;
}

require 'vendor/autoload.php';

use PHPMailer\PHPMailer\PHPMailer;
use PHPMailer\PHPMailer\SMTP;
use PHPMailer\PHPMailer\Exception;

// ── Helpers ──────────────────────────────────────────────────
function h($s) { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }

// ── Build HTML email body ─────────────────────────────────────
function buildHtml(array $data): string {
    $firstName = h($data['first_name'] ?? '');
    $lastName  = h($data['last_name']  ?? '');
    $userEmail = h($data['user_email'] ?? '');
    $checkDate = h($data['check_date'] ?? '');
    $score     = h($data['score']      ?? '—');
    $results   = $data['results']      ?? [];

    $rows = '';
    foreach ($results as $r) {
        $eligible = !empty($r['eligible']);
        $rowClass = $eligible ? 'eligible-row' : 'ineligible-row';
        $pillClass = $eligible ? 'pill-pass' : 'pill-fail';
        $pillText  = $eligible ? 'ELIGIBLE' : 'NOT ELIGIBLE';
        $rows .= "
        <tr class='{$rowClass}'>
            <td class='label-cell'>" . h($r['label']) . "</td>
            <td>" . h($r['value']) . "</td>
            <td><span class='pill {$pillClass}'>{$pillText}</span></td>
            <td class='note-cell'>" . h($r['note']) . "</td>
        </tr>";
    }

    return "<!DOCTYPE html>
<html lang='en'>
<head>
<meta charset='UTF-8'>
<style>
  body      { margin:0; padding:0; background:#f0f4f8; font-family:'Segoe UI',Arial,sans-serif; }
  .wrap     { max-width:640px; margin:30px auto; background:#ffffff; border-radius:10px; overflow:hidden; box-shadow:0 4px 20px rgba(0,0,0,.12); }
  .hdr      { background:#0f2035; padding:28px 32px; text-align:center; }
  .hdr h1   { margin:0; color:#ffffff; font-size:1.3rem; letter-spacing:.02em; }
  .hdr p    { margin:6px 0 0; color:#7a9abf; font-size:.85rem; }
  .body     { padding:28px 32px; }
  .meta     { font-size:.9rem; color:#555; margin-bottom:20px; line-height:1.8; }
  .meta b   { color:#222; }
  .score    { background:linear-gradient(135deg,#0d2d55,#091828); border-radius:8px; padding:20px; text-align:center; margin-bottom:22px; }
  .score-n  { font-size:2.4rem; font-weight:700; color:#fff; line-height:1; }
  .score-l  { font-size:.82rem; color:#7a9abf; margin-top:4px; }
  table     { width:100%; border-collapse:collapse; font-size:.88rem; }
  th        { background:#e8edf5; padding:9px 13px; text-align:left; color:#555; font-size:.78rem; text-transform:uppercase; letter-spacing:.04em; }
  td        { padding:10px 13px; border-bottom:1px solid #eee; vertical-align:top; }
  .eligible-row   { background:#f1faf2; }
  .ineligible-row { background:#fff5f5; }
  .label-cell { font-weight:600; color:#222; white-space:nowrap; }
  .note-cell  { font-size:.8rem; color:#888; }
  .pill       { display:inline-block; padding:2px 9px; border-radius:20px; font-size:.72rem; font-weight:700; white-space:nowrap; }
  .pill-pass  { background:#c8e6c9; color:#2e7d32; }
  .pill-fail  { background:#ffcdd2; color:#c62828; }
  .ftr        { background:#f9f9f9; padding:14px 32px; font-size:.78rem; color:#aaa; text-align:center; border-top:1px solid #eee; }
</style>
</head>
<body>
<div class='wrap'>
  <div class='hdr'>
    <h1>ASC System Check Report</h1>
    <p>Generated {$checkDate}</p>
  </div>
  <div class='body'>
    <div class='meta'>
      <b>Name:</b> {$firstName} {$lastName}<br>
      <b>Email:</b> {$userEmail}<br>
      <b>Date:</b> {$checkDate}
    </div>
    <div class='score'>
      <div class='score-n'>{$score}</div>
      <div class='score-l'>requirements met</div>
    </div>
    <table>
      <thead>
        <tr>
          <th>Check</th>
          <th>Result</th>
          <th>Status</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>{$rows}</tbody>
    </table>
  </div>
  <div style='padding:14px 32px; font-size:.82rem; color:#555; background:#fff8e1; border-top:1px solid #ffe082; text-align:center;'>
    <b>Note:</b> These results are preliminary and subject to validation.
  </div>
  <div class='ftr'>ASC System Checker &bull; Confidential HR Report</div>
</div>
</body>
</html>";
}

// ── Plain-text fallback ───────────────────────────────────────
function buildText(array $data): string {
    $lines   = [];
    $lines[] = 'ASC SYSTEM CHECK REPORT';
    $lines[] = str_repeat('-', 40);
    $lines[] = 'Name:  ' . ($data['first_name'] ?? '') . ' ' . ($data['last_name'] ?? '');
    $lines[] = 'Email: ' . ($data['user_email'] ?? '');
    $lines[] = 'Date:  ' . ($data['check_date'] ?? '');
    $lines[] = 'Score: ' . ($data['score'] ?? '—');
    $lines[] = '';
    foreach ($data['results'] ?? [] as $r) {
        $status  = !empty($r['eligible']) ? '[PASS]' : '[FAIL]';
        $lines[] = $status . '  ' . $r['label'] . ': ' . $r['value'];
        $lines[] = '       ' . $r['note'];
    }
    $lines[] = '';
    $lines[] = 'NOTE: These results are preliminary and subject to validation.';
    return implode("\n", $lines);
}

// ── Send ──────────────────────────────────────────────────────
$mail = new PHPMailer(true);

try {
    $mail->isSMTP();
    $mail->Host       = 'smtp.gmail.com';
    $mail->SMTPAuth   = true;
    $mail->Username   = 'techspecs@kauneonga.com';
    $mail->Password   = 'bqloclmlcyvjqmoy';
    $mail->SMTPSecure = PHPMailer::ENCRYPTION_STARTTLS;
    $mail->Port       = 587;

    $mail->setFrom('techspecs@kauneonga.com', 'ASC System Checker');
    $mail->addAddress('support@answeringservicecare.com');
    $mail->addAddress('techspecs.3hksby@zapiermail.com');

    if (!empty($data['user_email'])) {
        $replyName = trim(($data['first_name'] ?? '') . ' ' . ($data['last_name'] ?? ''));
        $mail->addReplyTo($data['user_email'], $replyName);
    }

    $fullName = trim(($data['first_name'] ?? '') . ' ' . ($data['last_name'] ?? ''));
    $mail->Subject = 'Test: Computer Information Report ' . $fullName;
    $mail->isHTML(true);
    $mail->Body    = buildHtml($data);
    $mail->AltBody = buildText($data);

    $mail->send();
    echo json_encode(['success' => true]);

} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => $mail->ErrorInfo]);
}
