/**
 * 점심팟의 4단계 상태와, 각 상태에서 다음으로 갈 수 있는 경로를 정의합니다.
 *
 * 모집중 → 모집 완료 → 정산 중 → 정산 완료
 *
 * 이 파일 하나만 고치면 슬랙봇과 웹 대시보드가 동시에 같은 규칙을 따르게 됩니다.
 */

// TypeScript의 enum 대신 "그냥 객체"를 씁니다.
// Node가 타입만 걷어내고 바로 실행하는 방식(type stripping)에서는 enum을 못 쓰기 때문입니다.
export const POT_STATUS = {
  RECRUITING: 'RECRUITING', // 1단계: 모집중
  CLOSED: 'CLOSED', // 2단계: 모집 완료 (인원 확정, 아직 돈 얘기 전)
  SETTLING: 'SETTLING', // 3단계: 정산 중 (계좌 DM 발송됨, 입금 대기)
  SETTLED: 'SETTLED', // 4단계: 정산 완료 (전원 입금 확인)

  // 4단계 흐름 바깥에 있는 종료 상태.
  // 약속이 깨졌거나 잘못 만든 팟이 영원히 남지 않도록 빠져나오는 길입니다.
  CANCELLED: 'CANCELLED', // 취소됨
} as const;

// POT_STATUS의 값들만 뽑아서 만든 타입.
export type PotStatus = (typeof POT_STATUS)[keyof typeof POT_STATUS];

/** 화면에 보여줄 한글 이름 */
export const STATUS_LABEL: Record<PotStatus, string> = {
  RECRUITING: '모집중',
  CLOSED: '모집 완료',
  SETTLING: '정산 중',
  SETTLED: '정산 완료',
  CANCELLED: '취소됨',
};

/** 상태별 이모지 (슬랙 메시지 제목에 붙습니다) */
export const STATUS_EMOJI: Record<PotStatus, string> = {
  RECRUITING: '🍚',
  CLOSED: '🔒',
  SETTLING: '💸',
  SETTLED: '✅',
  CANCELLED: '🚫',
};

/**
 * 상태 전이 규칙표.
 * "지금 이 상태에서 갈 수 있는 다음 상태들"만 적어둡니다.
 * 되돌아가기(예: 정산 완료 → 모집중)는 허용하지 않습니다.
 *
 * 취소는 정산이 끝나기 전까지 어느 단계에서든 할 수 있습니다.
 * 각 줄의 첫 번째 값이 "정상적인 다음 단계"이고, CANCELLED는 옆길입니다.
 */
const ALLOWED_TRANSITIONS: Record<PotStatus, PotStatus[]> = {
  RECRUITING: [POT_STATUS.CLOSED, POT_STATUS.CANCELLED],
  CLOSED: [POT_STATUS.SETTLING, POT_STATUS.CANCELLED],
  SETTLING: [POT_STATUS.SETTLED, POT_STATUS.CANCELLED],
  SETTLED: [], // 정산까지 끝났으면 취소할 수 없습니다. 돈이 이미 오갔으니까요.
  CANCELLED: [], // 취소된 팟은 되살리지 않습니다. 새로 만드는 게 낫습니다.
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
 * 진행률 표시용 4단계. 취소됨은 이 흐름 바깥이라 여기 들어가지 않습니다.
 * (진행 막대에 "취소됨" 칸을 만들면 마치 5단계인 것처럼 보입니다)
 */
export const STATUS_ORDER: PotStatus[] = [
  POT_STATUS.RECRUITING,
  POT_STATUS.CLOSED,
  POT_STATUS.SETTLING,
  POT_STATUS.SETTLED,
];

/** 4단계 중 몇 번째인지 (1~4). 취소됨처럼 흐름 밖의 상태는 0. */
export function statusStep(status: PotStatus): number {
  return STATUS_ORDER.indexOf(status) + 1;
}

/** 더 이상 아무 동작도 할 수 없는 상태인지. (정산 완료 · 취소됨) */
export function isFinished(status: PotStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}
