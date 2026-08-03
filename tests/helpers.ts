/**
 * 테스트 공용 도우미.
 *
 * 가장 중요한 일: **실제 DB를 건드리지 않게 하는 것**입니다.
 * 테스트가 data/baemin-bot.db 를 쓰면 진짜 팟 기록이 망가집니다.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * 이 테스트 파일 전용 임시 DB 폴더를 만듭니다.
 *
 * ⚠️ 반드시 pots.ts 를 불러오기 **전에** 호출해야 합니다.
 *    db.ts 가 파일을 읽어들이는 순간 DB 위치를 정해버리기 때문입니다.
 *    그래서 각 테스트 파일은 이걸 먼저 호출한 뒤 await import 로 가져옵니다.
 */
export function setUpTempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'baemin-bot-test-'));
  process.env.BAEMIN_BOT_DATA_DIR = dir;

  // 테스트가 끝나면 치웁니다.
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

  return dir;
}

/** 테스트에서 쓸 계좌. 실제 계좌가 아닙니다. */
export const TEST_ACCOUNT = {
  bank_name: '테스트은행',
  account_number: '0000-00-0000000',
  account_holder: '홍길동',
};
