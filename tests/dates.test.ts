/**
 * 날짜별 조회 테스트.
 *
 * created_at은 UTC로 저장되는데, 사람은 한국 시간으로 날짜를 생각합니다.
 * 자정 근처(UTC로 넘어가면 날짜가 바뀌는 시간대)에도 올바른 날로 묶이는지 확인합니다.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { setUpTempDb } from './helpers.ts';

setUpTempDb();
const P = await import('../src/lib/pots.ts');
const { getDb } = await import('../src/lib/db.ts');

/** 팟을 만들고, 생성 시각을 원하는 UTC 시각으로 강제로 바꿉니다. */
function potCreatedAt(title: string, utcIso: string) {
  const pot = P.createPot({
    channelId: 'C_TEST',
    organizerId: 'U_LEADER',
    potType: P.POT_TYPE.DELIVERY,
    title,
    place: '1F',
    meetAt: '12:00',
    capacity: 0,
    account: null,
  });
  getDb().prepare('UPDATE pots SET created_at = ? WHERE id = ?').run(utcIso, pot.id);
  return pot.id;
}

describe('listPotsByDate', () => {
  test('한국 날짜 기준으로 묶는다 — 자정 근처도 날짜가 안 밀린다', () => {
    // 한국시간 8/3 09:00 = UTC 8/3 00:00 (자정 직후, 가장 헷갈리는 경계)
    const morning = potCreatedAt('아침 팟', '2026-08-03T00:00:00.000Z');
    // 한국시간 8/3 08:59 = UTC 8/2 23:59 (1분 전, 한국은 아직 8/3인데 UTC는 8/2)
    const justBefore = potCreatedAt('자정 직전 팟', '2026-08-02T23:59:00.000Z');
    // 완전히 다른 날
    potCreatedAt('다른 날 팟', '2026-08-01T03:00:00.000Z');

    const aug3 = P.listPotsByDate('2026-08-03');
    const ids = aug3.map((p) => p.id).sort();

    assert.deepEqual(ids, [morning, justBefore].sort(), 'UTC로는 다른 날이지만 한국 날짜로는 둘 다 8/3');
  });

  test('그 날짜에 없으면 빈 배열', () => {
    potCreatedAt('아무 날', '2026-08-01T03:00:00.000Z');
    assert.deepEqual(P.listPotsByDate('2099-01-01'), []);
  });
});

describe('listPotDates', () => {
  // 같은 파일의 다른 테스트들과 날짜가 겹치지 않도록, 아무도 안 쓰는 미래 날짜를 씁니다.
  // (setUpTempDb는 파일 하나당 한 번만 실행되어 이 파일의 모든 테스트가 DB를 공유합니다)
  test('날짜별 개수를 최신순으로 묶는다', () => {
    potCreatedAt('12/1 팟 A', '2030-12-01T03:00:00.000Z');
    potCreatedAt('12/1 팟 B', '2030-12-01T05:00:00.000Z');
    potCreatedAt('12/2 팟', '2030-12-02T03:00:00.000Z');

    const dates = P.listPotDates();
    const byDate = new Map(dates.map((d) => [d.date, d.count]));

    assert.equal(byDate.get('2030-12-01'), 2);
    assert.equal(byDate.get('2030-12-02'), 1);

    // 최신순 확인: 12/2가 12/1보다 앞에 있어야 함
    const order = dates.map((d) => d.date);
    assert.ok(order.indexOf('2030-12-02') < order.indexOf('2030-12-01'));
  });

  test('클라이언트 컴포넌트로 넘겨도 되는 평범한 객체다', () => {
    potCreatedAt('평범한 객체 확인용', '2031-01-01T03:00:00.000Z');
    const [row] = P.listPotDates();

    // node:sqlite 가 돌려주는 행은 프로토타입이 null이라 Next.js가
    // 클라이언트 컴포넌트로 못 넘깁니다. Object.getPrototypeOf 로 확인합니다.
    assert.equal(Object.getPrototypeOf(row), Object.prototype);
  });
});
