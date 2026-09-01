/**
 * 계좌와 사용자 이름 보관 테스트.
 *
 * 개인정보가 걸린 부분이라 "언제 저장되고 언제 지워지는지"를 못 박아둡니다.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { TEST_ACCOUNT, setUpTempDb } from './helpers.ts';

setUpTempDb();
const P = await import('../src/lib/pots.ts');
const { getDb } = await import('../src/lib/db.ts');

const LEADER = 'U_ACC_LEADER';

/** 정산까지 마무리해서(FINALIZED) 계좌 삭제 대상이 되는 팟을 만듭니다. */
function finalizedPot(organizerId = LEADER) {
  const pot = P.createPot({
    channelId: 'C_TEST',
    organizerId,
    potType: P.POT_TYPE.DELIVERY,
    title: '계좌 테스트',
    place: '1F',
    meetAt: null,
    capacity: 0,
    account: null,
  });
  P.joinPot(pot.id, 'U_PAYER');
  P.closePot(pot.id, organizerId);
  P.startSettlement(pot.id, organizerId, [{ slackUserId: 'U_PAYER', amount: 20000 }], TEST_ACCOUNT);
  P.markPaid(pot.id, 'U_PAYER', true);
  P.finishSettlement(pot.id, organizerId);
  P.finalizeSettlement(pot.id, organizerId);
  return P.getPot(pot.id)!;
}

/** 팟이 끝난 시각을 과거로 돌립니다. 보관 기간 테스트용. */
function pretendItEndedDaysAgo(potId: number, days: number): void {
  const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  getDb().prepare('UPDATE pots SET updated_at = ? WHERE id = ?').run(when, potId);
}

describe('계좌 등록', () => {
  test('등록하면 다시 꺼내 쓸 수 있다', () => {
    P.saveAccount('U_SAVE_1', '민수', TEST_ACCOUNT);
    // DB에서 온 행은 프로토타입이 null 이라 그대로 비교하면 값이 같아도 실패합니다.
    // { ...행 } 으로 평범한 객체로 바꿔서 비교합니다.
    assert.deepEqual({ ...P.getAccount('U_SAVE_1') }, TEST_ACCOUNT);
  });

  test('등록한 적 없으면 null', () => {
    assert.equal(P.getAccount('U_NEVER'), null);
  });

  test('이름을 null 로 넘겨도 알아둔 이름이 지워지지 않는다', () => {
    // 실제로 버그가 있던 자리입니다. 정산 시작 때 계좌만 저장하면서
    // 이름 자리에 null 을 넘기는데, 예전에는 그게 이름을 덮어썼습니다.
    P.rememberUserName('U_SAVE_2', '지훈');
    P.saveAccount('U_SAVE_2', null, TEST_ACCOUNT);
    assert.equal(P.getUserNames().get('U_SAVE_2'), '지훈');
  });
});

describe('사용자 이름 기억', () => {
  test('기억한 이름을 한 번에 가져올 수 있다', () => {
    P.rememberUserName('U_NAME_1', '다혜');
    assert.equal(P.getUserNames().get('U_NAME_1'), '다혜');
  });

  test('이름을 바꾸면 갱신된다', () => {
    P.rememberUserName('U_NAME_2', '옛이름');
    P.rememberUserName('U_NAME_2', '새이름');
    assert.equal(P.getUserNames().get('U_NAME_2'), '새이름');
  });

  test('아직 이름을 모르는 참여자를 찾아낸다 — 봇이 시작할 때 채우는 근거', () => {
    const pot = P.createPot({
      channelId: 'C_TEST',
      organizerId: 'U_UNNAMED_LEADER',
      potType: P.POT_TYPE.DELIVERY,
      title: '이름 없는 팟',
      place: null,
      meetAt: null,
      capacity: 0,
      account: null,
    });
    P.joinPot(pot.id, 'U_UNNAMED_MEMBER');

    const unnamed = P.listUnnamedUserIds();
    assert.ok(unnamed.includes('U_UNNAMED_LEADER'));
    assert.ok(unnamed.includes('U_UNNAMED_MEMBER'));

    P.rememberUserName('U_UNNAMED_MEMBER', '서연');
    assert.ok(!P.listUnnamedUserIds().includes('U_UNNAMED_MEMBER'));
  });
});

describe('계좌번호 보관 기간', () => {
  test('방금 마무리한 팟은 아직 지우지 않는다 — 유예 시간을 두기 때문', () => {
    const pot = finalizedPot();
    P.purgeFinishedAccounts();
    assert.equal(P.getPot(pot.id)!.account_number, TEST_ACCOUNT.account_number);
  });

  test('하루가 지난 팟의 계좌번호는 지운다', () => {
    const pot = finalizedPot();
    pretendItEndedDaysAgo(pot.id, 2);

    P.purgeFinishedAccounts();

    const after = P.getPot(pot.id)!;
    assert.equal(after.account_number, null);
    assert.equal(after.bank_name, null);
    assert.equal(after.account_holder, null);
  });

  test('정산 완료(SETTLED) 상태로는 아무리 오래돼도 지우지 않는다 — 아직 다시 열 수 있어야 하므로', () => {
    const pot = P.createPot({
      channelId: 'C_TEST',
      organizerId: LEADER,
      potType: P.POT_TYPE.DELIVERY,
      title: '아직 마무리 전',
      place: null,
      meetAt: null,
      capacity: 0,
      account: null,
    });
    P.joinPot(pot.id, 'U_PAYER');
    P.closePot(pot.id, LEADER);
    P.startSettlement(pot.id, LEADER, [{ slackUserId: 'U_PAYER', amount: 20000 }], TEST_ACCOUNT);
    P.markPaid(pot.id, 'U_PAYER', true);
    P.finishSettlement(pot.id, LEADER); // SETTLED. 마무리(FINALIZE)는 아직 안 눌렀습니다.
    pretendItEndedDaysAgo(pot.id, 30);

    P.purgeFinishedAccounts();
    assert.equal(P.getPot(pot.id)!.account_number, TEST_ACCOUNT.account_number);
  });

  test('아직 진행 중인 팟은 오래돼도 건드리지 않는다', () => {
    const pot = P.createPot({
      channelId: 'C_TEST',
      organizerId: LEADER,
      potType: P.POT_TYPE.DELIVERY,
      title: '진행 중',
      place: null,
      meetAt: null,
      capacity: 0,
      account: null,
    });
    P.joinPot(pot.id, 'U_PAYER');
    P.closePot(pot.id, LEADER);
    P.startSettlement(pot.id, LEADER, [{ slackUserId: 'U_PAYER', amount: 10000 }], TEST_ACCOUNT);
    pretendItEndedDaysAgo(pot.id, 30);

    P.purgeFinishedAccounts();
    assert.equal(P.getPot(pot.id)!.account_number, TEST_ACCOUNT.account_number);
  });

  test('계좌만 지우고 금액·참여자·상태는 남긴다', () => {
    const pot = finalizedPot();
    pretendItEndedDaysAgo(pot.id, 2);
    P.purgeFinishedAccounts();

    const after = P.getPot(pot.id)!;
    assert.equal(after.total_amount, 20000, '금액은 남아야 대시보드가 보여줄 수 있다');
    assert.equal(after.status, 'FINALIZED');
    assert.equal(P.getParticipants(pot.id).length, 2);
  });

  test('정산 없이 종료된 팟도 같은 규칙을 따른다 — 팟 만들 때 계좌를 미리 적어뒀을 수 있다', () => {
    const pot = P.createPot({
      channelId: 'C_TEST',
      organizerId: LEADER,
      potType: P.POT_TYPE.DELIVERY,
      title: '각자 계산',
      place: null,
      meetAt: null,
      capacity: 0,
      account: TEST_ACCOUNT, // 계좌 칸은 선택 사항이라 이렇게 미리 적어둘 수 있습니다.
    });
    P.closePot(pot.id, LEADER);
    P.finishWithoutSettlement(pot.id, LEADER);
    pretendItEndedDaysAgo(pot.id, 2);

    P.purgeFinishedAccounts();
    assert.equal(P.getPot(pot.id)!.account_number, null);
  });

  test('취소된 팟도 같은 규칙을 따른다', () => {
    const pot = P.createPot({
      channelId: 'C_TEST',
      organizerId: LEADER,
      potType: P.POT_TYPE.DELIVERY,
      title: '취소될 팟',
      place: null,
      meetAt: null,
      capacity: 0,
      account: TEST_ACCOUNT,
    });
    P.cancelPot(pot.id, LEADER);
    pretendItEndedDaysAgo(pot.id, 2);

    P.purgeFinishedAccounts();
    assert.equal(P.getPot(pot.id)!.account_number, null);
  });
});
