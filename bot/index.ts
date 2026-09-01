/**
 * 점심팟 슬랙봇 본체.
 *
 * 실행: npm run bot
 *
 * Socket Mode로 동작합니다. 즉, 슬랙이 우리 컴퓨터로 접속하는 게 아니라
 * 우리 봇이 슬랙에 웹소켓으로 붙습니다. 그래서 공개 주소(ngrok, 배포)가 필요 없습니다.
 *
 * 전체 흐름
 *   /점심팟  → 모달 입력 → 채널에 모집 메시지              [1단계 모집중]
 *   🔒 모집 마감 (파티장)                                     [2단계 모집 완료]
 *   💸 정산 시작 (파티장) → 참여자별 금액·계좌 입력 → DM      [3단계 정산 중]
 *   각자 "✅ 입금했어요" (또는 "⚠️ 이상해요!") → 전원 완료되면 자동 전환  [4단계 정산 완료]
 *   🏁 정산 마무리 (파티장) → 완전히 종료, 되돌릴 수 없음
 */

import { App } from '@slack/bolt';
import type { ViewOutput } from '@slack/bolt';

import {
  ACCOUNT_FIELDS,
  ACTION,
  FIELD,
  POT_TYPE_LABEL,
  VIEW,
  amountBlockId,
  createPotModal,
  type FieldId,
  mention,
  potMessage,
  saveAccountModal,
  settlementDm,
  startSettlementModal,
} from '../src/lib/blocks.ts';
import {
  cancelPot,
  closePot,
  createPot,
  deletePot,
  finalizeSettlement,
  finishSettlement,
  finishWithoutSettlement,
  formatWon,
  getAccount,
  getParticipants,
  getPot,
  getUserNames,
  joinPot,
  leavePot,
  listUnnamedUserIds,
  markDisputed,
  markPaid,
  POT_TYPE,
  purgeFinishedAccounts,
  rememberUserName,
  reopenSettlement,
  saveAccount,
  setDmRef,
  setPotMessage,
  startSettlement,
  type Account,
  type ParticipantAmount,
  type Pot,
  type PotType,
} from '../src/lib/pots.ts';
import { POT_STATUS, STATUS_LABEL } from '../src/lib/status.ts';

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
 *    SLACK_LUNCH_COMMANDS=/배달
 */
const LUNCH_COMMANDS = commandList('SLACK_LUNCH_COMMANDS', ['/배달']);
const ACCOUNT_COMMANDS = commandList('SLACK_ACCOUNT_COMMANDS', ['/계좌등록']);
const DINE_OUT_COMMANDS = commandList('SLACK_DINE_OUT_COMMANDS', ['/외식']);
const BET_COMMANDS = commandList('SLACK_BET_COMMANDS', ['/내기빵']);

function commandList(envName: string, fallback: string[]): string[] {
  const raw = process.env[envName]?.trim();
  if (!raw) return fallback;

  // "배달, /외식" 처럼 적어도 되도록 공백을 지우고 슬래시를 붙여줍니다.
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

/**
 * 이 봇 자신의 슬랙 사용자 ID. 시작할 때 슬랙에 물어봐서 채웁니다.
 *
 * 안내문에 봇 이름을 직접 적어두면 슬랙에서 이름을 바꿨을 때 어긋납니다.
 * (실제로 "@점심팟봇으로 초대하세요"라고 적혀 있었지만 이름은 "밥머거"였습니다.)
 * ID로 멘션하면 슬랙이 현재 이름으로 알아서 보여줍니다.
 */
let botUserId: string | null = null;

/** 안내문에 넣을 봇 멘션. 아직 ID를 모르면 그냥 "봇"이라고 씁니다. */
function botMention(): string {
  return botUserId ? `<@${botUserId}>` : '봇';
}

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

/**
 * 이 사람의 이름을 슬랙에 물어봐서 DB에 적어둡니다.
 *
 * 대시보드가 U0BLK... 같은 ID 대신 사람 이름을 보여주기 위한 것입니다.
 * 이미 알고 있으면 슬랙에 묻지 않습니다. 실패해도 그냥 넘어갑니다 —
 * 이름을 못 알아낸다고 팟 참여가 막히면 안 되니까요.
 */
async function rememberWhoThisIs(slackUserId: string): Promise<void> {
  if (getUserNames().has(slackUserId)) return;

  try {
    const info = await client.users.info({ user: slackUserId });
    const p = info.user?.profile;
    // 슬랙에는 이름 칸이 여러 개라, 사람이 알아보기 쉬운 순서로 고릅니다.
    const name = p?.display_name || p?.real_name || info.user?.real_name || info.user?.name;
    if (name) rememberUserName(slackUserId, name);
  } catch (error) {
    // 없는 사용자(user_not_found)는 흔한 일입니다 — 샘플 데이터의 가짜 ID가 대표적입니다.
    // 스택 추적까지 찍으면 시작할 때마다 화면이 지저분해져서 한 줄로만 남깁니다.
    const reason = (error as { data?: { error?: string } })?.data?.error ?? String(error);
    console.error(`   이름 조회 실패 (${slackUserId}): ${reason}`);
  }
}

/**
 * 아직 이름을 모르는 사람들의 이름을 한 번에 채웁니다. 봇이 켜질 때 실행합니다.
 * 이렇게 해야 예전에 만들어진 팟의 참여자들도 대시보드에서 이름으로 보입니다.
 */
async function syncUserNames(): Promise<void> {
  const unknown = listUnnamedUserIds();
  if (unknown.length === 0) return;

  let filled = 0;
  for (const id of unknown) {
    const before = getUserNames().size;
    await rememberWhoThisIs(id);
    if (getUserNames().size > before) filled += 1;
  }

  // 샘플 데이터(U_MINSU 등)는 실제 슬랙 사용자가 아니라 조회에 실패합니다. 정상입니다.
  console.log(`   사용자 이름 ${filled}/${unknown.length}명 확인`);
}

/** 버튼 클릭 정보에서 우리가 실제로 쓰는 부분만 추린 모양. */
type ClickBody = { user: { id: string }; channel?: { id?: string } };

/**
 * 버튼을 누른 본인에게만 보이는 안내를 보냅니다. 다른 사람에겐 안 보입니다.
 *
 * 채널은 "클릭이 일어난 곳"에서 가져옵니다. DB에서 팟을 찾아 채널을 알아내면,
 * 정작 팟이 사라졌을 때(= 그 사실을 안내해야 하는 바로 그 상황) 다시 실패합니다.
 *
 * 채널을 못 찾거나 봇이 그 채널에 없어서 실패하면 DM으로 보냅니다.
 * 안내를 아예 못 보내는 것보다는 낫습니다.
 */
async function replyToClick(body: ClickBody, text: string): Promise<void> {
  const user = body.user.id;
  const channel = body.channel?.id;

  if (channel) {
    try {
      await client.chat.postEphemeral({ channel, user, text });
      return;
    } catch (error) {
      console.error('안내 메시지 발송 실패, DM으로 재시도합니다:', error);
    }
  }

  await client.chat.postMessage({ channel: user, text });
}

/**
 * 모달이 제출될 때 슬랙이 보내주는 입력값 뭉치.
 *
 * Bolt가 이미 정확한 타입(ViewStateValue)을 주므로 그대로 씁니다.
 * 예전에는 `as never` 로 타입 검사를 꺼뒀는데, 그러면 아래 field() 에
 * 아무 문자열이나 넣어도 통과해서 칸 이름 오타를 실행해봐야 알 수 있었습니다.
 *
 * 칸 종류에 따라 값이 담기는 위치가 다릅니다.
 *   - 글자·숫자 입력칸 → value
 *   - 드롭다운(장소 선택) → selected_option.value
 *   - 체크박스 → selected_options 배열
 */
type ModalValues = ViewOutput['state']['values'];

/**
 * 체크박스가 켜져 있는지 확인합니다. 안 켰으면 빈 배열이 옵니다.
 * blockId 는 FieldId 라서 목록에 없는 이름을 넣으면 컴파일 단계에서 걸립니다.
 */
function isChecked(values: ModalValues, blockId: FieldId): boolean {
  return (values[blockId]?.value?.selected_options?.length ?? 0) > 0;
}

/** 모달에서 입력한 값을 꺼냅니다. 비어 있으면 null. */
function field(values: ModalValues, blockId: FieldId): string | null {
  const input = values[blockId]?.value; // action_id 는 모든 칸에서 'value' 로 통일해뒀습니다.
  const raw = input?.value ?? input?.selected_option?.value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/**
 * 계좌 3칸 중 "일부만" 채웠는지 확인합니다.
 *
 * 팟을 만들 때 계좌는 선택 사항이라 전부 비워도 괜찮습니다.
 * 하지만 일부만 적으면 accountFromView가 null을 돌려줘서 적은 내용이 통째로 버려집니다.
 * 그러면 사용자는 계좌를 적었다고 생각하는데 저장은 안 되는 상태가 되므로, 미리 알려줍니다.
 */
function isPartialAccount(values: ModalValues): boolean {
  const filled = ACCOUNT_FIELDS.filter((id) => field(values, id));
  return filled.length > 0 && filled.length < ACCOUNT_FIELDS.length;
}

/** 모달에서 은행/계좌번호/예금주 3칸을 한 번에 꺼냅니다. 하나라도 비면 null. */
function accountFromView(values: ModalValues): Account | null {
  const bank_name = field(values, FIELD.BANK_NAME);
  const account_number = field(values, FIELD.ACCOUNT_NUMBER);
  const account_holder = field(values, FIELD.ACCOUNT_HOLDER);
  if (!bank_name || !account_number || !account_holder) return null;
  return { bank_name, account_number, account_holder };
}

/**
 * 정산 모달에서 참여자별 금액을 꺼냅니다.
 *
 * 참여자마다 입력칸 이름(amountBlockId)이 달라서 FIELD 처럼 고정된 상수로
 * 다룰 수 없으므로, blocks.ts와 공유하는 이름 규칙(amountBlockId)으로 직접 찾습니다.
 * 값이 없거나 0 이하인 사람은 missing에 담아 돌려줍니다.
 */
function amountsFromView(
  values: ModalValues,
  payerIds: string[],
): { amounts: ParticipantAmount[]; missing: string[] } {
  const amounts: ParticipantAmount[] = [];
  const missing: string[] = [];

  for (const slackUserId of payerIds) {
    const raw = values[amountBlockId(slackUserId)]?.value?.value;
    const amount = raw ? Number(raw) : NaN;
    if (!Number.isFinite(amount) || amount <= 0) missing.push(slackUserId);
    else amounts.push({ slackUserId, amount: Math.round(amount) });
  }

  return { amounts, missing };
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
      view: createPotModal(POT_TYPE.DELIVERY, command.channel_id, getAccount(command.user_id)),
    });
  });
}

/**
 * /외식 — 배달과 흐름은 똑같고, 장소만 층 선택 대신 가게 이름·주소를 직접 적습니다.
 * 같은 모달(createPotModal)과 같은 제출 핸들러(VIEW.CREATE_POT)를 kind로 나눠 씁니다.
 */
for (const commandName of DINE_OUT_COMMANDS) {
  app.command(commandName, async ({ command, ack, client }) => {
    await ack();

    await client.views.open({
      trigger_id: command.trigger_id,
      view: createPotModal(POT_TYPE.DINE_OUT, command.channel_id, getAccount(command.user_id)),
    });
  });
}

/** 모달에서 "모집 시작"을 누른 순간. 팟을 만들고 채널에 메시지를 올립니다. */
app.view(VIEW.CREATE_POT, async ({ ack, body, view, client }) => {
  const values = view.state.values;
  const title = field(values, FIELD.TITLE);

  if (!title) {
    // ack에 errors를 담으면 모달이 닫히지 않고 그 칸에 빨간 글씨가 뜹니다.
    await ack({ response_action: 'errors', errors: { [FIELD.TITLE]: '뭘 먹을지 적어주세요.' } });
    return;
  }

  // 계좌는 안 적어도 되지만, 적을 거면 세 칸을 다 채워야 저장됩니다.
  if (isPartialAccount(values)) {
    await ack({
      response_action: 'errors',
      errors: {
        [FIELD.ACCOUNT_HOLDER]: '계좌를 적으시려면 은행 · 계좌번호 · 예금주를 모두 채워주세요. (전부 비워두셔도 됩니다)',
      },
    });
    return;
  }

  await ack();

  // 모달을 열 때 어느 채널·어느 종류(배달/외식)인지 함께 실어 보내뒀던 값
  const { channelId, potType } = JSON.parse(view.private_metadata) as {
    channelId: string;
    potType: PotType;
  };
  const userId = body.user.id;
  const capacityRaw = field(values, FIELD.CAPACITY);

  await rememberWhoThisIs(userId); // 대시보드에 ID 대신 이름이 보이도록

  const pot = createPot({
    channelId,
    organizerId: userId,
    potType,
    title,
    place: field(values, FIELD.PLACE),
    meetAt: field(values, FIELD.MEET_AT),
    capacity: capacityRaw ? Number(capacityRaw) : 0,
    account: accountFromView(values),
  });

  try {
    const posted = await client.chat.postMessage({
      channel: channelId,
      text: `🍚 ${pot.title} — ${POT_TYPE_LABEL[potType]}팟 모집중`,
      blocks: potMessage(pot, getParticipants(pot.id)),
    });
    // 올린 메시지의 주소(ts)를 저장해둬야 나중에 이 메시지를 수정할 수 있습니다.
    // 주소를 못 받으면 버튼을 갱신할 수 없어 쓸모없는 팟이 되므로 실패로 봅니다.
    if (!posted.ts) throw new Error('메시지는 올렸지만 주소를 받지 못했습니다.');
    setPotMessage(pot.id, posted.ts);
  } catch (error) {
    // 봇이 채널에 초대되지 않았을 때 가장 흔히 나는 오류입니다.
    console.error('모집 메시지 발송 실패:', error);

    // 팟을 되돌립니다. 그냥 두면 참여·마감·정산 버튼이 하나도 없는 팟이
    // 영원히 "모집중"으로 남습니다. (지울 방법도 없습니다)
    deletePot(pot.id);

    await client.chat.postMessage({
      channel: userId,
      text:
        `⚠️ *${title}* 팟을 만들지 못했어요. 채널에 메시지를 올릴 수 없었습니다.\n` +
        `해당 채널에 ${botMention()} 를 먼저 초대한 뒤 다시 시도해 주세요.\n` +
        `(채널에서 \`/invite\` 를 입력하고 봇을 고르시면 됩니다)`,
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
    await replyToClick(body, result.error);
    return;
  }

  await rememberWhoThisIs(userId); // 대시보드에 ID 대신 이름이 보이도록
  await refreshPotMessage(result.value);
});

/** 빠질게요 */
app.action(ACTION.LEAVE, async ({ ack, body, action }) => {
  await ack();
  const potId = Number((action as { value: string }).value);
  const userId = body.user.id;

  const result = leavePot(potId, userId);
  if (!result.ok) {
    await replyToClick(body, result.error);
    return;
  }
  await refreshPotMessage(result.value);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2단계: 모집 완료
// ─────────────────────────────────────────────────────────────────────────────

/** 🔒 모집 마감 — 파티장만 누를 수 있습니다. (검사는 closePot 안에서 합니다) */
app.action(ACTION.CLOSE, async ({ ack, body, action }) => {
  await ack();
  const potId = Number((action as { value: string }).value);
  const userId = body.user.id;

  const result = closePot(potId, userId);
  if (!result.ok) {
    await replyToClick(body, result.error);
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

/**
 * 🙋 정산 없이 종료 (각자 계산) — 파티장만 누를 수 있습니다.
 * 각자 계산하는 식당처럼 봇으로 돈을 모을 필요가 없을 때, 정산 단계를 건너뛰고 바로 끝냅니다.
 */
app.action(ACTION.NO_SETTLEMENT, async ({ ack, body, action }) => {
  await ack();
  const potId = Number((action as { value: string }).value);
  const userId = body.user.id;

  const result = finishWithoutSettlement(potId, userId);
  if (!result.ok) {
    await replyToClick(body, result.error);
    return;
  }

  await refreshPotMessage(result.value);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3단계: 정산 중
// ─────────────────────────────────────────────────────────────────────────────

/** 💸 정산 시작 버튼 → 참여자별 금액·계좌 입력 모달을 띄웁니다. */
app.action(ACTION.OPEN_SETTLE_MODAL, async ({ ack, body, action, client }) => {
  await ack();
  const potId = Number((action as { value: string }).value);
  const userId = body.user.id;
  const pot = getPot(potId);
  if (!pot) {
    // 조용히 넘어가면 사용자에겐 "버튼이 먹통"으로 보입니다.
    await replyToClick(body, '이미 사라진 팟이에요. 예전 메시지의 버튼일 수 있어요.');
    return;
  }

  // 모달을 열기 전에 먼저 파티장인지 확인합니다. (실제 저장 시 한 번 더 검사합니다)
  if (pot.organizer_id !== userId) {
    await replyToClick(body, '파티장만 정산을 시작할 수 있어요.');
    return;
  }

  const payers = getParticipants(potId).filter((p) => p.slack_user_id !== pot.organizer_id);
  if (payers.length === 0) {
    await replyToClick(body, '참여자가 파티장뿐이라 정산할 금액이 없어요.');
    return;
  }

  await client.views.open({
    trigger_id: (body as { trigger_id: string }).trigger_id,
    view: startSettlementModal(pot, payers, getUserNames(), getAccount(userId)),
  });
});

/**
 * 정산 모달 제출 → 상태를 SETTLING으로 바꾸고 참여자 전원에게 계좌 DM을 보냅니다.
 * 이 프로젝트에서 가장 중요한 부분입니다.
 */
app.view(VIEW.START_SETTLEMENT, async ({ ack, body, view, client }) => {
  const values = view.state.values;
  const potId = Number(view.private_metadata);
  const userId = body.user.id;

  const pot = getPot(potId);
  if (!pot) {
    await ack({ response_action: 'errors', errors: { [FIELD.ACCOUNT_HOLDER]: '이미 사라진 팟이에요.' } });
    return;
  }

  const payerIds = getParticipants(potId)
    .map((p) => p.slack_user_id)
    .filter((id) => id !== pot.organizer_id);
  const { amounts, missing } = amountsFromView(values, payerIds);

  if (missing.length > 0) {
    const errors: Record<string, string> = {};
    for (const id of missing) errors[amountBlockId(id)] = '0보다 큰 금액을 입력해 주세요.';
    await ack({ response_action: 'errors', errors });
    return;
  }

  const account = accountFromView(values);
  if (!account) {
    await ack({
      response_action: 'errors',
      errors: { [FIELD.ACCOUNT_NUMBER]: '은행 · 계좌번호 · 예금주를 모두 입력해 주세요.' },
    });
    return;
  }

  const result = startSettlement(potId, userId, amounts, account);
  if (!result.ok) {
    await ack({ response_action: 'errors', errors: { [FIELD.ACCOUNT_HOLDER]: result.error } });
    return;
  }
  await ack();

  const settled = result.value;

  // 계좌 저장은 체크했을 때만 합니다.
  // 예전에는 묻지도 않고 저장해서, 이번 정산에만 쓰려던 계좌가 다음 팟에 자동으로
  // 채워졌습니다. 편하긴 해도 동의한 적 없는 저장이라 체크박스로 바꿨습니다.
  if (isChecked(values, FIELD.REMEMBER_ACCOUNT)) {
    saveAccount(userId, null, account);
  }

  const { sent, failed } = await sendSettlementDms(settled);

  await refreshPotMessage(settled);

  // 채널 스레드에도 결과를 그대로 적습니다. 실패를 숨기지 않습니다.
  const summary =
    failed.length === 0
      ? `💸 정산이 시작됐어요. 총 *${formatWon(settled.total_amount ?? 0)}원* — 참여자분들 DM 확인해 주세요!`
      : `💸 정산이 시작됐어요. 총 *${formatWon(settled.total_amount ?? 0)}원*\n` +
        `⚠️ ${sent.length}명에게는 DM이 갔지만 ${failed.length}명에게는 보내지 못했어요: ` +
        `${failed.map(mention).join(', ')}`;

  await client.chat.postMessage({
    channel: settled.channel_id,
    thread_ts: settled.message_ts ?? undefined,
    text: summary,
  });

  await reportDmFailures(settled, failed);
});

/** 📨 정산 DM 다시 보내기 — 아직 DM을 못 받은 사람에게만 다시 보냅니다. */
app.action(ACTION.RESEND_DM, async ({ ack, body, action }) => {
  await ack();
  const potId = Number((action as { value: string }).value);
  const userId = body.user.id;

  const pot = getPot(potId);
  if (!pot) {
    await replyToClick(body, '이미 사라진 팟이에요.');
    return;
  }
  if (pot.organizer_id !== userId) {
    await replyToClick(body, '파티장만 다시 보낼 수 있어요.');
    return;
  }
  if (pot.status !== POT_STATUS.SETTLING) {
    await replyToClick(body, '정산 중일 때만 다시 보낼 수 있어요.');
    return;
  }

  const { sent, failed } = await sendSettlementDms(pot, { onlyMissing: true });

  if (sent.length === 0 && failed.length === 0) {
    await replyToClick(body, '참여자 모두 이미 DM을 받았어요.');
    return;
  }

  await replyToClick(
    body,
    failed.length === 0
      ? `📨 ${sent.length}명에게 다시 보냈어요.`
      : `📨 ${sent.length}명에게 보냈고, ${failed.length}명은 이번에도 실패했어요.`,
  );
  await reportDmFailures(pot, failed);
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
  const amount = amountOf(pot.id, userId);

  await refreshSettlementDm(pot, userId);

  // 파티장에게 입금 알림을 보냅니다.
  await client.chat.postMessage({
    channel: pot.organizer_id,
    text: `💰 ${mention(userId)} 님이 *${pot.title}* ${formatWon(amount)}원 입금 완료로 표시했어요.`,
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

/** ↩️ 잘못 눌렀어요 — 입금 완료를 되돌립니다. (DM에서 누름) */
app.action(ACTION.UNMARK_PAID, async ({ ack, body, action, client }) => {
  await ack();
  const potId = Number((action as { value: string }).value);
  const userId = body.user.id;

  const result = markPaid(potId, userId, false);
  if (!result.ok) {
    // 자동으로 정산 완료까지 가버린 경우가 여기에 걸립니다. 무엇을 하면 되는지 알려줍니다.
    const pot = getPot(potId);
    const hint =
      pot?.status === POT_STATUS.SETTLED
        ? `\n이미 정산이 끝난 팟이에요. ${mention(pot.organizer_id)} 님에게 *🔄 정산 다시 열기* 를 눌러달라고 부탁해 주세요.`
        : '';
    await client.chat.postMessage({ channel: userId, text: result.error + hint });
    return;
  }

  const { pot } = result.value;
  await refreshSettlementDm(pot, userId);

  await client.chat.postMessage({
    channel: pot.organizer_id,
    text: `↩️ ${mention(userId)} 님이 *${pot.title}* 입금 완료를 취소했어요.`,
  });

  await refreshPotMessage(pot);
});

/** ⚠️ 이상해요! — 정산 금액이 이상하다고 파티장에게 알립니다. (DM에서 누름) */
app.action(ACTION.DISPUTE, async ({ ack, body, action }) => {
  await ack();
  const potId = Number((action as { value: string }).value);
  const userId = body.user.id;

  const result = markDisputed(potId, userId, true);
  if (!result.ok) {
    await client.chat.postMessage({ channel: userId, text: result.error });
    return;
  }

  const pot = result.value;
  const amount = amountOf(pot.id, userId);

  await refreshSettlementDm(pot, userId);
  await client.chat.postMessage({
    channel: pot.organizer_id,
    text:
      `⚠️ ${mention(userId)} 님이 *${pot.title}* 정산 금액(${formatWon(amount)}원)이 이상하다고 알려왔어요.\n` +
      `직접 확인해서 맞는 금액이면 그대로 안내해 주시고, 잘못됐다면 이 팟은 *🚫 팟 취소* 하고 정확한 금액으로 새로 만들어 주세요.`,
  });
  await refreshPotMessage(pot);
});

/** ↩️ 신고 취소 — "이상해요" 신고를 취소합니다. (DM에서 누름) */
app.action(ACTION.UNDISPUTE, async ({ ack, body, action }) => {
  await ack();
  const potId = Number((action as { value: string }).value);
  const userId = body.user.id;

  const result = markDisputed(potId, userId, false);
  if (!result.ok) {
    await client.chat.postMessage({ channel: userId, text: result.error });
    return;
  }

  await refreshSettlementDm(result.value, userId);
  await refreshPotMessage(result.value);
});

/**
 * 참여자들에게 정산 DM을 보냅니다. (파티장은 자기한테 입금할 일이 없으니 제외)
 *
 * 누구에게 성공하고 실패했는지 돌려줍니다. 예전에는 실패를 터미널에만 적고
 * 넘어가서, 파티장은 DM이 갔다고 믿고 기다리고 참여자는 받은 게 없어
 * 아무도 상황을 모르는 채로 멈춰 있었습니다.
 *
 * onlyMissing = true 면 아직 DM을 못 받은 사람에게만 보냅니다. (재발송용)
 */
async function sendSettlementDms(
  pot: Pot,
  { onlyMissing = false }: { onlyMissing?: boolean } = {},
): Promise<{ sent: string[]; failed: string[] }> {
  const participants = getParticipants(pot.id);

  const sent: string[] = [];
  const failed: string[] = [];

  for (const participant of participants) {
    if (participant.slack_user_id === pot.organizer_id) continue;
    if (onlyMissing && participant.dm_ts) continue; // 이미 받은 사람은 건너뜁니다.

    const amount = participant.amount ?? 0;

    try {
      // 1) 이 사람과의 1:1 대화방을 엽니다(이미 있으면 그 방을 돌려줍니다).
      const dm = await client.conversations.open({ users: participant.slack_user_id });
      const dmChannel = dm.channel?.id;
      if (!dmChannel) throw new Error('DM 대화방을 열지 못했습니다.');

      // 2) 그 방에 정산 안내를 보냅니다.
      const posted = await client.chat.postMessage({
        channel: dmChannel,
        text: `💸 ${pot.title} 정산 ${formatWon(amount)}원`,
        blocks: settlementDm(pot, amount, {
          paid: participant.paid === 1,
          disputed: participant.disputed === 1,
        }),
      });
      // 주소를 못 받으면 나중에 이 DM을 고칠 수 없으므로 실패로 봅니다.
      if (!posted.ts) throw new Error('DM은 보냈지만 메시지 주소를 받지 못했습니다.');

      // 3) "입금했어요"를 누르면 이 DM을 고쳐야 하므로 주소를 저장합니다.
      setDmRef(pot.id, participant.slack_user_id, dmChannel, posted.ts);
      sent.push(participant.slack_user_id);
    } catch (error) {
      console.error(`DM 발송 실패 (${participant.slack_user_id}):`, error);
      failed.push(participant.slack_user_id);
    }
  }

  return { sent, failed };
}

/** 이 사람이 보낼 금액. 여러 곳에서 같은 조회를 하고 있어서 한 곳으로 모았습니다. */
function amountOf(potId: number, slackUserId: string): number {
  return getParticipants(potId).find((p) => p.slack_user_id === slackUserId)?.amount ?? 0;
}

/**
 * 한 사람이 받은 정산 DM을 현재 입금 · 신고 상태에 맞춰 다시 그립니다.
 * (입금했어요 ↔ 잘못 눌렀어요 ↔ 이상해요 를 오갈 때마다 이 DM의 버튼이 바뀝니다)
 *
 * paid/disputed 값을 인자로 받지 않고 DB에서 다시 읽어옵니다. 호출하는 쪽마다
 * 상태를 조립해서 넘기면, 실제로 막 바뀐 값과 어긋날 여지가 있기 때문입니다.
 */
async function refreshSettlementDm(pot: Pot, slackUserId: string): Promise<void> {
  const me = getParticipants(pot.id).find((p) => p.slack_user_id === slackUserId);
  if (!me?.dm_channel_id || !me.dm_ts) return; // DM을 못 받은 사람이면 고칠 것도 없습니다.

  const state = { paid: me.paid === 1, disputed: me.disputed === 1 };
  const headline = state.paid
    ? `✅ ${pot.title} 입금 완료`
    : state.disputed
      ? `⚠️ ${pot.title} 정산 금액 문의`
      : `💸 ${pot.title} 정산 안내`;

  await client.chat.update({
    channel: me.dm_channel_id,
    ts: me.dm_ts,
    text: headline,
    blocks: settlementDm(pot, me.amount ?? 0, state),
  });
}

/** DM을 못 받은 사람이 있으면 파티장에게 알리고, 무엇을 하면 되는지 일러줍니다. */
async function reportDmFailures(pot: Pot, failed: string[]): Promise<void> {
  if (failed.length === 0) return;

  await client.chat.postMessage({
    channel: pot.organizer_id,
    text:
      `⚠️ *${pot.title}* — ${failed.length}명에게 정산 DM을 보내지 못했어요.\n` +
      `${failed.map(mention).join(', ')}\n\n` +
      `봇과 DM을 주고받을 수 없는 설정이거나 워크스페이스를 떠났을 수 있어요.\n` +
      `채널의 모집 메시지에서 *📨 정산 DM 다시 보내기* 를 눌러 재시도할 수 있고,\n` +
      `계속 안 되면 계좌를 직접 알려주신 뒤 *✅ 정산 완료 처리* 로 끝내시면 됩니다.`,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4단계: 정산 완료
// ─────────────────────────────────────────────────────────────────────────────

/** ✅ 정산 완료 처리 — 현금으로 받았거나 할 때 파티장이 수동으로 끝낼 수 있습니다. */
app.action(ACTION.FINISH, async ({ ack, body, action }) => {
  await ack();
  const potId = Number((action as { value: string }).value);
  const userId = body.user.id;

  const result = finishSettlement(potId, userId);
  if (!result.ok) {
    await replyToClick(body, result.error);
    return;
  }

  await refreshPotMessage(result.value);
  await announceSettled(result.value);
});

/** 🔄 정산 다시 열기 — 잘못 끝난 정산을 3단계로 되돌립니다. */
app.action(ACTION.REOPEN, async ({ ack, body, action }) => {
  await ack();
  const potId = Number((action as { value: string }).value);
  const userId = body.user.id;

  const result = reopenSettlement(potId, userId);
  if (!result.ok) {
    await replyToClick(body, result.error);
    return;
  }

  const pot = result.value;
  await refreshPotMessage(pot);
  await client.chat.postMessage({
    channel: pot.channel_id,
    thread_ts: pot.message_ts ?? undefined,
    text: `🔄 *${pot.title}* 정산을 다시 열었어요. 입금 확인이 끝나면 다시 완료 처리해 주세요.`,
  });
});

/** 🏁 정산 마무리 — 완전히 끝냅니다. 이후로는 되돌릴 수 없어요. */
app.action(ACTION.FINALIZE, async ({ ack, body, action }) => {
  await ack();
  const potId = Number((action as { value: string }).value);
  const userId = body.user.id;

  const result = finalizeSettlement(potId, userId);
  if (!result.ok) {
    await replyToClick(body, result.error);
    return;
  }

  const pot = result.value;
  await refreshPotMessage(pot);
  await client.chat.postMessage({
    channel: pot.channel_id,
    thread_ts: pot.message_ts ?? undefined,
    text: `🏁 *${pot.title}* 정산을 완전히 마무리했어요. 수고하셨습니다!`,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 취소 (4단계 흐름 바깥)
// ─────────────────────────────────────────────────────────────────────────────

/** 🚫 팟 취소 — 정산이 끝나기 전까지 파티장이 언제든 접을 수 있습니다. */
app.action(ACTION.CANCEL, async ({ ack, body, action }) => {
  await ack();
  const potId = Number((action as { value: string }).value);
  const userId = body.user.id;

  // 취소를 알리려면 참여자 명단이 필요한데, 취소하고 나면 그대로지만
  // 순서를 명확히 하려고 미리 받아둡니다.
  const before = getPot(potId);
  const participants = before ? getParticipants(potId) : [];

  const result = cancelPot(potId, userId);
  if (!result.ok) {
    await replyToClick(body, result.error);
    return;
  }

  const pot = result.value;
  await refreshPotMessage(pot);
  await client.chat.postMessage({
    channel: pot.channel_id,
    thread_ts: pot.message_ts ?? undefined,
    text: `🚫 *${pot.title}* 팟이 취소됐어요.`,
  });

  // 정산 중이었다면 이미 계좌 DM을 받은 사람들이 있습니다.
  // 그분들에게는 "안 보내도 된다"고 따로 알려야 합니다.
  if (before?.status === POT_STATUS.SETTLING) {
    for (const participant of participants) {
      if (participant.slack_user_id === pot.organizer_id) continue;
      if (!participant.dm_ts) continue; // DM을 못 받은 사람은 알릴 것도 없습니다.

      try {
        await client.chat.postMessage({
          channel: participant.slack_user_id,
          text: `🚫 *${pot.title}* 정산이 취소됐어요. 아직 입금 전이라면 보내지 않으셔도 됩니다.`,
        });
      } catch (error) {
        console.error(`취소 알림 발송 실패 (${participant.slack_user_id}):`, error);
      }
    }
  }
});

/** 정산이 끝났음을 채널 스레드에 알립니다. */
async function announceSettled(pot: Pot): Promise<void> {
  await client.chat.postMessage({
    channel: pot.channel_id,
    thread_ts: pot.message_ts ?? undefined,
    text: `✅ *${pot.title}* 정산이 모두 끝났어요. 이상 없으면 파티장이 *🏁 정산 마무리* 로 완전히 닫아주세요.`,
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
  const values = view.state.values;
  const account = accountFromView(values);

  if (!account) {
    await ack({
      response_action: 'errors',
      errors: { [FIELD.ACCOUNT_NUMBER]: '세 칸을 모두 채워주세요.' },
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

// 내가 누구인지 슬랙에 물어봅니다. 안내문에서 봇을 멘션할 때 씁니다.
// 실패해도 봇은 정상 동작하므로 오류를 남기고 넘어갑니다.
try {
  const me = await client.auth.test();
  botUserId = me.user_id ?? null;
  console.log(`🍚 점심팟 봇이 슬랙에 연결됐습니다. (Socket Mode) — ${me.user}`);
} catch (error) {
  console.error('봇 정보를 가져오지 못했습니다(동작에는 문제 없음):', error);
  console.log('🍚 점심팟 봇이 슬랙에 연결됐습니다. (Socket Mode)');
}

// 어떤 커맨드를 받는지 찍어둡니다. 슬랙에 등록한 이름이 여기 없으면 반응이 없습니다.
console.log(`   받는 커맨드: ${[...LUNCH_COMMANDS, ...ACCOUNT_COMMANDS].join(' ')}`);

// 예전 팟의 참여자 이름까지 채워둡니다. (대시보드에서 ID 대신 이름으로 보이도록)
await syncUserNames();

/**
 * 끝난 팟의 계좌번호를 지웁니다. 켤 때 한 번, 이후 6시간마다.
 * 봇을 며칠씩 켜두면 시작할 때 한 번만으로는 계속 쌓이기 때문입니다.
 */
function cleanUpOldAccounts(): void {
  const purged = purgeFinishedAccounts();
  if (purged > 0) console.log(`   끝난 팟 ${purged}건에서 계좌번호를 지웠습니다.`);
}

cleanUpOldAccounts();
setInterval(cleanUpOldAccounts, 6 * 60 * 60 * 1000);

console.log('   종료는 Ctrl+C');
