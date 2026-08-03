/**
 * 4단계 상태 규칙 테스트.
 *
 * 이 파일은 DB를 쓰지 않습니다. 순수한 규칙만 확인합니다.
 *   모집중 → 모집 완료 → 정산 중 → 정산 완료
 *   (정산이 끝나기 전까지는 어느 단계에서든 취소 가능)
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  POT_STATUS,
  STATUS_LABEL,
  STATUS_ORDER,
  canTransition,
  isFinished,
  nextStatus,
  statusStep,
} from '../src/lib/status.ts';

describe('상태 전이 규칙', () => {
  test('정해진 순서대로는 넘어갈 수 있다', () => {
    assert.ok(canTransition(POT_STATUS.RECRUITING, POT_STATUS.CLOSED));
    assert.ok(canTransition(POT_STATUS.CLOSED, POT_STATUS.SETTLING));
    assert.ok(canTransition(POT_STATUS.SETTLING, POT_STATUS.SETTLED));
  });

  test('단계를 건너뛸 수 없다', () => {
    assert.ok(!canTransition(POT_STATUS.RECRUITING, POT_STATUS.SETTLING));
    assert.ok(!canTransition(POT_STATUS.RECRUITING, POT_STATUS.SETTLED));
    assert.ok(!canTransition(POT_STATUS.CLOSED, POT_STATUS.SETTLED));
  });

  test('뒤로 돌아갈 수 없다', () => {
    assert.ok(!canTransition(POT_STATUS.CLOSED, POT_STATUS.RECRUITING));
    assert.ok(!canTransition(POT_STATUS.SETTLING, POT_STATUS.CLOSED));
    assert.ok(!canTransition(POT_STATUS.SETTLED, POT_STATUS.SETTLING));
  });

  test('정산이 끝나기 전에는 어느 단계에서든 취소할 수 있다', () => {
    assert.ok(canTransition(POT_STATUS.RECRUITING, POT_STATUS.CANCELLED));
    assert.ok(canTransition(POT_STATUS.CLOSED, POT_STATUS.CANCELLED));
    assert.ok(canTransition(POT_STATUS.SETTLING, POT_STATUS.CANCELLED));
  });

  test('정산 완료된 팟은 취소할 수 없다 — 돈이 이미 오갔다', () => {
    assert.ok(!canTransition(POT_STATUS.SETTLED, POT_STATUS.CANCELLED));
  });

  test('취소된 팟은 되살릴 수 없다', () => {
    for (const to of STATUS_ORDER) {
      assert.ok(!canTransition(POT_STATUS.CANCELLED, to), `CANCELLED → ${to} 는 막혀야 함`);
    }
  });
});

describe('다음 단계 안내', () => {
  test('취소는 옆길이라 "다음 단계"로 제안하지 않는다', () => {
    assert.equal(nextStatus(POT_STATUS.RECRUITING), POT_STATUS.CLOSED);
    assert.equal(nextStatus(POT_STATUS.CLOSED), POT_STATUS.SETTLING);
    assert.equal(nextStatus(POT_STATUS.SETTLING), POT_STATUS.SETTLED);
  });

  test('끝난 상태에는 다음이 없다', () => {
    assert.equal(nextStatus(POT_STATUS.SETTLED), null);
    assert.equal(nextStatus(POT_STATUS.CANCELLED), null);
  });
});

describe('진행률 표시', () => {
  test('4단계는 1~4로 매겨진다', () => {
    assert.equal(statusStep(POT_STATUS.RECRUITING), 1);
    assert.equal(statusStep(POT_STATUS.CLOSED), 2);
    assert.equal(statusStep(POT_STATUS.SETTLING), 3);
    assert.equal(statusStep(POT_STATUS.SETTLED), 4);
  });

  test('취소됨은 흐름 밖이라 0 — 화면에서 진행 막대 대신 문구를 띄우는 근거', () => {
    assert.equal(statusStep(POT_STATUS.CANCELLED), 0);
  });

  test('진행 막대에는 4단계만 들어간다', () => {
    assert.equal(STATUS_ORDER.length, 4);
    assert.ok(!STATUS_ORDER.includes(POT_STATUS.CANCELLED));
  });
});

describe('끝난 상태 판별', () => {
  test('정산 완료와 취소됨만 끝난 상태', () => {
    assert.ok(isFinished(POT_STATUS.SETTLED));
    assert.ok(isFinished(POT_STATUS.CANCELLED));
    assert.ok(!isFinished(POT_STATUS.RECRUITING));
    assert.ok(!isFinished(POT_STATUS.CLOSED));
    assert.ok(!isFinished(POT_STATUS.SETTLING));
  });
});

describe('표시 이름', () => {
  test('모든 상태에 한글 이름이 있다', () => {
    // 상태를 새로 추가하고 이름 넣는 걸 잊으면 여기서 걸립니다.
    for (const status of Object.values(POT_STATUS)) {
      assert.ok(STATUS_LABEL[status], `${status} 의 한글 이름이 없음`);
    }
  });
});
