/**
 * 슬랙에 보낼 메시지·모달의 생김새를 만드는 파일.
 *
 * 슬랙 메시지는 "Block Kit"이라는 JSON 형식으로 만듭니다.
 * 여기서 만든 JSON을 봇이 slack API에 그대로 넘깁니다.
 * 미리보기: https://app.slack.com/block-kit-builder
 */

import type { KnownBlock, View } from '@slack/types';
import { POT_STATUS, STATUS_EMOJI, STATUS_LABEL, STATUS_ORDER, type PotStatus } from './status.ts';
import { formatWon, type Account, type Participant, type Pot } from './pots.ts';

/**
 * 버튼과 모달을 구분하는 이름표들.
 * 봇 쪽에서 app.action(ACTION.JOIN, ...) 처럼 똑같은 문자열로 받아야 하므로
 * 오타를 막기 위해 한 곳에 모아둡니다.
 */
export const ACTION = {
  JOIN: 'pot_join',
  LEAVE: 'pot_leave',
  CLOSE: 'pot_close',
  OPEN_SETTLE_MODAL: 'pot_open_settle_modal',
  MARK_PAID: 'pot_mark_paid',
  UNMARK_PAID: 'pot_unmark_paid',
  DISPUTE: 'pot_dispute',
  UNDISPUTE: 'pot_undispute',
  RESEND_DM: 'pot_resend_dm',
  FINISH: 'pot_finish',
  REOPEN: 'pot_reopen',
  FINALIZE: 'pot_finalize',
  CANCEL: 'pot_cancel',
} as const;

export const VIEW = {
  CREATE_POT: 'view_create_pot',
  START_SETTLEMENT: 'view_start_settlement',
  SAVE_ACCOUNT: 'view_save_account',
} as const;

/**
 * 모달 입력칸의 이름표(block_id).
 *
 * 모달을 만들 때와 제출값을 읽을 때 **같은 상수**를 씁니다.
 * 예전에는 양쪽에 'title' 처럼 문자열을 각각 적어서, 한쪽을 고치면 다른 쪽이
 * 조용히 어긋났습니다. 이제 오타를 내면 그런 상수가 없어서 바로 오류가 납니다.
 */
export const FIELD = {
  TITLE: 'title',
  PLACE: 'place',
  MEET_AT: 'meet_at',
  CAPACITY: 'capacity',
  REMEMBER_ACCOUNT: 'remember_account',
  BANK_NAME: 'bank_name',
  ACCOUNT_NUMBER: 'account_number',
  ACCOUNT_HOLDER: 'account_holder',
} as const;

/** FIELD 의 값들만 모은 타입. 이 목록에 없는 이름은 쓸 수 없습니다. */
export type FieldId = (typeof FIELD)[keyof typeof FIELD];

/**
 * 정산 시작 모달의 "이 사람 얼마" 입력칸 이름표.
 *
 * 참여자 수가 팟마다 달라서 FIELD처럼 고정된 이름을 미리 정해둘 수 없습니다.
 * 대신 슬랙 사용자 ID로 이름을 만드는 규칙 하나를 모달을 만들 때와 값을 읽을 때
 * 똑같이 씁니다.
 */
export function amountBlockId(slackUserId: string): string {
  return `amount:${slackUserId}`;
}

/** 계좌 입력 3칸. 함께 다루는 일이 많아 묶어둡니다. */
export const ACCOUNT_FIELDS = [
  FIELD.BANK_NAME,
  FIELD.ACCOUNT_NUMBER,
  FIELD.ACCOUNT_HOLDER,
] as const;

/**
 * 모일 수 있는 장소. 여기 적힌 값만 고를 수 있습니다.
 * 층이 늘어나면 이 배열에만 추가하면 모달에 자동으로 반영됩니다.
 */
export const PLACES = ['1F', 'B1'] as const;

// ── 작은 도우미들 ────────────────────────────────────────────────────────────

/** 슬랙에서 <@U123> 이라고 쓰면 사람 이름으로 예쁘게 표시됩니다. */
export const mention = (userId: string): string => `<@${userId}>`;

const section = (text: string): KnownBlock => ({
  type: 'section',
  text: { type: 'mrkdwn', text },
});

const context = (text: string): KnownBlock => ({
  type: 'context',
  elements: [{ type: 'mrkdwn', text }],
});

/**
 * 4단계 진행 막대를 글자로 그립니다.
 * 예) *모집중* ─ 모집 완료 ─ 정산 중 ─ 정산 완료
 */
function progressBar(status: PotStatus): string {
  // 취소된 팟은 4단계 흐름 밖이라 진행 막대를 그리지 않습니다.
  if (status === POT_STATUS.CANCELLED) return `🚫 *취소된 팟이에요*`;

  // 정산 마무리는 새 단계가 아니라 정산 완료 위에 얹는 잠금이라, 막대에서는
  // 정산 완료 칸을 그대로 강조하고 그 아래 한 줄만 덧붙입니다.
  const highlight = status === POT_STATUS.FINALIZED ? POT_STATUS.SETTLED : status;
  const bar = STATUS_ORDER.map((s) => (s === highlight ? `*${STATUS_LABEL[s]}*` : STATUS_LABEL[s])).join(
    ' ─ ',
  );

  return status === POT_STATUS.FINALIZED ? `${bar}\n🏁 *완전히 마무리됐어요. 더 이상 되돌릴 수 없어요.*` : bar;
}

/** 파티장만 누를 수 있는 취소 버튼. 정산이 끝나기 전 단계에 공통으로 붙습니다. */
function cancelButton(potId: string) {
  return {
    type: 'button' as const,
    action_id: ACTION.CANCEL,
    text: { type: 'plain_text' as const, text: '🚫 팟 취소 (파티장)', emoji: true },
    value: potId,
  };
}

// ── 채널에 올라가는 모집 메시지 ──────────────────────────────────────────────

/**
 * 팟의 현재 상태에 맞춰 채널 메시지를 통째로 다시 그립니다.
 * 버튼을 누를 때마다 이 함수를 다시 호출해서 같은 메시지를 갱신(chat.update)합니다.
 */
export function potMessage(pot: Pot, participants: Participant[]): KnownBlock[] {
  const emoji = STATUS_EMOJI[pot.status];
  const names = participants.map((p) => mention(p.slack_user_id)).join(', ') || '_아직 없음_';
  const capacityText = pot.capacity > 0 ? `${participants.length}/${pot.capacity}명` : `${participants.length}명`;

  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${emoji} ${pot.title}`, emoji: true },
    },
    context(progressBar(pot.status)),
    section(
      [
        `*파티장* ${mention(pot.organizer_id)}`,
        pot.place ? `*장소* ${pot.place}` : null,
        pot.meet_at ? `*시간* ${pot.meet_at}` : null,
        `*인원* ${capacityText}`,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    section(`*참여자*\n${names}`),
  ];

  // 3단계·4단계에서는 금액과 입금 현황을 함께 보여줍니다.
  if (pot.total_amount) {
    blocks.push({ type: 'divider' });
    // 사람마다 낼 금액이 달라서 "1인당 X원"처럼 한 줄로 요약할 수 없습니다.
    // 총액만 적고, 각자 얼마인지는 입금 현황 목록에서 보여줍니다.
    blocks.push(section(`*총 금액* ${formatWon(pot.total_amount)}원`));
    blocks.push(section(`*입금 현황*\n${paymentStatusList(pot, participants)}`));
  }

  const actions = potActions(pot);
  if (actions) blocks.push(actions);

  return blocks;
}

/** 참여자별 금액 · 입금 여부를 ✅/⬜/🚩 로 나열합니다. */
function paymentStatusList(pot: Pot, participants: Participant[]): string {
  return participants
    .map((p) => {
      if (p.slack_user_id === pot.organizer_id) return `💰 ${mention(p.slack_user_id)} (파티장)`;

      const icon = p.paid === 1 ? '✅' : p.disputed === 1 ? '🚩' : '⬜';
      const amountText = p.amount ? ` ${formatWon(p.amount)}원` : '';
      return `${icon} ${mention(p.slack_user_id)}${amountText}`;
    })
    .join('\n');
}

/**
 * 상태별로 보여줄 버튼을 정합니다. 이게 4단계 흐름의 핵심입니다.
 * (누가 눌러도 되는지는 봇 핸들러에서 다시 한 번 검사합니다.)
 */
function potActions(pot: Pot): KnownBlock | null {
  const potId = String(pot.id); // 버튼에 팟 번호를 실어 보내 어떤 팟인지 알아냅니다.

  switch (pot.status) {
    // 1단계 모집중: 누구나 참여/취소, 파티장은 마감
    case POT_STATUS.RECRUITING:
      return {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: ACTION.JOIN,
            text: { type: 'plain_text', text: '🙋 참여할게요', emoji: true },
            style: 'primary',
            value: potId,
          },
          {
            type: 'button',
            action_id: ACTION.LEAVE,
            text: { type: 'plain_text', text: '빠질게요', emoji: true },
            value: potId,
          },
          {
            type: 'button',
            action_id: ACTION.CLOSE,
            text: { type: 'plain_text', text: '🔒 모집 마감 (파티장)', emoji: true },
            value: potId,
          },
          cancelButton(potId),
        ],
      };

    // 2단계 모집 완료: 파티장이 금액을 입력해 정산을 시작
    case POT_STATUS.CLOSED:
      return {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: ACTION.OPEN_SETTLE_MODAL,
            text: { type: 'plain_text', text: '💸 정산 시작 (파티장)', emoji: true },
            style: 'primary',
            value: potId,
          },
          cancelButton(potId),
        ],
      };

    // 3단계 정산 중: 파티장용 버튼만 남깁니다.
    // (참여자의 "입금 완료" · "이상해요" 버튼은 채널이 아니라 각자 받은 DM에 있습니다.
    //  그래서 DM이 안 갔다면 재발송 버튼이 유일한 복구 수단입니다.)
    case POT_STATUS.SETTLING:
      return {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: ACTION.RESEND_DM,
            text: { type: 'plain_text', text: '📨 정산 DM 다시 보내기', emoji: true },
            value: potId,
          },
          {
            type: 'button',
            action_id: ACTION.FINISH,
            text: { type: 'plain_text', text: '✅ 정산 완료 처리 (파티장)', emoji: true },
            value: potId,
          },
          cancelButton(potId),
        ],
      };

    // 4단계 정산 완료: 잘못 끝난 경우를 위해 되돌리는 버튼과, 정말 끝났을 때
    // 완전히 잠그는 버튼을 함께 둡니다. 파티장이 직접 확인하고 골라야 합니다.
    case POT_STATUS.SETTLED:
      return {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: ACTION.REOPEN,
            text: { type: 'plain_text', text: '🔄 정산 다시 열기 (파티장)', emoji: true },
            value: potId,
          },
          {
            type: 'button',
            action_id: ACTION.FINALIZE,
            text: { type: 'plain_text', text: '🏁 정산 마무리 (파티장)', emoji: true },
            style: 'primary',
            value: potId,
          },
        ],
      };

    // 정산 마무리 · 취소됨: 더 이상 누를 게 없습니다.
    case POT_STATUS.FINALIZED:
    case POT_STATUS.CANCELLED:
    default:
      return null;
  }
}

// ── 참여자에게 보내는 정산 DM ────────────────────────────────────────────────

/** 이 사람의 입금 · 신고 상태. paid와 disputed가 동시에 true일 일은 없습니다(markPaid가 신고를 풀어줍니다). */
export type SettlementDmState = { paid: boolean; disputed: boolean };

/** 정산이 시작되면 참여자 각자에게 이 DM이 자동으로 갑니다. */
export function settlementDm(pot: Pot, amount: number, state: SettlementDmState): KnownBlock[] {
  const account = `${pot.bank_name} ${pot.account_number}\n예금주: ${pot.account_holder}`;

  const blocks: KnownBlock[] = [
    section(
      `💸 *${pot.title}* 정산 안내\n${mention(pot.organizer_id)} 님이 정산을 시작했어요.`,
    ),
    section(`*보낼 금액*\n*${formatWon(amount)}원*`),
    section(`*입금 계좌*\n\`\`\`${account}\`\`\``),
    context('계좌번호를 길게 눌러 복사하세요.'),
  ];

  if (state.paid) {
    // 이미 입금 완료를 누른 사람에게는 완료 표시와 함께 되돌리는 버튼을 줍니다.
    // (잘못 눌렀는데 되돌릴 방법이 없으면 파티장에게 따로 부탁하는 수밖에 없습니다)
    blocks.push(section('✅ *입금 완료로 표시했어요.* 고맙습니다!'));
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: ACTION.UNMARK_PAID,
          text: { type: 'plain_text', text: '↩️ 잘못 눌렀어요', emoji: true },
          value: String(pot.id),
        },
      ],
    });
  } else if (state.disputed) {
    // 금액이 이상하다고 신고한 사람에게는 그 사실을 알려주고, 신고를 취소하거나
    // (문의가 풀렸다면) 그대로 입금 완료를 누를 수 있게 둘 다 남겨둡니다.
    blocks.push(section('⚠️ *금액이 이상하다고 알렸어요.* 파티장이 확인하고 있어요.'));
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: ACTION.MARK_PAID,
          text: { type: 'plain_text', text: '✅ 입금했어요', emoji: true },
          style: 'primary',
          value: String(pot.id),
        },
        {
          type: 'button',
          action_id: ACTION.UNDISPUTE,
          text: { type: 'plain_text', text: '↩️ 신고 취소', emoji: true },
          value: String(pot.id),
        },
      ],
    });
  } else {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: ACTION.MARK_PAID,
          text: { type: 'plain_text', text: '✅ 입금했어요', emoji: true },
          style: 'primary',
          value: String(pot.id),
        },
        {
          type: 'button',
          action_id: ACTION.DISPUTE,
          text: { type: 'plain_text', text: '⚠️ 이상해요!', emoji: true },
          style: 'danger',
          value: String(pot.id),
        },
      ],
    });
  }

  return blocks;
}

// ── 모달 (팝업 입력창) ───────────────────────────────────────────────────────

/**
 * /점심팟 을 치면 뜨는 팟 만들기 모달.
 * 등록해둔 계좌가 있으면 계좌 칸을 미리 채워줍니다.
 */
export function createPotModal(channelId: string, savedAccount: Account | null): View {
  return {
    type: 'modal',
    callback_id: VIEW.CREATE_POT,
    // private_metadata: 모달에 몰래 실어 보내는 메모. 어느 채널에서 열었는지 기억해둡니다.
    private_metadata: channelId,
    title: { type: 'plain_text', text: '점심팟 모집' },
    submit: { type: 'plain_text', text: '모집 시작' },
    close: { type: 'plain_text', text: '취소' },
    blocks: [
      {
        type: 'input',
        block_id: FIELD.TITLE,
        label: { type: 'plain_text', text: '뭐 먹나요?' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: '예: 김치찌개 먹으러 갈 사람' },
        },
      },
      // 장소: 직접 입력이 아니라 정해진 두 곳 중에서만 고릅니다.
      {
        type: 'input',
        block_id: FIELD.PLACE,
        label: { type: 'plain_text', text: '어디서 모이나요?' },
        element: {
          type: 'static_select',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: '장소 선택' },
          options: PLACES.map((place) => ({
            text: { type: 'plain_text' as const, text: place },
            value: place,
          })),
        },
      },
      // 시간: 장소와 완전히 별개 칸입니다. 시간만 적습니다.
      {
        type: 'input',
        block_id: FIELD.MEET_AT,
        optional: true,
        label: { type: 'plain_text', text: '몇 시에 모이나요?' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: '예: 12:10' },
        },
      },
      {
        type: 'input',
        block_id: FIELD.CAPACITY,
        optional: true,
        label: { type: 'plain_text', text: '정원 (비우면 무제한)' },
        element: {
          type: 'number_input',
          action_id: 'value',
          is_decimal_allowed: false,
          min_value: '2',
        },
      },
      { type: 'divider' },
      ...accountInputs(savedAccount, '정산받을 계좌 (나중에 입력해도 돼요)'),
    ],
  };
}

/**
 * "정산 시작" 버튼을 누르면 뜨는 모달. 참여자별 금액과 최종 계좌를 확정합니다.
 * 팟을 만들 때 계좌를 적어뒀다면 그 값이, 없으면 등록해둔 계좌가 채워집니다.
 *
 * payers는 파티장을 뺀 참여자 목록입니다. 메뉴가 저마다 달라서 낼 금액도
 * 사람마다 다를 수 있으므로, 총액 한 칸 대신 참여자 한 명당 입력칸을 하나씩 만듭니다.
 * names는 슬랙 ID 대신 사람 이름을 라벨에 보여주기 위한 것으로, 모르면 ID 그대로 씁니다.
 */
export function startSettlementModal(
  pot: Pot,
  payers: Participant[],
  names: Map<string, string>,
  fallback: Account | null,
): View {
  const prefill: Account | null =
    pot.bank_name && pot.account_number
      ? {
          bank_name: pot.bank_name,
          account_number: pot.account_number,
          account_holder: pot.account_holder ?? '',
        }
      : fallback;

  return {
    type: 'modal',
    callback_id: VIEW.START_SETTLEMENT,
    private_metadata: String(pot.id), // 어느 팟의 정산인지 기억해둡니다.
    title: { type: 'plain_text', text: '정산 시작' },
    submit: { type: 'plain_text', text: 'DM 발송' },
    close: { type: 'plain_text', text: '취소' },
    blocks: [
      section(`*${pot.title}*\n참여자마다 보낼 금액을 입력하면 전원에게 계좌 DM이 갑니다.`),
      ...payers.map((p) => ({
        type: 'input' as const,
        block_id: amountBlockId(p.slack_user_id),
        label: { type: 'plain_text' as const, text: names.get(p.slack_user_id) ?? p.slack_user_id },
        element: {
          type: 'number_input' as const,
          action_id: 'value',
          is_decimal_allowed: false,
          min_value: '1',
        },
      })),
      { type: 'divider' },
      // 여기서는 계좌가 반드시 있어야 DM을 보낼 수 있으므로 필수 칸으로 만듭니다.
      // (선택으로 두면 "(옵션)"이라고 적혀 있는데 비우면 오류가 나서 앞뒤가 안 맞습니다.)
      ...accountInputs(prefill, '입금받을 계좌', /* required */ true),

      // 계좌를 저장할지 물어봅니다. 예전에는 묻지도 않고 저장했습니다.
      // 이미 등록해둔 사람은 기본으로 켜둡니다 — 한 번 동의했고, 계좌를 바꿔 적었다면
      // 갱신되는 게 자연스럽기 때문입니다.
      {
        type: 'input',
        block_id: FIELD.REMEMBER_ACCOUNT,
        optional: true,
        label: { type: 'plain_text', text: ' ' }, // 라벨 없이 체크박스만 보이게
        element: {
          type: 'checkboxes',
          action_id: 'value',
          ...(fallback ? { initial_options: [REMEMBER_ACCOUNT_OPTION] } : {}),
          options: [REMEMBER_ACCOUNT_OPTION],
        },
      },
    ],
  };
}

/** "다음에도 이 계좌 쓰기" 체크박스의 선택지. 켜둘 때와 목록에 둘 다 써서 상수로 뺍니다. */
const REMEMBER_ACCOUNT_OPTION = {
  text: { type: 'plain_text' as const, text: '이 계좌를 저장해서 다음 팟에도 자동으로 채우기' },
  value: 'remember',
};

/** /계좌등록 을 치면 뜨는 모달. 한 번 등록하면 다음 팟부터 자동으로 채워집니다. */
export function saveAccountModal(savedAccount: Account | null): View {
  return {
    type: 'modal',
    callback_id: VIEW.SAVE_ACCOUNT,
    title: { type: 'plain_text', text: '내 계좌 등록' },
    submit: { type: 'plain_text', text: '저장' },
    close: { type: 'plain_text', text: '취소' },
    blocks: [
      context('여기 등록해두면 다음부터 팟을 만들 때 계좌가 자동으로 채워져요.'),
      ...accountInputs(savedAccount, '계좌 정보', /* required */ true),
    ],
  };
}

/**
 * 은행/계좌번호/예금주 입력칸 3개를 만듭니다. 세 모달이 공통으로 씁니다.
 * initial_value를 넣으면 칸이 미리 채워진 상태로 열립니다.
 */
function accountInputs(
  saved: Account | null,
  heading: string,
  required = false,
): KnownBlock[] {
  const optional = !required;

  return [
    context(`*${heading}*`),
    {
      type: 'input',
      block_id: FIELD.BANK_NAME,
      optional,
      label: { type: 'plain_text', text: '은행' },
      element: {
        type: 'plain_text_input',
        action_id: 'value',
        initial_value: saved?.bank_name,
        placeholder: { type: 'plain_text', text: '예: 카카오뱅크' },
      },
    },
    {
      type: 'input',
      block_id: FIELD.ACCOUNT_NUMBER,
      optional,
      label: { type: 'plain_text', text: '계좌번호' },
      element: {
        type: 'plain_text_input',
        action_id: 'value',
        initial_value: saved?.account_number,
        placeholder: { type: 'plain_text', text: '예: 3333-01-1234567' },
      },
    },
    {
      type: 'input',
      block_id: FIELD.ACCOUNT_HOLDER,
      optional,
      label: { type: 'plain_text', text: '예금주' },
      element: {
        type: 'plain_text_input',
        action_id: 'value',
        initial_value: saved?.account_holder,
      },
    },
  ];
}
