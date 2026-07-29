/**
 * 슬랙 앱 설정이 제대로 됐는지 검사하는 진단 도구.
 *
 *   npm run doctor
 *
 * 봇이 안 돌거나 커맨드가 안 뜰 때 제일 먼저 실행해 보세요.
 * 토큰 값 자체는 절대 화면에 찍지 않습니다.
 */

// 이 파일을 "모듈"로 취급하게 하는 표시. 최상단에서 await 를 쓰려면 필요합니다.
export {};

// 이 봇이 동작하려면 반드시 있어야 하는 권한들
const REQUIRED_SCOPES = [
  { scope: 'commands', why: '/점심팟 같은 슬래시 커맨드' },
  { scope: 'chat:write', why: '모집 메시지 올리기 · 수정하기' },
  { scope: 'im:write', why: '정산 계좌 DM 보내기' },
];

// 없어도 돌아가지만 있으면 편한 권한들
const OPTIONAL_SCOPES = [
  { scope: 'chat:write.public', why: '초대 안 된 공개 채널에도 메시지 올리기' },
  { scope: 'users:read', why: '사용자 이름 조회' },
];

let hasProblem = false;

function fail(message: string): void {
  hasProblem = true;
  console.log(message);
}

// ── 1. 토큰이 채워져 있는지 ─────────────────────────────────────────────────

const botToken = process.env.SLACK_BOT_TOKEN?.trim();
const appToken = process.env.SLACK_APP_TOKEN?.trim();

console.log('1. .env.local 토큰 확인');

if (!botToken || botToken === 'xoxb-') {
  fail('   ❌ SLACK_BOT_TOKEN 이 비어 있거나 예시값 그대로입니다.');
} else if (!botToken.startsWith('xoxb-')) {
  fail('   ❌ SLACK_BOT_TOKEN 이 xoxb- 로 시작하지 않습니다. 두 토큰이 바뀌지 않았나요?');
} else {
  console.log('   ✅ SLACK_BOT_TOKEN 형식 정상');
}

if (!appToken || appToken === 'xapp-') {
  fail('   ❌ SLACK_APP_TOKEN 이 비어 있거나 예시값 그대로입니다.');
} else if (!appToken.startsWith('xapp-')) {
  fail('   ❌ SLACK_APP_TOKEN 이 xapp- 로 시작하지 않습니다. 두 토큰이 바뀌지 않았나요?');
} else {
  console.log('   ✅ SLACK_APP_TOKEN 형식 정상');
}

if (hasProblem) {
  console.log('\n토큰부터 채워주세요. 자세한 방법은 SETUP.md 를 보세요.');
  process.exit(1);
}

// ── 2. 봇 토큰이 실제로 동작하는지 + 권한 확인 ──────────────────────────────

console.log('\n2. 봇 토큰 · 권한 확인');

const authRes = await fetch('https://slack.com/api/auth.test', {
  method: 'POST',
  headers: { Authorization: `Bearer ${botToken}` },
});
const auth = (await authRes.json()) as { ok: boolean; error?: string; team?: string; user?: string };

if (!auth.ok) {
  fail(`   ❌ 봇 토큰이 거부됐습니다: ${auth.error}`);
  console.log('      OAuth & Permissions 에서 Bot User OAuth Token 을 다시 복사해 주세요.');
  console.log('      (권한을 바꾸고 재설치했다면 토큰이 새로 발급됐을 수 있습니다.)');
  process.exit(1);
}

console.log(`   ✅ 워크스페이스 "${auth.team}" 에 "${auth.user}" 로 설치됨`);

// 부여된 권한 목록은 응답 헤더에 들어 있습니다.
const granted = (authRes.headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim());

for (const { scope, why } of REQUIRED_SCOPES) {
  if (granted.includes(scope)) {
    console.log(`   ✅ ${scope}`);
  } else {
    fail(`   ❌ ${scope} 없음 — ${why}`);
  }
}

for (const { scope, why } of OPTIONAL_SCOPES) {
  if (!granted.includes(scope)) {
    console.log(`   ⚠️  ${scope} 없음 (선택) — ${why}`);
  }
}

console.log(`   지금 토큰에 붙어 있는 권한 전체: ${granted.join(', ') || '(없음)'}`);

if (hasProblem) {
  // 여기가 제일 헷갈리는 지점입니다. 권한은 "앱"이 아니라 "토큰"에 붙어 있어서,
  // 매니페스트를 고쳐도 새 토큰을 안 가져오면 예전 권한이 그대로 보입니다.
  console.log('');
  console.log('   권한이 없다고 나오면 아래 세 가지를 순서대로 확인하세요:');
  console.log('     1) 매니페스트가 실제로 저장됐는지 (저장 실패 시 아무것도 안 바뀝니다)');
  console.log('     2) 저장 후 "Reinstall your app" 을 눌렀는지');
  console.log('     3) 재설치로 새로 발급된 xoxb- 토큰을 .env.local 에 넣었는지');
  console.log('        ← 예전 토큰을 그대로 두면 예전 권한이 계속 보입니다. 가장 흔한 실수입니다.');
}

// ── 3. 앱 토큰으로 웹소켓 연결이 되는지 ─────────────────────────────────────

console.log('\n3. Socket Mode 연결 확인');

const connRes = await fetch('https://slack.com/api/apps.connections.open', {
  method: 'POST',
  headers: { Authorization: `Bearer ${appToken}` },
});
const conn = (await connRes.json()) as { ok: boolean; error?: string };

if (conn.ok) {
  console.log('   ✅ 앱 토큰으로 연결 가능');
} else {
  fail(`   ❌ 연결 실패: ${conn.error}`);
  if (conn.error === 'not_allowed_token_type') {
    console.log('      SLACK_APP_TOKEN 에 xoxb- 토큰을 넣은 것 같습니다. xapp- 토큰이어야 합니다.');
  } else {
    console.log('      Basic Information > App-Level Tokens 에서 connections:write 권한이 있는지 확인하세요.');
  }
}

// ── 결과 ────────────────────────────────────────────────────────────────────

if (hasProblem) {
  console.log('\n❌ 문제가 있습니다. 위 항목을 고친 뒤 다시 실행해 주세요.');
  console.log('   권한을 바꿨다면 앱을 Reinstall 해야 반영됩니다. (SETUP.md 참고)');
  process.exit(1);
}

console.log('\n✅ 설정에 문제가 없습니다. npm run bot 으로 실행하세요.');
