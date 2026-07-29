/**
 * 점심팟 슬랙봇 본체.
 *
 * 실행: npm run bot
 *
 * Socket Mode로 동작합니다. 즉, 슬랙이 우리 컴퓨터로 접속하는 게 아니라
 * 우리 봇이 슬랙에 웹소켓으로 붙습니다. 그래서 공개 주소(ngrok, 배포)가 필요 없습니다.
 *
 * 전체 흐름
 *   /점심팟  → 모달 입력 → 채널에 모집 메시지          [1단계 모집중]
 *   🔒 모집 마감 (팟장)                                  [2단계 모집 완료]
 *   💸 정산 시작 (팟장) → 금액·계좌 입력 → 참여자 DM     [3단계 정산 중]
 *   각자 "✅ 입금했어요" → 전원 완료되면 자동 전환        [4단계 정산 완료]
 */

import { App } from '@slack/bolt';

import {
  ACTION,
  VIEW,
  createPotModal,
  mention,
  potMessage,
  saveAccountModal,
  settlementDm,
  startSettlementModal,
} from '../src/lib/blocks.ts';
import {
  amountPerPerson,
  closePot,
  createPot,
  finishSettlement,
  formatWon,
  getAccount,
  getParticipants,
  getPot,
  joinPot,
  leavePot,
  markPaid,
  saveAccount,
  setDmRef,
  setPotMessage,
  startSettlement,
  type Account,
  type Pot,
} from '../src/lib/pots.ts';
import { STATUS_LABEL } from '../src/lib/status.ts';

// ── 준비 ────────────────────────────────────────────────────────────────────

// 토큰이 없거나 예시값 그대로면, 슬랙에 붙기 전에 여기서 먼저 알려주고 멈춥니다.
// (그냥 두면 슬랙이 invalid_auth 라는 불친절한 오류만 던져서 원인 찾기가 어렵습니다.)
const BOT_TOKEN = requireToken('SLACK_BOT_TOKEN', 'xoxb-', 'OAuth & Permissions > Bot User OAuth Token');
const APP_TOKEN = requireToken('SLACK_APP_TOKEN', 'xapp-', 'Basic Information > App-Level Tokens');

function requireToken(name: string, prefix: string, where: string): string {
  const value = process.env[name]?.trim();

  const problem = !value
    ? '값이 없습니다'
    : // .env.local.example 을 복사만 하고 안 채운 경우 (예: "xoxb-" 만 남아 있음)
      value === prefix
      ? '예시값 그대로입니다. 실제 토큰을 붙여넣어 주세요'
      : !value.startsWith(prefix)
        ? `${prefix} 로 시작해야 합니다. 두 토큰을 바꿔 넣지 않았는지 확인해 보세요`
        : null;

  if (problem) {
    console.error(`\n❌ ${name}: ${problem}`);
    console.error(`   슬랙에서 받는 곳: ${where}`);
    console.error(`   받은 값을 .env.local 의 ${name}= 뒤에 붙여넣으세요. (따옴표 없이)`);
    console.error(`   자세한 방법은 SETUP.md 를 보세요.\n`);
    process.exit(1);
  }

  return value!;
}

/**
 * 봇이 받아들일 슬래시 커맨드 이름들.
 *
 * ⚠️ 슬랙 매니페스트에 등록한 이름과 **정확히 같아야** 합니다.
 *    이름을 바꿨는데 여기 없으면, 슬랙은 커맨드를 보내주지만 봇이 무시해서
 *    "아무 반응이 없는" 상태가 됩니다.
 *
 * 코드를 안 고치고 .env.local 에서 바꿀 수도 있습니다.
 *    SLACK_LUNCH_COMMANDS=/밥먹자,/점심팟
 */
const LUNCH_COMMANDS = commandList('SLACK_LUNCH_COMMANDS', ['/점심팟', '/밥먹자', '/lunch']);
const ACCOUNT_COMMANDS = commandList('SLACK_ACCOUNT_COMMANDS', ['/계좌등록', '/account']);

function commandList(envName: string, fallback: string[]): string[] {
  const raw = process.env[envName]?.trim();
  if (!raw) return fallback;

  // "밥먹자, /점심팟" 처럼 적어도 되도록 공백을 지우고 슬래시를 붙여줍니다.
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => (name.startsWith('/') ? name : `/${name}`));
}

const app = new App({
  token: BOT_TOKEN,
  appToken: APP_TOKEN,
  socketMode: true, // ← 이 한 줄이 웹소켓 모드로 켜주는 스위치입니다.
});

// 슬랙 API를 부를 때 쓰는 클라이언트. (DM 보내기, 메시지 수정 등)
const client = app.client;

// ── 공통 도우미 ─────────────────────────────────────────────────────────────

/**
 * 채널에 올라간 모집 메시지를 현재 상태에 맞춰 다시 그립니다.
 * 버튼을 누를 때마다 새 메시지를 쌓지 않고 원래 메시지를 갱신하는 게 핵심입니다.
 */
async function refreshPotMessage(pot: Pot): Promise<void> {
  if (!pot.message_ts) return; // 아직 메시지를 못 올린 팟
  const participants = getParticipants(pot.id);

  await client.chat.update({
    channel: pot.channel_id,
    ts: pot.message_ts,
    text: `${STATUS_LABEL[pot.status]} · ${pot.title}`, // 알림 목록에 뜨는 짧은 요약
    blocks: potMessage(pot, participants),
  });
}

/** 버튼을 누른 본인에게만 보이는 안내 메시지. 다른 사람에겐 안 보입니다. */
async function whisper(channel: string, user: string, text: string): Promise<void> {
  await client.chat.postEphemeral({ channel, user, text });
}

/** 모달에서 입력한 값을 꺼냅니다. 비어 있으면 null. */
function field(
  values: Record<string, Record<string, { value?: string | null }>>,
  blockId: string,
): string | null {
  const raw = values[blockId]?.value?.value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/** 모달에서 은행/계좌번호/예금주 3칸을 한 번에 꺼냅니다. 하나라도 비면 null. */
function accountFromView(
  values: Record<string, Record<string, { value?: string | null }>>,
): Account | null {
  const bank_name = field(values, 'bank_name');
  const account_number = field(values, 'account_number');
  const account_holder = field(values, 'account_holder');
  if (!bank_name || !account_number || !account_holder) return null;
  return { bank_name, account_number, account_holder };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1단계: 모집중 — 팟 만들기
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 팟 만들기 커맨드를 입력하면 모달을 띄웁니다.
 * 슬랙 매니페스트에서 커맨드 이름을 바꿨다면 LUNCH_COMMANDS 에 그 이름을 추가하세요.
 */
for (const commandName of LUNCH_COMMANDS) {
  app.command(commandName, async ({ command, ack, client }) => {
    await ack(); // 슬랙은 3초 안에 "받았다"고 답하지 않으면 오류로 처리합니다.

    await client.views.open({
      trigger_id: command.trigger_id,
      view: createPotModal(command.channel_id, getAccount(command.user_id)),
    });
  });
}

/** 모달에서 "모집 시작"을 누른 순간. 팟을 만들고 채널에 메시지를 올립니다. */
app.view(VIEW.CREATE_POT, async ({ ack, body, view, client }) => {
  const values = view.state.values as never;
  const title = field(values, 'title');

  if (!title) {
    // ack에 errors를 담으면 모달이 닫히지 않고 그 칸에 빨간 글씨가 뜹니다.
    await ack({ response_action: 'errors', errors: { title: '뭘 먹을지 적어주세요.' } });
    return;
  }
  await ack();

  const channelId = view.private_metadata; // 모달을 연 채널을 기억해뒀던 값
  const userId = body.user.id;
  const capacityRaw = field(values, 'capacity');

  const pot = createPot({
    channelId,
    organizerId: userId,
    title,
    place: field(values, 'place'),
    meetAt: field(values, 'meet_at'),
    capacity: capacityRaw ? Number(capacityRaw) : 0,
    account: accountFromView(values),
  });

  try {
    const posted = await client.chat.postMessage({
      channel: channelId,
      text: `🍚 ${pot.title} — 점심팟 모집중`,
      blocks: potMessage(pot, getParticipants(pot.id)),
    });
    // 올린 메시지의 주소(ts)를 저장해둬야 나중에 이 메시지를 수정할 수 있습니다.
    if (posted.ts) setPotMessage(pot.id, posted.ts);
  } catch (error) {
    // 봇이 채널에 초대되지 않았을 때 가장 흔히 나는 오류입니다.
    console.error('모집 메시지 발송 실패:', error);
    await client.chat.postMessage({
      channel: userId,
      text: `⚠️ 팟은 만들었지만 채널에 메시지를 올리지 못했어요.\n해당 채널에서 \`/invite @점심팟봇\` 으로 봇을 먼저 초대해 주세요.`,
    });
  }
});

/** 🙋 참여할게요 */
app.action(ACTION.JOIN, async ({ ack, body, action }) => {
  await ack();
  const potId = Number((action as { value: string }).value);
  const userId = body.user.id;

  const result = joinPot(potId, userId);
  if (!result.ok) {
    await whisper(getPot(potId)!.channel_id, userId, result.error);
    return;
  }
  await refreshPotMessage(result.value);
});

/** 빠질게요 */
app.action(ACTION.LEAVE, async ({ ack, body, action }) => {
  await ack();
  const potId = Number((action as { value: string }).value);
  const userId = body.user.id;

  const result = leavePot(potId, userId);
  if (!result.ok) {
    await whisper(getPot(potId)!.channel_id, userId, result.error);
    return;
  }
  await refreshPotMessage(result.value);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2단계: 모집 완료
// ─────────────────────────────────────────────────────────────────────────────

/** 🔒 모집 마감 — 팟장만 누를 수 있습니다. (검사는 closePot 안에서 합니다) */
app.action(ACTION.CLOSE, async ({ ack, body, action }) => {
  await ack();
  const potId = Number((action as { value: string }).value);
  const userId = body.user.id;

  const result = closePot(potId, userId);
  if (!result.ok) {
    await whisper(getPot(potId)!.channel_id, userId, result.error);
    return;
  }

  const pot = result.value;
  await refreshPotMessage(pot);
  await client.chat.postMessage({
    channel: pot.channel_id,
    thread_ts: pot.message_ts ?? undefined, // 채널을 어지럽히지 않게 스레드로 답니다.
    text: `🔒 모집이 마감됐어요. 총 ${getParticipants(pot.id).length}명이에요.`,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3단계: 정산 중
// ─────────────────────────────────────────────────────────────────────────────

/** 💸 정산 시작 버튼 → 금액·계좌 입력 모달을 띄웁니다. */
app.action(ACTION.OPEN_SETTLE_MODAL, async ({ ack, body, action, client }) => {
  await ack();
  const potId = Number((action as { value: string }).value);
  const userId = body.user.id;
  const pot = getPot(potId);
  if (!pot) return;

  // 모달을 열기 전에 먼저 팟장인지 확인합니다. (실제 저장 시 한 번 더 검사합니다)
  if (pot.organizer_id !== userId) {
    await whisper(pot.channel_id, userId, '팟장만 정산을 시작할 수 있어요.');
    return;
  }

  await client.views.open({
    trigger_id: (body as { trigger_id: string }).trigger_id,
    view: startSettlementModal(pot, getAccount(userId)),
  });
});

/**
 * 정산 모달 제출 → 상태를 SETTLING으로 바꾸고 참여자 전원에게 계좌 DM을 보냅니다.
 * 이 프로젝트에서 가장 중요한 부분입니다.
 */
app.view(VIEW.START_SETTLEMENT, async ({ ack, body, view, client }) => {
  const values = view.state.values as never;
  const potId = Number(view.private_metadata);
  const userId = body.user.id;

  const totalAmount = Number(field(values, 'total_amount') ?? '0');
  const account = accountFromView(values);

  if (!account) {
    await ack({
      response_action: 'errors',
      errors: { account_number: '은행 · 계좌번호 · 예금주를 모두 입력해 주세요.' },
    });
    return;
  }

  const result = startSettlement(potId, userId, totalAmount, account);
  if (!result.ok) {
    await ack({ response_action: 'errors', errors: { total_amount: result.error } });
    return;
  }
  await ack();

  const pot = result.value;
  const participants = getParticipants(pot.id);
  const perPerson = amountPerPerson(totalAmount, participants.length);

  // 팟장이 계좌를 등록해두지 않았다면, 방금 입력한 계좌를 저장해서 다음에 재사용합니다.
  if (!getAccount(userId)) saveAccount(userId, null, account);

  // 팟장을 뺀 나머지에게만 DM을 보냅니다. (팟장은 자기한테 입금할 필요가 없으니까요)
  for (const participant of participants) {
    if (participant.slack_user_id === pot.organizer_id) continue;

    try {
      // 1) 이 사람과의 1:1 대화방을 엽니다(이미 있으면 그 방을 돌려줍니다).
      const dm = await client.conversations.open({ users: participant.slack_user_id });
      const dmChannel = dm.channel?.id;
      if (!dmChannel) continue;

      // 2) 그 방에 정산 안내를 보냅니다.
      const sent = await client.chat.postMessage({
        channel: dmChannel,
        text: `💸 ${pot.title} 정산 ${formatWon(perPerson)}원`,
        blocks: settlementDm(pot, perPerson, false),
      });

      // 3) 나중에 "입금했어요"를 누르면 이 DM을 고쳐야 하므로 주소를 저장합니다.
      if (sent.ts) setDmRef(pot.id, participant.slack_user_id, dmChannel, sent.ts);
    } catch (error) {
      console.error(`DM 발송 실패 (${participant.slack_user_id}):`, error);
    }
  }

  await refreshPotMessage(pot);
  await client.chat.postMessage({
    channel: pot.channel_id,
    thread_ts: pot.message_ts ?? undefined,
    text: `💸 정산이 시작됐어요. 1인당 *${formatWon(perPerson)}원* — 참여자분들 DM 확인해 주세요!`,
  });
});

/** ✅ 입금했어요 (DM에서 누름) */
app.action(ACTION.MARK_PAID, async ({ ack, body, action, client }) => {
  await ack();
  const potId = Number((action as { value: string }).value);
  const userId = body.user.id;

  const result = markPaid(potId, userId, true);
  if (!result.ok) {
    // DM 안에서는 ephemeral을 쓸 수 없으니 그냥 DM으로 답합니다.
    await client.chat.postMessage({ channel: userId, text: result.error });
    return;
  }

  const { pot, allPaid } = result.value;
  const participants = getParticipants(pot.id);
  const perPerson = amountPerPerson(pot.total_amount ?? 0, participants.length);

  // 방금 누른 사람의 DM을 "완료" 모습으로 바꿔줍니다. (버튼 사라짐)
  const me = participants.find((p) => p.slack_user_id === userId);
  if (me?.dm_channel_id && me.dm_ts) {
    await client.chat.update({
      channel: me.dm_channel_id,
      ts: me.dm_ts,
      text: `✅ ${pot.title} 입금 완료`,
      blocks: settlementDm(pot, perPerson, true),
    });
  }

  // 팟장에게 입금 알림을 보냅니다.
  await client.chat.postMessage({
    channel: pot.organizer_id,
    text: `💰 ${mention(userId)} 님이 *${pot.title}* ${formatWon(perPerson)}원 입금 완료로 표시했어요.`,
  });

  if (allPaid) {
    // 전원 입금 → 4단계로 자동 전환
    const done = finishSettlement(pot.id, pot.organizer_id);
    if (done.ok) {
      await refreshPotMessage(done.value);
      await announceSettled(done.value);
      return;
    }
  }

  await refreshPotMessage(pot);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4단계: 정산 완료
// ─────────────────────────────────────────────────────────────────────────────

/** ✅ 정산 마무리 — 현금으로 받았거나 할 때 팟장이 수동으로 끝낼 수 있습니다. */
app.action(ACTION.FINISH, async ({ ack, body, action }) => {
  await ack();
  const potId = Number((action as { value: string }).value);
  const userId = body.user.id;

  const result = finishSettlement(potId, userId);
  if (!result.ok) {
    await whisper(getPot(potId)!.channel_id, userId, result.error);
    return;
  }

  await refreshPotMessage(result.value);
  await announceSettled(result.value);
});

/** 정산이 끝났음을 채널 스레드에 알립니다. */
async function announceSettled(pot: Pot): Promise<void> {
  await client.chat.postMessage({
    channel: pot.channel_id,
    thread_ts: pot.message_ts ?? undefined,
    text: `✅ *${pot.title}* 정산이 모두 끝났어요. 수고하셨습니다!`,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 계좌 등록 (단계와 무관한 부가 기능)
// ─────────────────────────────────────────────────────────────────────────────

for (const commandName of ACCOUNT_COMMANDS) {
  app.command(commandName, async ({ command, ack, client }) => {
    await ack();
    await client.views.open({
      trigger_id: command.trigger_id,
      view: saveAccountModal(getAccount(command.user_id)),
    });
  });
}

app.view(VIEW.SAVE_ACCOUNT, async ({ ack, body, view, client }) => {
  const values = view.state.values as never;
  const account = accountFromView(values);

  if (!account) {
    await ack({
      response_action: 'errors',
      errors: { account_number: '세 칸을 모두 채워주세요.' },
    });
    return;
  }
  await ack();

  saveAccount(body.user.id, body.user.name ?? null, account);
  await client.chat.postMessage({
    channel: body.user.id,
    text: `✅ 계좌를 저장했어요.\n${account.bank_name} ${account.account_number} (${account.account_holder})`,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 실행
// ─────────────────────────────────────────────────────────────────────────────

// 어디선가 처리 못한 오류가 나도 봇이 죽지 않도록 받아둡니다.
app.error(async (error) => {
  console.error('❗ 처리되지 않은 오류:', error);
});

await app.start();
console.log('🍚 점심팟 봇이 슬랙에 연결됐습니다. (Socket Mode)');
// 어떤 커맨드를 받는지 찍어둡니다. 슬랙에 등록한 이름이 여기 없으면 반응이 없습니다.
console.log(`   받는 커맨드: ${[...LUNCH_COMMANDS, ...ACCOUNT_COMMANDS].join(' ')}`);
console.log('   종료는 Ctrl+C');
