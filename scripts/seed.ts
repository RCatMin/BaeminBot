/**
 * 슬랙 없이도 대시보드를 구경할 수 있도록 가짜 데이터를 넣는 스크립트.
 *
 *   npm run seed
 *
 * 단계마다 어떻게 보이는지 확인할 때 씁니다.
 * 실제 슬랙 사용자 ID가 아니라 U_MINSU 같은 가짜 ID를 넣습니다.
 */

import {
  closePot,
  createPot,
  finalizeSettlement,
  finishSettlement,
  joinPot,
  markDisputed,
  markPaid,
  startSettlement,
} from '../src/lib/pots.ts';

const account = {
  bank_name: '카카오뱅크',
  account_number: '3333-01-1234567',
  account_holder: '이민수',
};

// ── 1단계: 모집중 ───────────────────────────────────────────────────────────
const recruiting = createPot({
  channelId: 'C_LUNCH',
  organizerId: 'U_MINSU',
  title: '김치찌개 먹으러 갈 사람',
  place: '1F',
  meetAt: '12:10',
  capacity: 5,
  account,
});
joinPot(recruiting.id, 'U_JIHOON');
joinPot(recruiting.id, 'U_SEOYEON');

// ── 2단계: 모집 완료 ────────────────────────────────────────────────────────
const closed = createPot({
  channelId: 'C_LUNCH',
  organizerId: 'U_SEOYEON',
  title: '마라탕 각',
  place: 'B1',
  meetAt: '12:00',
  capacity: 0,
  account,
});
joinPot(closed.id, 'U_MINSU');
joinPot(closed.id, 'U_DAHYE');
closePot(closed.id, 'U_SEOYEON');

// ── 3단계: 정산 중 (메뉴가 달라서 금액도 제각각, 1명은 "이상해요" 신고) ──────
const settling = createPot({
  channelId: 'C_LUNCH',
  organizerId: 'U_JIHOON',
  title: '삼겹살 회식 뒤풀이',
  place: 'B1',
  meetAt: '19:00',
  capacity: 0,
  account,
});
joinPot(settling.id, 'U_MINSU');
joinPot(settling.id, 'U_DAHYE');
joinPot(settling.id, 'U_SEOYEON');
closePot(settling.id, 'U_JIHOON');
startSettlement(
  settling.id,
  'U_JIHOON',
  [
    { slackUserId: 'U_MINSU', amount: 18000 },
    { slackUserId: 'U_DAHYE', amount: 25000 },
    { slackUserId: 'U_SEOYEON', amount: 12000 },
  ],
  account,
);
markPaid(settling.id, 'U_MINSU', true);
markDisputed(settling.id, 'U_SEOYEON', true);

// ── 4단계: 정산 완료 (아직 되돌릴 수 있는 상태) ────────────────────────────
const settled = createPot({
  channelId: 'C_LUNCH',
  organizerId: 'U_DAHYE',
  title: '초밥 뷔페',
  place: '1F',
  meetAt: '12:30',
  capacity: 0,
  account,
});
joinPot(settled.id, 'U_MINSU');
closePot(settled.id, 'U_DAHYE');
startSettlement(settled.id, 'U_DAHYE', [{ slackUserId: 'U_MINSU', amount: 46000 }], account);
markPaid(settled.id, 'U_MINSU', true);
finishSettlement(settled.id, 'U_DAHYE');

// ── 정산 마무리: 완전히 끝나서 되돌릴 수 없는 상태 ─────────────────────────
const finalized = createPot({
  channelId: 'C_LUNCH',
  organizerId: 'U_SEOYEON',
  title: '냉면 한 그릇',
  place: '1F',
  meetAt: '12:00',
  capacity: 0,
  account,
});
joinPot(finalized.id, 'U_JIHOON');
closePot(finalized.id, 'U_SEOYEON');
startSettlement(finalized.id, 'U_SEOYEON', [{ slackUserId: 'U_JIHOON', amount: 9000 }], account);
markPaid(finalized.id, 'U_JIHOON', true);
finishSettlement(finalized.id, 'U_SEOYEON');
finalizeSettlement(finalized.id, 'U_SEOYEON');

console.log('✅ 샘플 팟 5건을 넣었습니다. (모집중 / 모집 완료 / 정산 중 / 정산 완료 / 정산 마무리)');
console.log('   npm run dev 로 http://localhost:3000 에서 확인하세요.');
