/**
 * 금액 표시 테스트.
 *
 * 정산 금액은 이제 참여자마다 다르게 입력하므로(참여자별 amount), 예전처럼
 * 총액을 균등하게 나누는 계산(amountPerPerson/splitBill)은 없앴습니다.
 * 여기서는 화면에 보여줄 숫자 서식만 확인합니다.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { setUpTempDb } from './helpers.ts';

setUpTempDb();
const { formatWon } = await import('../src/lib/pots.ts');

describe('금액 표시', () => {
  test('천 단위로 쉼표를 넣는다', () => {
    assert.equal(formatWon(0), '0');
    assert.equal(formatWon(1000), '1,000');
    assert.equal(formatWon(92010), '92,010');
  });
});
