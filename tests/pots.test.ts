/**
 * 팟 도메인 규칙 테스트 — 누가 무엇을 할 수 있는지.
 *
 * 그동안 고칠 때마다 슬랙에서 직접 눌러 확인하던 것들을 여기로 옮겼습니다.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { TEST_ACCOUNT, setUpTempDb } from './helpers.ts';

// pots.ts 를 불러오기 전에 임시 DB로 돌려놓아야 합니다.
setUpTempDb();
const P = await import('../src/lib/pots.ts');
const { POT_STATUS } = await import('../src/lib/status.ts');

const LEADER = 'U_LEADER';
const OTHER = 'U_OTHER';

/** 테스트용 팟을 하나 만듭니다. */
function newPot(capacity = 0) {
  return P.createPot({
    channelId: 'C_TEST',
    organizerId: LEADER,
    title: '테스트 팟',
    place: '1F',
    meetAt: '12:00',
    capacity,
    account: null,
  });
}

/** 정산 중 단계까지 진행한 팟을 만듭니다. 참여자는 OTHER 한 명, 낼 금액은 amount. */
function potInSettling(amount = 30000) {
  const pot = newPot();
  P.joinPot(pot.id, OTHER);
  P.closePot(pot.id, LEADER);
  P.startSettlement(pot.id, LEADER, [{ slackUserId: OTHER, amount }], TEST_ACCOUNT);
  return P.getPot(pot.id)!;
}

describe('1단계 · 팟 만들기', () => {
  test('만들면 모집중 상태로 시작한다', () => {
    assert.equal(newPot().status, POT_STATUS.RECRUITING);
  });

  test('파티장은 자동으로 참여자에 들어간다', () => {
    const pot = newPot();
    const ids = P.getParticipants(pot.id).map((p) => p.slack_user_id);
    assert.deepEqual(ids, [LEADER]);
  });
});

describe('1단계 · 참여와 취소', () => {
  test('참여할 수 있다', () => {
    const pot = newPot();
    assert.ok(P.joinPot(pot.id, OTHER).ok);
    assert.equal(P.getParticipants(pot.id).length, 2);
  });

  test('같은 사람이 두 번 참여할 수 없다', () => {
    const pot = newPot();
    P.joinPot(pot.id, OTHER);
    const again = P.joinPot(pot.id, OTHER);
    assert.ok(!again.ok);
  });

  test('정원이 차면 더 못 들어온다', () => {
    const pot = newPot(2); // 파티장 포함 2명
    assert.ok(P.joinPot(pot.id, 'U_A').ok);
    const full = P.joinPot(pot.id, 'U_B');
    assert.ok(!full.ok);
    assert.match(full.error, /정원/);
  });

  test('정원 0은 무제한', () => {
    const pot = newPot(0);
    for (const id of ['U_A', 'U_B', 'U_C', 'U_D']) {
      assert.ok(P.joinPot(pot.id, id).ok);
    }
  });

  test('파티장은 빠질 수 없다 — 팟이 주인 없이 남는다', () => {
    const pot = newPot();
    const result = P.leavePot(pot.id, LEADER);
    assert.ok(!result.ok);
    assert.match(result.error, /파티장/);
  });

  test('참여하지 않은 사람은 뺄 것도 없다', () => {
    const pot = newPot();
    assert.ok(!P.leavePot(pot.id, 'U_STRANGER').ok);
  });

  test('없는 팟에 참여하면 거절된다 (오류를 던지지 않는다)', () => {
    // 실제로 버그가 있던 자리입니다. DB를 비운 뒤 옛 메시지의 버튼을 누르면
    // 예전에는 봇이 TypeError 를 던졌습니다.
    const result = P.joinPot(999999, OTHER);
    assert.ok(!result.ok);
    assert.equal(P.getPot(999999), null);
  });
});

describe('2단계 · 모집 마감', () => {
  test('파티장만 마감할 수 있다', () => {
    const pot = newPot();
    assert.ok(!P.closePot(pot.id, OTHER).ok);
    assert.ok(P.closePot(pot.id, LEADER).ok);
  });

  test('마감하면 더 이상 참여할 수 없다', () => {
    const pot = newPot();
    P.closePot(pot.id, LEADER);
    assert.ok(!P.joinPot(pot.id, OTHER).ok);
  });

  test('두 번 마감할 수 없다', () => {
    const pot = newPot();
    P.closePot(pot.id, LEADER);
    assert.ok(!P.closePot(pot.id, LEADER).ok);
  });
});

describe('3단계 · 정산 시작', () => {
  test('파티장만 시작할 수 있다', () => {
    const pot = newPot();
    P.closePot(pot.id, LEADER);
    assert.ok(!P.startSettlement(pot.id, OTHER, [], TEST_ACCOUNT).ok);
  });

  test('모집중인 팟은 바로 정산할 수 없다 (마감이 먼저)', () => {
    const pot = newPot();
    assert.ok(!P.startSettlement(pot.id, LEADER, [], TEST_ACCOUNT).ok);
  });

  test('참여자 금액은 0보다 커야 한다', () => {
    const pot = newPot();
    P.joinPot(pot.id, OTHER);
    P.closePot(pot.id, LEADER);
    for (const bad of [0, -1000, Number.NaN]) {
      const result = P.startSettlement(pot.id, LEADER, [{ slackUserId: OTHER, amount: bad }], TEST_ACCOUNT);
      assert.ok(!result.ok, `${bad} 은 거절돼야 함`);
    }
  });

  test('참여자 중 금액을 안 적은 사람이 있으면 거절된다', () => {
    const pot = newPot();
    P.joinPot(pot.id, 'U_A');
    P.joinPot(pot.id, 'U_B');
    P.closePot(pot.id, LEADER);
    // U_B 금액이 빠졌습니다.
    const result = P.startSettlement(pot.id, LEADER, [{ slackUserId: 'U_A', amount: 10000 }], TEST_ACCOUNT);
    assert.ok(!result.ok);
  });

  test('참여자마다 다른 금액을 매길 수 있고, 총액은 그 합이다', () => {
    const pot = newPot();
    P.joinPot(pot.id, 'U_A');
    P.joinPot(pot.id, 'U_B');
    P.closePot(pot.id, LEADER);

    const result = P.startSettlement(
      pot.id,
      LEADER,
      [
        { slackUserId: 'U_A', amount: 12000 },
        { slackUserId: 'U_B', amount: 8000 },
      ],
      TEST_ACCOUNT,
    );
    assert.ok(result.ok);
    assert.equal(result.value.total_amount, 20000);

    const participants = P.getParticipants(pot.id);
    assert.equal(participants.find((p) => p.slack_user_id === 'U_A')!.amount, 12000);
    assert.equal(participants.find((p) => p.slack_user_id === 'U_B')!.amount, 8000);
  });

  test('시작하면 금액과 계좌가 팟에 저장된다', () => {
    const pot = potInSettling(45000);
    assert.equal(pot.status, POT_STATUS.SETTLING);
    assert.equal(pot.total_amount, 45000);
    assert.equal(pot.account_number, TEST_ACCOUNT.account_number);
  });
});

describe('3단계 · 입금 표시', () => {
  test('입금 표시와 되돌리기가 모두 된다', () => {
    const pot = potInSettling();
    assert.ok(P.markPaid(pot.id, OTHER, true).ok);
    assert.equal(P.getParticipants(pot.id).find((p) => p.slack_user_id === OTHER)!.paid, 1);

    assert.ok(P.markPaid(pot.id, OTHER, false).ok);
    assert.equal(P.getParticipants(pot.id).find((p) => p.slack_user_id === OTHER)!.paid, 0);
  });

  test('참여하지 않은 사람은 입금 표시를 할 수 없다', () => {
    const pot = potInSettling();
    assert.ok(!P.markPaid(pot.id, 'U_STRANGER', true).ok);
  });

  test('파티장을 뺀 전원이 내야 allPaid 가 된다', () => {
    const pot = newPot();
    P.joinPot(pot.id, 'U_A');
    P.joinPot(pot.id, 'U_B');
    P.closePot(pot.id, LEADER);
    P.startSettlement(
      pot.id,
      LEADER,
      [
        { slackUserId: 'U_A', amount: 15000 },
        { slackUserId: 'U_B', amount: 15000 },
      ],
      TEST_ACCOUNT,
    );

    const first = P.markPaid(pot.id, 'U_A', true);
    assert.ok(first.ok && !first.value.allPaid, '아직 U_B 가 남았다');

    const second = P.markPaid(pot.id, 'U_B', true);
    assert.ok(second.ok && second.value.allPaid, '이제 전원 완료');
  });

  test('파티장은 자기한테 입금하지 않으므로 계산에서 빠진다', () => {
    const pot = potInSettling(); // 파티장 + OTHER
    const result = P.markPaid(pot.id, OTHER, true);
    // 파티장이 안 눌렀는데도 전원 완료가 되어야 합니다.
    assert.ok(result.ok && result.value.allPaid);
  });
});

describe('4단계 · 정산 완료와 되돌리기', () => {
  test('정산 완료 뒤에는 입금 표시를 바꿀 수 없다', () => {
    const pot = potInSettling();
    P.markPaid(pot.id, OTHER, true);
    P.finishSettlement(pot.id, LEADER);

    const result = P.markPaid(pot.id, OTHER, false);
    assert.ok(!result.ok);
  });

  test('파티장은 정산을 다시 열 수 있다 — 잘못 눌러 끝난 경우의 탈출구', () => {
    const pot = potInSettling();
    P.markPaid(pot.id, OTHER, true);
    P.finishSettlement(pot.id, LEADER);

    assert.ok(!P.reopenSettlement(pot.id, OTHER).ok, '참여자는 못 연다');

    const reopened = P.reopenSettlement(pot.id, LEADER);
    assert.ok(reopened.ok);
    assert.equal(reopened.value.status, POT_STATUS.SETTLING);

    // 다시 열었으니 이제 되돌릴 수 있어야 합니다.
    assert.ok(P.markPaid(pot.id, OTHER, false).ok);
  });

  test('정산 중이 아닌 팟은 다시 열 수 없다', () => {
    const pot = newPot();
    assert.ok(!P.reopenSettlement(pot.id, LEADER).ok);
  });
});

describe('3단계 · 이상해요 신고', () => {
  test('신고하고 취소할 수 있다', () => {
    const pot = potInSettling();
    assert.ok(P.markDisputed(pot.id, OTHER, true).ok);
    assert.equal(P.getParticipants(pot.id).find((p) => p.slack_user_id === OTHER)!.disputed, 1);

    assert.ok(P.markDisputed(pot.id, OTHER, false).ok);
    assert.equal(P.getParticipants(pot.id).find((p) => p.slack_user_id === OTHER)!.disputed, 0);
  });

  test('참여하지 않은 사람은 신고할 수 없다', () => {
    const pot = potInSettling();
    assert.ok(!P.markDisputed(pot.id, 'U_STRANGER', true).ok);
  });

  test('입금 완료로 표시하면 신고는 자동으로 풀린다 — 입금했다는 건 의문이 풀렸다는 뜻', () => {
    const pot = potInSettling();
    P.markDisputed(pot.id, OTHER, true);
    P.markPaid(pot.id, OTHER, true);
    assert.equal(P.getParticipants(pot.id).find((p) => p.slack_user_id === OTHER)!.disputed, 0);
  });
});

describe('정산 마무리 — 완전히 끝내기', () => {
  test('정산 완료 상태에서만 마무리할 수 있다', () => {
    const pot = newPot();
    assert.ok(!P.finalizeSettlement(pot.id, LEADER).ok);
  });

  test('파티장만 마무리할 수 있다', () => {
    const pot = potInSettling();
    P.markPaid(pot.id, OTHER, true);
    P.finishSettlement(pot.id, LEADER);

    assert.ok(!P.finalizeSettlement(pot.id, OTHER).ok);
    assert.ok(P.finalizeSettlement(pot.id, LEADER).ok);
  });

  test('마무리하면 더 이상 다시 열 수 없다 — 정산 완료와 다른 점', () => {
    const pot = potInSettling();
    P.markPaid(pot.id, OTHER, true);
    P.finishSettlement(pot.id, LEADER);
    P.finalizeSettlement(pot.id, LEADER);

    assert.equal(P.getPot(pot.id)!.status, POT_STATUS.FINALIZED);
    assert.ok(!P.reopenSettlement(pot.id, LEADER).ok);
  });
});

describe('취소', () => {
  test('파티장만 취소할 수 있다', () => {
    const pot = newPot();
    assert.ok(!P.cancelPot(pot.id, OTHER).ok);
    assert.ok(P.cancelPot(pot.id, LEADER).ok);
  });

  test('정산이 끝나기 전이면 어느 단계에서든 취소된다', () => {
    const recruiting = newPot();
    assert.ok(P.cancelPot(recruiting.id, LEADER).ok);

    const closed = newPot();
    P.closePot(closed.id, LEADER);
    assert.ok(P.cancelPot(closed.id, LEADER).ok);

    const settling = potInSettling();
    assert.ok(P.cancelPot(settling.id, LEADER).ok);
  });

  test('정산 완료된 팟은 취소할 수 없다', () => {
    const pot = potInSettling();
    P.markPaid(pot.id, OTHER, true);
    P.finishSettlement(pot.id, LEADER);
    assert.ok(!P.cancelPot(pot.id, LEADER).ok);
  });

  test('취소된 팟에는 참여할 수 없고, 안내 문구도 취소라고 말한다', () => {
    const pot = newPot();
    P.cancelPot(pot.id, LEADER);

    const result = P.joinPot(pot.id, OTHER);
    assert.ok(!result.ok);
    assert.match(result.error, /취소/);
  });

  test('취소해도 기록은 남는다 — 지우지 않는다', () => {
    const pot = newPot();
    P.cancelPot(pot.id, LEADER);
    assert.notEqual(P.getPot(pot.id), null);
    assert.equal(P.getPot(pot.id)!.status, POT_STATUS.CANCELLED);
  });
});
