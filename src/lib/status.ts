/**
 * 점심팟의 상태와, 각 상태에서 다음으로 갈 수 있는 경로를 정의합니다.
 *
 * 모집중 → 모집 완료 → 정산 중 → 정산 완료 → (정산 마무리)
 *
 * 마지막 "정산 마무리"는 화면에 보여주는 4단계 진행 막대에는 새 칸을 만들지 않습니다.
 * "정산 완료" 위에 얹는 잠금 한 겹일 뿐이라, statusStep()에서 정산 완료와 같은 4단계로 셉니다.
 * (정산 완료까지는 파티장이 되돌릴 수 있어야 실수를 고칠 수 있는데, 그 되돌리기 창구를
 *  영원히 열어두면 끝난 정산도 계속 흔들릴 수 있으니 "이제 진짜 끝"이라는 확인 단계를 뒀습니다.)
 *
 * 이 파일 하나만 고치면 슬랙봇과 웹 대시보드가 동시에 같은 규칙을 따르게 됩니다.
 */

// TypeScript의 enum 대신 "그냥 객체"를 씁니다.
// Node가 타입만 걷어내고 바로 실행하는 방식(type stripping)에서는 enum을 못 쓰기 때문입니다.
export const POT_STATUS = {
  RECRUITING: 'RECRUITING', // 1단계: 모집중
  CLOSED: 'CLOSED', // 2단계: 모집 완료 (인원 확정, 아직 돈 얘기 전)
  SETTLING: 'SETTLING', // 3단계: 정산 중 (계좌 DM 발송됨, 입금 대기)
  SETTLED: 'SETTLED', // 4단계: 정산 완료 (전원 입금 확인). 아직 되돌릴 수 있습니다.

  // 4단계 흐름 바깥에 있는 종료 상태들.
  FINALIZED: 'FINALIZED', // 정산 마무리 — 파티장이 확정한 뒤에는 되돌릴 수 없습니다.
  CANCELLED: 'CANCELLED', // 취소됨. 약속이 깨졌거나 잘못 만든 팟이 영원히 남지 않도록 빠져나오는 길입니다.
  // 모집 완료에서 곧장 빠져나오는 길. 각자 계산하는 식당처럼 봇 안에서 돈을 모을 필요가
  // 없을 때 씁니다. 취소와 달리 "약속은 잘 끝났다"는 뜻이라 화면에서 따로 구분합니다.
  NO_SETTLEMENT: 'NO_SETTLEMENT',
} as const;

// POT_STATUS의 값들만 뽑아서 만든 타입.
export type PotStatus = (typeof POT_STATUS)[keyof typeof POT_STATUS];

/** 화면에 보여줄 한글 이름 */
export const STATUS_LABEL: Record<PotStatus, string> = {
  RECRUITING: '모집중',
  CLOSED: '모집 완료',
  SETTLING: '정산 중',
  SETTLED: '정산 완료',
  FINALIZED: '정산 마무리',
  CANCELLED: '취소됨',
  NO_SETTLEMENT: '정산 없음',
};

/** 상태별 이모지 (슬랙 메시지 제목에 붙습니다) */
export const STATUS_EMOJI: Record<PotStatus, string> = {
  RECRUITING: '🍚',
  CLOSED: '🔒',
  SETTLING: '💸',
  SETTLED: '✅',
  FINALIZED: '🏁',
  CANCELLED: '🚫',
  NO_SETTLEMENT: '💳',
};

/**
 * 상태 전이 규칙표.
 * "지금 이 상태에서 갈 수 있는 다음 상태들"만 적어둡니다.
 * 되돌아가기(예: 정산 완료 → 모집중)는 허용하지 않습니다.
 *
 * 취소는 정산이 끝나기 전까지 어느 단계에서든 할 수 있습니다.
 * 각 줄의 첫 번째 값이 "정상적인 다음 단계"이고, CANCELLED는 옆길입니다.
 *
 * 정산 완료(SETTLED) → 정산 중(SETTLING)으로 되돌리는 길(파티장이 실수를 바로잡는 용도)은
 * 일부러 이 표에 넣지 않았습니다. pots.ts의 reopenSettlement()가 규칙표를 타지 않는
 * 의도적인 예외로 직접 처리합니다 — 표에 넣으면 "정산 완료의 다음 단계가 정산 중"인 것처럼
 * 보여서 앞으로 가는 흐름과 헷갈립니다.
 *
 * CLOSED → NO_SETTLEMENT 도 CANCELLED처럼 옆길입니다. 각자 계산하는 식당이라 봇으로
 * 돈을 모을 필요가 없을 때 파티장이 고릅니다. 한 번 고르면 되돌릴 수 없습니다
 * (마음이 바뀌었다면 새로 팟을 만드는 게 낫습니다 — CANCELLED와 같은 이유).
 */
const ALLOWED_TRANSITIONS: Record<PotStatus, PotStatus[]> = {
  RECRUITING: [POT_STATUS.CLOSED, POT_STATUS.CANCELLED],
  CLOSED: [POT_STATUS.SETTLING, POT_STATUS.NO_SETTLEMENT, POT_STATUS.CANCELLED],
  SETTLING: [POT_STATUS.SETTLED, POT_STATUS.CANCELLED],
  SETTLED: [POT_STATUS.FINALIZED], // 정산 완료까지는 다시 열 수 있지만, 마무리하면 그걸로 끝입니다.
  FINALIZED: [], // 마무리된 팟은 되돌릴 수 없습니다. 계좌번호도 곧 지워집니다.
  CANCELLED: [], // 취소된 팟은 되살리지 않습니다. 새로 만드는 게 낫습니다.
  NO_SETTLEMENT: [], // 정산 없이 끝난 팟도 되살리지 않습니다.
};

/** from 상태에서 to 상태로 넘어가도 되는지 확인합니다. */
export function canTransition(from: PotStatus, to: PotStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** 다음 단계가 무엇인지 알려줍니다. 마지막 단계면 null. */
export function nextStatus(current: PotStatus): PotStatus | null {
  return ALLOWED_TRANSITIONS[current][0] ?? null;
}

/**
 * 진행률 표시용 4단계. 취소됨 · 정산 마무리는 이 흐름 바깥이라 여기 들어가지 않습니다.
 * (진행 막대에 칸을 더 만들면 마치 5단계, 6단계인 것처럼 보입니다.
 *  정산 마무리는 statusStep()에서 정산 완료와 같은 4번째 칸으로 셉니다 — 새 단계가 아니라
 *  정산 완료 위에 얹는 잠금이기 때문입니다.)
 */
export const STATUS_ORDER: PotStatus[] = [
  POT_STATUS.RECRUITING,
  POT_STATUS.CLOSED,
  POT_STATUS.SETTLING,
  POT_STATUS.SETTLED,
];

/**
 * 4단계 중 몇 번째인지 (1~4).
 * 정산 마무리는 정산 완료와 같은 4번째로 셉니다. 취소됨처럼 흐름 밖의 상태는 0.
 */
export function statusStep(status: PotStatus): number {
  if (status === POT_STATUS.FINALIZED) return STATUS_ORDER.length;
  return STATUS_ORDER.indexOf(status) + 1;
}

/** 더 이상 아무 동작도 할 수 없는 상태인지. (정산 마무리 · 취소됨) */
export function isFinished(status: PotStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}
