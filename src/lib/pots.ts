/**
 * 점심팟 도메인 로직.
 *
 * 슬랙봇(bot/)과 웹 대시보드(src/app/)가 이 파일의 함수만 호출합니다.
 * "누가 무엇을 할 수 있는지"에 대한 규칙은 전부 여기 모여 있습니다.
 */

import { getDb, now } from './db.ts';
import { POT_STATUS, canTransition, type PotStatus } from './status.ts';

// ── 타입 정의 ────────────────────────────────────────────────────────────────

/** 팟의 종류. 배달·외식은 4단계 흐름을 그대로 쓰고, 내기는 정산 없이 추첨만 합니다. */
export const POT_TYPE = {
  DELIVERY: 'DELIVERY', // /배달 — 정해진 층 중에서 고름
  DINE_OUT: 'DINE_OUT', // /외식 — 가게 이름·주소를 직접 입력
  BET: 'BET', // /내기빵 — 참가자 중 한 명을 뽑아 정함 (돈은 안 걷음)
} as const;

export type PotType = (typeof POT_TYPE)[keyof typeof POT_TYPE];

export type Pot = {
  id: number;
  channel_id: string;
  message_ts: string | null;
  organizer_id: string;
  pot_type: PotType;
  title: string;
  place: string | null;
  meet_at: string | null;
  capacity: number;
  status: PotStatus;
  bank_name: string | null;
  account_number: string | null;
  account_holder: string | null;
  total_amount: number | null;
  winner_id: string | null;
  created_at: string;
  updated_at: string;
};

export type Participant = {
  pot_id: number;
  slack_user_id: string;
  joined_at: string;
  amount: number | null; // 이 사람이 보낼 금액. 정산 시작 전에는 null.
  paid: number; // SQLite에는 true/false가 없어서 0 또는 1로 저장합니다.
  paid_at: string | null;
  disputed: number; // 0=평범, 1="금액이 이상해요" 신고 중
  dm_channel_id: string | null;
  dm_ts: string | null;
};

/** 정산 시작할 때 한 사람에게 매길 금액. */
export type ParticipantAmount = { slackUserId: string; amount: number };

export type Account = {
  bank_name: string;
  account_number: string;
  account_holder: string;
};

/**
 * 작업 결과를 담는 공통 형태.
 * 실패해도 예외를 던지지 않고 { ok: false, error: '사유' }를 돌려주기 때문에,
 * 슬랙 핸들러에서 사용자에게 그 사유를 그대로 보여주기 편합니다.
 */
export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });

// ── 계좌 (users 테이블) ──────────────────────────────────────────────────────

/** 등록해둔 계좌를 가져옵니다. 등록한 적 없으면 null. */
export function getAccount(slackUserId: string): Account | null {
  const row = getDb()
    .prepare(
      `SELECT bank_name, account_number, account_holder FROM users WHERE slack_user_id = ?`,
    )
    .get(slackUserId) as Account | undefined;

  // 행은 있는데 계좌 칸이 비어 있을 수도 있으므로 한 번 더 확인합니다.
  if (!row?.bank_name || !row?.account_number) return null;
  return row;
}

/** 계좌를 등록하거나 덮어씁니다. */
export function saveAccount(
  slackUserId: string,
  displayName: string | null,
  account: Account,
): void {
  getDb()
    .prepare(
      `INSERT INTO users (slack_user_id, display_name, bank_name, account_number, account_holder, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(slack_user_id) DO UPDATE SET
         -- COALESCE 를 쓰는 이유: 정산 시작 때 계좌만 저장하면서 이름을 null 로
         -- 넘기는 자리가 있는데, 그대로 덮어쓰면 알아둔 이름이 지워집니다.
         display_name   = COALESCE(excluded.display_name, users.display_name),
         bank_name      = excluded.bank_name,
         account_number = excluded.account_number,
         account_holder = excluded.account_holder,
         updated_at     = excluded.updated_at`,
    )
    .run(
      slackUserId,
      displayName,
      account.bank_name,
      account.account_number,
      account.account_holder,
      now(),
    );
}

// ── 사용자 이름 ─────────────────────────────────────────────────────────────

/**
 * 슬랙 사용자의 표시 이름을 기억해둡니다.
 *
 * 대시보드가 슬랙에 직접 물어보게 하면 화면을 그릴 때마다 네트워크를 타야 합니다.
 * 대신 봇이 사람을 마주칠 때마다 여기에 적어두고, 대시보드는 읽기만 합니다.
 */
export function rememberUserName(slackUserId: string, displayName: string): void {
  getDb()
    .prepare(
      `INSERT INTO users (slack_user_id, display_name, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(slack_user_id) DO UPDATE SET
         display_name = excluded.display_name,
         updated_at   = excluded.updated_at`,
    )
    .run(slackUserId, displayName, now());
}

/** 알고 있는 이름을 전부 가져옵니다. 대시보드가 한 번에 읽어 쓰는 용도입니다. */
export function getUserNames(): Map<string, string> {
  const rows = getDb()
    .prepare(`SELECT slack_user_id, display_name FROM users WHERE display_name IS NOT NULL`)
    .all() as unknown as { slack_user_id: string; display_name: string }[];

  return new Map(rows.map((r) => [r.slack_user_id, r.display_name]));
}

/**
 * 아직 이름을 모르는 사용자 ID 목록.
 * 봇이 시작할 때 이걸 보고 슬랙에 이름을 물어봅니다. (예전 기록까지 채우려고)
 */
export function listUnnamedUserIds(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT id FROM (
         SELECT slack_user_id AS id FROM participants
         UNION
         SELECT organizer_id AS id FROM pots
       )
       WHERE id NOT IN (SELECT slack_user_id FROM users WHERE display_name IS NOT NULL)`,
    )
    .all() as unknown as { id: string }[];

  return rows.map((r) => r.id);
}

// ── 팟 조회 ─────────────────────────────────────────────────────────────────

export function getPot(id: number): Pot | null {
  return (getDb().prepare(`SELECT * FROM pots WHERE id = ?`).get(id) as Pot | undefined) ?? null;
}

/** 대시보드용: 최근 팟부터 전부 가져옵니다. (최신순) */
export function listPots(limit = 50): Pot[] {
  return getDb()
    .prepare(`SELECT * FROM pots ORDER BY id DESC LIMIT ?`)
    .all(limit) as unknown as Pot[];
}

/**
 * 특정 날짜(YYYY-MM-DD, 한국 시간 기준)에 만들어진 팟만 가져옵니다.
 *
 * created_at은 UTC로 저장돼 있어서 그냥 date()로 자르면 자정 근처 팟이
 * 하루 밀릴 수 있습니다. '+9 hours'로 한국 시간으로 옮긴 뒤 날짜를 뗍니다.
 */
export function listPotsByDate(date: string): Pot[] {
  return getDb()
    .prepare(
      `SELECT * FROM pots WHERE date(created_at, '+9 hours') = ? ORDER BY id DESC`,
    )
    .all(date) as unknown as Pot[];
}

/**
 * 팟이 있었던 날짜 목록을 최신순으로 가져옵니다. (한국 시간 기준)
 * 대시보드의 날짜 선택 목록을 채우는 용도입니다.
 */
export function listPotDates(): { date: string; count: number }[] {
  const rows = getDb()
    .prepare(
      `SELECT date(created_at, '+9 hours') AS date, COUNT(*) AS count
         FROM pots
        GROUP BY date
        ORDER BY date DESC`,
    )
    .all() as unknown as { date: string; count: number }[];

  // node:sqlite 가 돌려주는 행은 프로토타입이 null 이라, 서버 컴포넌트에서
  // 클라이언트 컴포넌트로 그대로 넘기면 Next.js가 직렬화를 거부합니다.
  // { ...row } 로 평범한 객체로 바꿔서 넘깁니다.
  return rows.map((r) => ({ ...r }));
}

export function getParticipants(potId: number): Participant[] {
  return getDb()
    .prepare(`SELECT * FROM participants WHERE pot_id = ? ORDER BY joined_at ASC`)
    .all(potId) as unknown as Participant[];
}

export function isParticipant(potId: number, slackUserId: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 AS hit FROM participants WHERE pot_id = ? AND slack_user_id = ?`)
    .get(potId, slackUserId);
  return row !== undefined;
}

// ── 1단계: 팟 만들기 (모집중) ────────────────────────────────────────────────

export type CreatePotInput = {
  channelId: string;
  organizerId: string;
  potType: PotType;
  title: string;
  place: string | null;
  meetAt: string | null;
  capacity: number; // 0이면 무제한
  account: Account | null; // 팟 만들 때 계좌를 같이 받아둘 수 있습니다.
};

/**
 * 팟을 만들고, 파티장을 첫 참여자로 자동 등록합니다.
 * 시작 상태는 언제나 RECRUITING(모집중)입니다.
 */
export function createPot(input: CreatePotInput): Pot {
  const db = getDb();
  const timestamp = now();

  const info = db
    .prepare(
      `INSERT INTO pots
         (channel_id, organizer_id, pot_type, title, place, meet_at, capacity, status,
          bank_name, account_number, account_holder, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.channelId,
      input.organizerId,
      input.potType,
      input.title,
      input.place,
      input.meetAt,
      input.capacity,
      POT_STATUS.RECRUITING,
      input.account?.bank_name ?? null,
      input.account?.account_number ?? null,
      input.account?.account_holder ?? null,
      timestamp,
      timestamp,
    );

  const potId = Number(info.lastInsertRowid);

  // 파티장은 자동으로 참여자에 포함됩니다. (본인도 밥을 먹으니까요)
  db.prepare(
    `INSERT INTO participants (pot_id, slack_user_id, joined_at) VALUES (?, ?, ?)`,
  ).run(potId, input.organizerId, timestamp);

  return getPot(potId)!;
}

/**
 * 팟을 지웁니다. 참여자 기록도 함께 사라집니다(ON DELETE CASCADE).
 *
 * 지금은 "만들다가 실패했을 때 되돌리는 용도"로만 씁니다.
 * 채널에 모집 메시지를 못 올리면 버튼이 하나도 없는 팟이 남는데,
 * 그런 팟은 참여도 마감도 정산도 할 수 없어서 아예 없애는 편이 낫습니다.
 */
export function deletePot(potId: number): void {
  getDb().prepare(`DELETE FROM pots WHERE id = ?`).run(potId);
}

/** 슬랙에 메시지를 보낸 뒤, 그 메시지 주소를 팟에 기록합니다. */
export function setPotMessage(potId: number, messageTs: string): void {
  getDb()
    .prepare(`UPDATE pots SET message_ts = ?, updated_at = ? WHERE id = ?`)
    .run(messageTs, now(), potId);
}

// ── 참여 / 참여 취소 ─────────────────────────────────────────────────────────

/** 팟에 참여합니다. 모집중일 때만 가능하고, 정원이 차면 거절됩니다. */
export function joinPot(potId: number, slackUserId: string): Result<Pot> {
  const pot = getPot(potId);
  if (!pot) return fail('이미 사라진 팟이에요.');
  if (pot.status === POT_STATUS.CANCELLED) return fail('취소된 팟이에요.');
  if (pot.status !== POT_STATUS.RECRUITING) return fail('모집이 끝난 팟이에요.');
  if (isParticipant(potId, slackUserId)) return fail('이미 참여 중이에요.');

  const count = getParticipants(potId).length;
  if (pot.capacity > 0 && count >= pot.capacity) return fail('정원이 다 찼어요.');

  getDb()
    .prepare(`INSERT INTO participants (pot_id, slack_user_id, joined_at) VALUES (?, ?, ?)`)
    .run(potId, slackUserId, now());
  touch(potId);

  return ok(getPot(potId)!);
}

/** 참여를 취소합니다. 파티장은 취소할 수 없습니다(팟이 사라져 버리니까). */
export function leavePot(potId: number, slackUserId: string): Result<Pot> {
  const pot = getPot(potId);
  if (!pot) return fail('이미 사라진 팟이에요.');
  if (pot.status === POT_STATUS.CANCELLED) return fail('취소된 팟이에요.');
  if (pot.status !== POT_STATUS.RECRUITING) return fail('모집이 끝나서 취소할 수 없어요.');
  if (pot.organizer_id === slackUserId) return fail('파티장은 참여를 취소할 수 없어요.');
  if (!isParticipant(potId, slackUserId)) return fail('참여하지 않은 팟이에요.');

  getDb()
    .prepare(`DELETE FROM participants WHERE pot_id = ? AND slack_user_id = ?`)
    .run(potId, slackUserId);
  touch(potId);

  return ok(getPot(potId)!);
}

// ── 2단계: 모집 완료 ────────────────────────────────────────────────────────

/** 모집을 마감합니다. 파티장만 할 수 있습니다. */
export function closePot(potId: number, actorId: string): Result<Pot> {
  return advance(potId, actorId, POT_STATUS.CLOSED);
}

/**
 * 내기(BET) 참가자 중 한 명을 무작위로 뽑습니다. 파티장만 할 수 있고,
 * 모집중 상태에서만 가능합니다. (👉 "🎲 추첨하기" 버튼)
 *
 * 정산이 없는 대신, 최소 2명은 있어야 내기가 성립한다고 보고 막아둡니다.
 */
export function drawWinner(potId: number, actorId: string): Result<{ pot: Pot; winnerId: string }> {
  const pot = getPot(potId);
  if (!pot) return fail('이미 사라진 팟이에요.');
  if (pot.organizer_id !== actorId) return fail('파티장만 추첨할 수 있어요.');
  if (!canTransition(pot.status, POT_STATUS.DRAWN)) {
    return fail('지금 단계에서는 추첨할 수 없어요.');
  }

  const participants = getParticipants(potId);
  if (participants.length < 2) return fail('최소 2명은 있어야 추첨할 수 있어요.');

  const winner = participants[Math.floor(Math.random() * participants.length)];

  getDb()
    .prepare(`UPDATE pots SET status = ?, winner_id = ?, updated_at = ? WHERE id = ?`)
    .run(POT_STATUS.DRAWN, winner.slack_user_id, now(), potId);

  return ok({ pot: getPot(potId)!, winnerId: winner.slack_user_id });
}

/**
 * 정산 없이 끝냅니다. 파티장만 할 수 있고, 모집 완료 상태에서만 고를 수 있습니다.
 *
 * 각자 계산하는 식당처럼 봇으로 돈을 모을 필요가 없을 때 씁니다. 취소와 달리
 * 약속 자체는 잘 끝났다는 뜻이라 상태를 따로 둡니다(CANCELLED와 구분).
 */
export function finishWithoutSettlement(potId: number, actorId: string): Result<Pot> {
  return advance(potId, actorId, POT_STATUS.NO_SETTLEMENT);
}

// ── 3단계: 정산 중 ──────────────────────────────────────────────────────────

/**
 * 정산을 시작합니다. 참여자별 금액과 입금받을 계좌를 확정하고 상태를 SETTLING으로 옮깁니다.
 * (실제 DM 발송은 슬랙 API가 필요하므로 봇 쪽에서 처리합니다.)
 *
 * 메뉴가 저마다 달라서 낼 금액도 사람마다 다를 수 있으므로, 총액을 똑같이 나누는 대신
 * 파티장이 참여자 한 명 한 명에게 얼마씩 매길지 직접 입력받습니다.
 * (파티장 자신은 자기한테 송금하지 않으므로 amounts에 넣지 않아도 됩니다.)
 */
export function startSettlement(
  potId: number,
  actorId: string,
  amounts: ParticipantAmount[],
  account: Account,
): Result<Pot> {
  const pot = getPot(potId);
  if (!pot) return fail('이미 사라진 팟이에요.');
  if (pot.organizer_id !== actorId) return fail('파티장만 정산을 시작할 수 있어요.');
  if (!canTransition(pot.status, POT_STATUS.SETTLING)) {
    return fail('지금 단계에서는 정산을 시작할 수 없어요. (모집 완료 상태여야 해요)');
  }

  // 파티장을 뺀 참여자 전원에게 0보다 큰 금액이 매겨져 있어야 합니다.
  // (모달을 열 때와 제출할 때 사이에 참여자가 바뀔 일은 없지만 — 마감 이후로는 참여가
  //  막혀 있습니다 — 혹시 모를 어긋남을 여기서도 한 번 더 막습니다)
  const payers = getParticipants(potId).filter((p) => p.slack_user_id !== pot.organizer_id);
  const amountById = new Map(amounts.map((a) => [a.slackUserId, a.amount]));

  for (const payer of payers) {
    const amount = amountById.get(payer.slack_user_id);
    if (!Number.isFinite(amount) || (amount as number) <= 0) {
      return fail('참여자 전원의 금액을 0보다 크게 입력해 주세요.');
    }
  }

  const db = getDb();
  const total = payers.reduce((sum, p) => sum + Math.round(amountById.get(p.slack_user_id)!), 0);

  db.prepare(
    `UPDATE pots
        SET status = ?, total_amount = ?, bank_name = ?, account_number = ?, account_holder = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    POT_STATUS.SETTLING,
    total,
    account.bank_name,
    account.account_number,
    account.account_holder,
    now(),
    potId,
  );

  for (const payer of payers) {
    db.prepare(`UPDATE participants SET amount = ? WHERE pot_id = ? AND slack_user_id = ?`).run(
      Math.round(amountById.get(payer.slack_user_id)!),
      potId,
      payer.slack_user_id,
    );
  }

  return ok(getPot(potId)!);
}

/** 정산 DM을 보낸 뒤, 나중에 그 DM을 수정할 수 있도록 주소를 기록합니다. */
export function setDmRef(
  potId: number,
  slackUserId: string,
  dmChannelId: string,
  dmTs: string,
): void {
  getDb()
    .prepare(
      `UPDATE participants SET dm_channel_id = ?, dm_ts = ? WHERE pot_id = ? AND slack_user_id = ?`,
    )
    .run(dmChannelId, dmTs, potId, slackUserId);
}

/**
 * 입금 완료로 표시합니다.
 * 이걸로 전원이 입금 완료가 되면 allPaid가 true로 돌아오고,
 * 봇이 그걸 보고 4단계(정산 완료)로 자동 전환합니다.
 *
 * 입금 완료로 표시하면 "이상해요" 신고는 자동으로 풀립니다 — 돈을 보냈다는 건
 * 금액에 대한 의문이 풀렸다는 뜻이라고 보기 때문입니다.
 */
export function markPaid(
  potId: number,
  slackUserId: string,
  paid: boolean,
): Result<{ pot: Pot; allPaid: boolean }> {
  const pot = getPot(potId);
  if (!pot) return fail('이미 사라진 팟이에요.');
  if (pot.status !== POT_STATUS.SETTLING) return fail('지금은 정산 중인 팟이 아니에요.');
  if (!isParticipant(potId, slackUserId)) return fail('참여하지 않은 팟이에요.');

  if (paid) {
    getDb()
      .prepare(
        `UPDATE participants SET paid = 1, paid_at = ?, disputed = 0 WHERE pot_id = ? AND slack_user_id = ?`,
      )
      .run(now(), potId, slackUserId);
  } else {
    getDb()
      .prepare(`UPDATE participants SET paid = 0, paid_at = NULL WHERE pot_id = ? AND slack_user_id = ?`)
      .run(potId, slackUserId);
  }
  touch(potId);

  const participants = getParticipants(potId);
  // 파티장은 자기 자신에게 입금할 필요가 없으니 계산에서 뺍니다.
  const payers = participants.filter((p) => p.slack_user_id !== pot.organizer_id);
  const allPaid = payers.length > 0 && payers.every((p) => p.paid === 1);

  return ok({ pot: getPot(potId)!, allPaid });
}

/**
 * 정산 금액이 이상하다고 신고하거나, 그 신고를 취소합니다.
 *
 * 왜 필요한가: 참여자마다 금액이 달라지면서, "왜 내가 이만큼 내야 하지?"라는 의문이
 * 생길 수 있습니다. 참여자가 직접 파티장에게 물어볼 수 있게 하는 대신, 신고 버튼을 눌러
 * 파티장에게 바로 알리고 파티장이 정산을 다시 열거나 금액을 조정하게 합니다.
 */
export function markDisputed(
  potId: number,
  slackUserId: string,
  disputed: boolean,
): Result<Pot> {
  const pot = getPot(potId);
  if (!pot) return fail('이미 사라진 팟이에요.');
  if (pot.status !== POT_STATUS.SETTLING) return fail('지금은 정산 중인 팟이 아니에요.');
  if (!isParticipant(potId, slackUserId)) return fail('참여하지 않은 팟이에요.');

  getDb()
    .prepare(`UPDATE participants SET disputed = ? WHERE pot_id = ? AND slack_user_id = ?`)
    .run(disputed ? 1 : 0, potId, slackUserId);
  touch(potId);

  return ok(getPot(potId)!);
}

// ── 4단계: 정산 완료 ────────────────────────────────────────────────────────

/** 정산을 마무리합니다. 전원 입금 시 봇이 자동 호출하고, 파티장이 수동으로도 누를 수 있습니다. */
export function finishSettlement(potId: number, actorId: string): Result<Pot> {
  return advance(potId, actorId, POT_STATUS.SETTLED);
}

/**
 * 정산 완료된 팟을 다시 정산 중으로 되돌립니다. 파티장만 할 수 있습니다.
 *
 * 왜 필요한가: 마지막 사람이 "입금했어요"를 잘못 누르면 전원 완료로 판정되어
 * 팟이 곧바로 정산 완료로 넘어갑니다. 실제로는 돈이 안 들어왔는데 끝난 것으로
 * 남으므로, 파티장이 되돌릴 수 있어야 합니다.
 *
 * 이건 규칙표(ALLOWED_TRANSITIONS)를 타지 않는 의도적인 예외입니다.
 * 규칙표에 넣으면 "정산 완료의 다음 단계는 정산 중"인 것처럼 보여서
 * 앞으로 가는 흐름이 헷갈리기 때문에 여기서 직접 처리합니다.
 */
export function reopenSettlement(potId: number, actorId: string): Result<Pot> {
  const pot = getPot(potId);
  if (!pot) return fail('이미 사라진 팟이에요.');
  if (pot.organizer_id !== actorId) return fail('파티장만 다시 열 수 있어요.');
  if (pot.status !== POT_STATUS.SETTLED) {
    return fail('정산 완료된 팟만 다시 열 수 있어요.');
  }

  getDb()
    .prepare(`UPDATE pots SET status = ?, updated_at = ? WHERE id = ?`)
    .run(POT_STATUS.SETTLING, now(), potId);

  return ok(getPot(potId)!);
}

/**
 * 정산을 완전히 마무리합니다. 이후로는 되돌릴 수 없습니다(reopenSettlement는 SETTLED
 * 상태에서만 동작하므로 FINALIZED에서는 막힙니다).
 *
 * 왜 필요한가: "정산 완료"만으로는 아직 파티장이 다시 열 수 있는 여지가 남아 있어서,
 * 정말로 다 끝났다는 확정 짓는 동작이 따로 필요합니다. 이걸 눌러야 계좌번호도 지워지기
 * 시작합니다.
 */
export function finalizeSettlement(potId: number, actorId: string): Result<Pot> {
  return advance(potId, actorId, POT_STATUS.FINALIZED);
}

// ── 계좌번호 보관 기간 ──────────────────────────────────────────────────────

/**
 * 끝난 팟(정산 마무리 · 취소됨)에서 계좌번호를 지웁니다.
 *
 * 왜: 끝난 일의 계좌번호를 계속 들고 있을 이유가 없습니다. DB 파일을 복사하거나
 * 백업하면 그대로 따라가므로, 안 갖고 있는 게 가장 확실한 보호입니다.
 * 금액 · 참여자 · 입금 기록은 그대로 두어서 대시보드는 변함이 없습니다.
 *
 * 정산 완료(SETTLED)는 아직 대상이 아닙니다. 파티장이 "🔄 정산 다시 열기"로
 * 되돌릴 수 있는 단계라, 계좌를 지우면 그 길이 막힙니다. 계좌는 "🏁 정산 마무리"를
 * 눌러 더 이상 되돌릴 수 없게 된 뒤에야 지웁니다.
 *
 * "🙋 정산 없이 종료"도 같이 지웁니다 — 정산은 안 했어도, 팟을 만들 때 계좌를
 * 미리 적어뒀을 수 있어서(계좌 칸은 선택 사항입니다) 이 상태에도 계좌가 남아 있을 수 있습니다.
 *
 * graceHours 동안은 건드리지 않습니다. 마무리 직후 바로 지우기보다는 약간의
 * 여유를 두는 편이 안전합니다.
 *
 * @returns 지운 팟 개수
 */
export function purgeFinishedAccounts(graceHours = 24): number {
  const cutoff = new Date(Date.now() - graceHours * 60 * 60 * 1000).toISOString();

  const info = getDb()
    .prepare(
      `UPDATE pots
          SET bank_name = NULL, account_number = NULL, account_holder = NULL
        WHERE status IN (?, ?, ?)
          AND updated_at < ?
          AND account_number IS NOT NULL`,
    )
    .run(POT_STATUS.FINALIZED, POT_STATUS.CANCELLED, POT_STATUS.NO_SETTLEMENT, cutoff);

  return Number(info.changes);
}

// ── 취소 (4단계 흐름 바깥) ──────────────────────────────────────────────────

/**
 * 팟을 취소합니다. 파티장만, 그리고 정산이 끝나기 전까지만 가능합니다.
 *
 * 기록은 남깁니다. 지워버리면 누가 왜 취소했는지 알 수 없고,
 * 실수로 눌렀을 때 되짚어볼 방법도 사라집니다.
 */
export function cancelPot(potId: number, actorId: string): Result<Pot> {
  return advance(potId, actorId, POT_STATUS.CANCELLED);
}

// ── 공통 도우미 ─────────────────────────────────────────────────────────────

/**
 * 상태를 한 칸 옮기는 공통 함수.
 * 1) 팟이 있는지 2) 파티장이 맞는지 3) 규칙상 갈 수 있는 상태인지 를 모두 확인합니다.
 */
function advance(potId: number, actorId: string, to: PotStatus): Result<Pot> {
  const pot = getPot(potId);
  if (!pot) return fail('이미 사라진 팟이에요.');
  if (pot.organizer_id !== actorId) return fail('파티장만 할 수 있는 동작이에요.');
  if (!canTransition(pot.status, to)) return fail('지금 단계에서는 할 수 없는 동작이에요.');

  getDb().prepare(`UPDATE pots SET status = ?, updated_at = ? WHERE id = ?`).run(to, now(), potId);
  return ok(getPot(potId)!);
}

/** 팟이 마지막으로 바뀐 시각만 갱신합니다. */
function touch(potId: number): void {
  getDb().prepare(`UPDATE pots SET updated_at = ? WHERE id = ?`).run(now(), potId);
}

/** 12345 → "12,345" */
export function formatWon(amount: number): string {
  return amount.toLocaleString('ko-KR');
}
