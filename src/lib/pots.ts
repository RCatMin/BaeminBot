/**
 * 점심팟 도메인 로직.
 *
 * 슬랙봇(bot/)과 웹 대시보드(src/app/)가 이 파일의 함수만 호출합니다.
 * "누가 무엇을 할 수 있는지"에 대한 규칙은 전부 여기 모여 있습니다.
 */

import { getDb, now } from './db.ts';
import { POT_STATUS, canTransition, type PotStatus } from './status.ts';

// ── 타입 정의 ────────────────────────────────────────────────────────────────

export type Pot = {
  id: number;
  channel_id: string;
  message_ts: string | null;
  organizer_id: string;
  title: string;
  place: string | null;
  meet_at: string | null;
  capacity: number;
  status: PotStatus;
  bank_name: string | null;
  account_number: string | null;
  account_holder: string | null;
  total_amount: number | null;
  created_at: string;
  updated_at: string;
};

export type Participant = {
  pot_id: number;
  slack_user_id: string;
  joined_at: string;
  paid: number; // SQLite에는 true/false가 없어서 0 또는 1로 저장합니다.
  paid_at: string | null;
  dm_channel_id: string | null;
  dm_ts: string | null;
};

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
         (channel_id, organizer_id, title, place, meet_at, capacity, status,
          bank_name, account_number, account_holder, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.channelId,
      input.organizerId,
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

// ── 3단계: 정산 중 ──────────────────────────────────────────────────────────

/**
 * 정산을 시작합니다. 총 금액과 입금받을 계좌를 확정하고 상태를 SETTLING으로 옮깁니다.
 * (실제 DM 발송은 슬랙 API가 필요하므로 봇 쪽에서 처리합니다.)
 */
export function startSettlement(
  potId: number,
  actorId: string,
  totalAmount: number,
  account: Account,
): Result<Pot> {
  const pot = getPot(potId);
  if (!pot) return fail('이미 사라진 팟이에요.');
  if (pot.organizer_id !== actorId) return fail('파티장만 정산을 시작할 수 있어요.');
  if (!canTransition(pot.status, POT_STATUS.SETTLING)) {
    return fail('지금 단계에서는 정산을 시작할 수 없어요. (모집 완료 상태여야 해요)');
  }
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    return fail('총 금액은 0보다 큰 숫자여야 해요.');
  }

  getDb()
    .prepare(
      `UPDATE pots
          SET status = ?, total_amount = ?, bank_name = ?, account_number = ?, account_holder = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(
      POT_STATUS.SETTLING,
      Math.round(totalAmount),
      account.bank_name,
      account.account_number,
      account.account_holder,
      now(),
      potId,
    );

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

  getDb()
    .prepare(`UPDATE participants SET paid = ?, paid_at = ? WHERE pot_id = ? AND slack_user_id = ?`)
    .run(paid ? 1 : 0, paid ? now() : null, potId, slackUserId);
  touch(potId);

  const participants = getParticipants(potId);
  // 파티장은 자기 자신에게 입금할 필요가 없으니 계산에서 뺍니다.
  const payers = participants.filter((p) => p.slack_user_id !== pot.organizer_id);
  const allPaid = payers.length > 0 && payers.every((p) => p.paid === 1);

  return ok({ pot: getPot(potId)!, allPaid });
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

/**
 * 1인당 낼 금액을 계산합니다.
 * 파티장을 뺀 나머지 인원이 N명이면, 총 금액을 (N+1)로 나눕니다. (파티장 몫도 포함)
 * 10원 단위로 올림해서 "1원 남는" 상황을 피합니다.
 */
export function amountPerPerson(totalAmount: number, headcount: number): number {
  if (headcount <= 0) return 0;
  return Math.ceil(totalAmount / headcount / 10) * 10;
}

/** 12345 → "12,345" */
export function formatWon(amount: number): string {
  return amount.toLocaleString('ko-KR');
}
