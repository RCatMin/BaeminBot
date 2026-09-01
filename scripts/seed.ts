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
  drawWinner,
  finalizeSettlement,
  finishSettlement,
  finishWithoutSettlement,
  joinPot,
  markDisputed,
  markPaid,
  POT_TYPE,
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
  potType: POT_TYPE.DELIVERY,
  title: '김치찌개 먹으러 갈 사람',
  place: '1F',
  meetAt: '12:10',
  capacity: 5,
  account,
});
joinPot(recruiting.id, 'U_JIHOON');
joinPot(recruiting.id, 'U_SEOYEON');

// ── 1단계: 모집중 (외식 — 가게 이름·주소로 지도 링크 확인용) ────────────────
const dineOut = createPot({
  channelId: 'C_LUNCH',
  organizerId: 'U_DAHYE',
  potType: POT_TYPE.DINE_OUT,
  title: '냉면 먹으러 갈 사람',
  place: '서울 강남구 테헤란로 123',
  meetAt: '12:20',
  capacity: 4,
  account,
});
joinPot(dineOut.id, 'U_MINSU');

// ── 2단계: 모집 완료 ────────────────────────────────────────────────────────
const closed = createPot({
  channelId: 'C_LUNCH',
  organizerId: 'U_SEOYEON',
  potType: POT_TYPE.DELIVERY,
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
  potType: POT_TYPE.DELIVERY,
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
  potType: POT_TYPE.DELIVERY,
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
  potType: POT_TYPE.DELIVERY,
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

// ── 정산 없이 종료: 각자 계산하는 자리라 정산 단계를 건너뛴 경우 ────────────
const noSettlement = createPot({
  channelId: 'C_LUNCH',
  organizerId: 'U_MINSU',
  potType: POT_TYPE.DINE_OUT,
  title: '파스타 먹으러 갈 사람',
  place: '이태리 부대찌개',
  meetAt: '12:15',
  capacity: 0,
  account: null,
});
joinPot(noSettlement.id, 'U_JIHOON');
closePot(noSettlement.id, 'U_MINSU');
finishWithoutSettlement(noSettlement.id, 'U_MINSU');

// ── 내기: 모집중 (참가자 중 한 명을 뽑는 중) ────────────────────────────────
const betRecruiting = createPot({
  channelId: 'C_LUNCH',
  organizerId: 'U_DAHYE',
  potType: POT_TYPE.BET,
  title: '커피 내기',
  place: '커피',
  meetAt: null,
  capacity: 0,
  account: null,
});
joinPot(betRecruiting.id, 'U_MINSU');
joinPot(betRecruiting.id, 'U_JIHOON');

// ── 내기: 추첨 완료 (당첨자 표시 확인용) ────────────────────────────────────
const betDrawn = createPot({
  channelId: 'C_LUNCH',
  organizerId: 'U_SEOYEON',
  potType: POT_TYPE.BET,
  title: '디저트 내기',
  place: '디저트',
  meetAt: null,
  capacity: 0,
  account: null,
});
joinPot(betDrawn.id, 'U_MINSU');
joinPot(betDrawn.id, 'U_DAHYE');
drawWinner(betDrawn.id, 'U_SEOYEON');

console.log('✅ 샘플 팟 9건을 넣었습니다.');
console.log('   모집중 x3(배달·외식·내기) / 모집 완료 / 정산 중 / 정산 완료 / 정산 마무리 / 정산 없이 종료 / 내기 추첨 완료');
console.log('   npm run dev 로 http://localhost:3000 에서 확인하세요.');
