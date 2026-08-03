/**
 * 정산 금액 계산 테스트.
 *
 * 핵심 성질: **걷은 돈 + 파티장 몫 = 총액**. 항상 정확히 맞아야 합니다.
 * (파티장은 자기한테 송금하지 않으므로 1인당 금액 × 인원수는 총액과 다릅니다)
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { setUpTempDb } from './helpers.ts';

setUpTempDb();
const { amountPerPerson, formatWon, splitBill } = await import('../src/lib/pots.ts');

describe('1인당 금액 계산', () => {
  test('10원 단위로 올린다 — 송금할 때 1원이 남지 않게', () => {
    assert.equal(amountPerPerson(30000, 3), 10000);
    assert.equal(amountPerPerson(10000, 3), 3340); // 3333.3 → 3340
    assert.equal(amountPerPerson(123, 1), 130);
  });

  test('인원이 0이면 0 (0으로 나누지 않는다)', () => {
    assert.equal(amountPerPerson(10000, 0), 0);
    assert.equal(amountPerPerson(10000, -1), 0);
  });
});

describe('총액 분배', () => {
  // 실제로 있을 법한 조합들. 마지막 두 개는 나누어떨어지지 않는 경우.
  const cases: [total: number, headcount: number][] = [
    [92010, 4],
    [92000, 4],
    [30000, 3],
    [10000, 3],
    [46000, 2],
    [100000, 7],
    [123, 1],
    [3310, 1],
  ];

  test('걷은 돈 + 파티장 몫 = 총액 (모든 경우)', () => {
    for (const [total, headcount] of cases) {
      const s = splitBill(total, headcount);
      assert.equal(
        s.collected + s.organizerShare,
        total,
        `총 ${total}원 · ${headcount}명에서 어긋남`,
      );
    }
  });

  test('보내는 사람은 파티장을 뺀 인원이다', () => {
    assert.equal(splitBill(30000, 3).payerCount, 2);
    assert.equal(splitBill(30000, 1).payerCount, 0);
  });

  test('참여자가 파티장뿐이면 걷을 돈이 없고 전액을 파티장이 부담한다', () => {
    const s = splitBill(3310, 1);
    assert.equal(s.payerCount, 0);
    assert.equal(s.collected, 0);
    assert.equal(s.organizerShare, 3310);
  });

  test('올림 때문에 파티장이 조금 덜 낸다 — 초과 징수가 아니다', () => {
    // 92,010 / 4 = 23,002.5 → 1인당 23,010원
    // 3명이 69,030원을 보내고 파티장은 22,980원 부담 (공정분보다 22.5원 적음)
    const s = splitBill(92010, 4);
    assert.equal(s.perPerson, 23010);
    assert.equal(s.collected, 69030);
    assert.equal(s.organizerShare, 22980);
    assert.ok(s.organizerShare < 92010 / 4, '파티장이 공정분보다 적게 부담');
  });
});

describe('금액 표시', () => {
  test('천 단위로 쉼표를 넣는다', () => {
    assert.equal(formatWon(0), '0');
    assert.equal(formatWon(1000), '1,000');
    assert.equal(formatWon(92010), '92,010');
  });
});
