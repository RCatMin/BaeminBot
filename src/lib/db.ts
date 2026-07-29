/**
 * SQLite 데이터베이스 연결과 테이블 정의.
 *
 * Node 26에 내장된 node:sqlite를 씁니다. 별도 설치나 빌드가 필요 없습니다.
 * DB 파일은 프로젝트 안 data/baemin-bot.db 에 만들어지고, .gitignore에 이미 제외돼 있습니다.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'baemin-bot.db');

// 슬랙봇 프로세스와 Next.js 프로세스가 각각 이 파일을 불러오므로,
// 한 프로세스 안에서는 연결을 딱 하나만 만들어 재사용합니다.
let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;

  mkdirSync(DATA_DIR, { recursive: true }); // data 폴더가 없으면 만듭니다.
  db = new DatabaseSync(DB_PATH);

  // WAL 모드: 봇이 쓰는 동안에도 웹 대시보드가 읽을 수 있게 해줍니다.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  migrate(db);
  return db;
}

/** 테이블이 없으면 만듭니다. 이미 있으면 아무 일도 일어나지 않습니다. */
function migrate(database: DatabaseSync): void {
  database.exec(`
    -- 사용자별로 계좌를 한 번 등록해두면 다음 팟부터 자동으로 채워집니다.
    CREATE TABLE IF NOT EXISTS users (
      slack_user_id  TEXT PRIMARY KEY,
      display_name   TEXT,
      bank_name      TEXT,
      account_number TEXT,
      account_holder TEXT,
      updated_at     TEXT NOT NULL
    );

    -- 점심팟 한 건
    CREATE TABLE IF NOT EXISTS pots (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id     TEXT NOT NULL,
      message_ts     TEXT,               -- 모집 메시지의 타임스탬프(=주소). 버튼 눌릴 때 이 메시지를 수정합니다.
      organizer_id   TEXT NOT NULL,      -- 팟장(팟을 만든 사람)의 슬랙 ID
      title          TEXT NOT NULL,      -- 예: "김치찌개 먹으러 갈 사람"
      place          TEXT,               -- 가게 이름
      meet_at        TEXT,               -- 모이는 시간 (자유 입력, 예: "12:10 로비")
      capacity       INTEGER NOT NULL DEFAULT 0,  -- 정원. 0이면 무제한
      status         TEXT NOT NULL,      -- RECRUITING | CLOSED | SETTLING | SETTLED
      bank_name      TEXT,
      account_number TEXT,
      account_holder TEXT,
      total_amount   INTEGER,            -- 총 결제 금액 (정산 시작할 때 입력)
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );

    -- 팟 참여자. (pot_id, slack_user_id) 조합이 유일하므로 중복 참여가 불가능합니다.
    CREATE TABLE IF NOT EXISTS participants (
      pot_id        INTEGER NOT NULL REFERENCES pots(id) ON DELETE CASCADE,
      slack_user_id TEXT NOT NULL,
      joined_at     TEXT NOT NULL,
      paid          INTEGER NOT NULL DEFAULT 0,  -- 0=미입금, 1=입금완료
      paid_at       TEXT,
      dm_channel_id TEXT,               -- 정산 DM을 보낸 대화방 주소
      dm_ts         TEXT,               -- 정산 DM 메시지 주소 (입금 완료 시 메시지를 수정하려고 저장)
      PRIMARY KEY (pot_id, slack_user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_pots_status ON pots(status);
    CREATE INDEX IF NOT EXISTS idx_participants_pot ON participants(pot_id);
  `);
}

/** 지금 시각을 DB에 저장할 문자열(ISO)로 만듭니다. */
export function now(): string {
  return new Date().toISOString();
}
