/**
 * SQLite 데이터베이스 연결과 테이블 정의.
 *
 * Node 26에 내장된 node:sqlite를 씁니다. 별도 설치나 빌드가 필요 없습니다.
 * DB 파일은 프로젝트 안 data/baemin-bot.db 에 만들어지고, .gitignore에 이미 제외돼 있습니다.
 */

import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

/*
 * node:sqlite 를 왜 이렇게 가져오나?
 *
 * 평범하게 `import { DatabaseSync } from 'node:sqlite'` 라고 쓰면
 * Next.js 개발 서버가 파일을 고칠 때마다(hot reload) 모듈을 다시 평가하는데,
 * 그 과정에서 "require is not defined" 오류가 나면서 대시보드가 500이 됩니다.
 *
 * process.getBuiltinModule 은 번들러를 거치지 않고 Node 내장 모듈을 바로 꺼내오기
 * 때문에 이 문제를 피할 수 있습니다. 타입은 위에서 import type 으로 따로 가져옵니다.
 */
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

type DatabaseSync = DatabaseSyncType;

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'baemin-bot.db');

// 슬랙봇 프로세스와 Next.js 프로세스가 각각 이 파일을 불러오므로,
// 한 프로세스 안에서는 연결을 딱 하나만 만들어 재사용합니다.
let db: DatabaseSync | null = null;

// 열어둔 연결이 "어느 파일"을 보고 있는지 기억해두는 값. 아래 설명 참고.
let openedFileId: number | null = null;

export function getDb(): DatabaseSync {
  /*
   * 왜 파일을 매번 확인하나?
   *
   * 한 번 연 DB 연결은 파일 "이름"이 아니라 파일 "실체"를 붙잡습니다.
   * 그래서 서버가 떠 있는 동안 data 폴더를 지우고 다시 만들면
   * (예: 샘플 데이터를 지우려고 rm -rf data 를 했을 때)
   * 연결은 계속 지워진 옛날 파일을 보게 되고, 새 데이터가 화면에 안 나타납니다.
   *
   * inode 는 파일마다 붙는 고유 번호입니다. 이 번호가 달라졌다면
   * 같은 경로라도 다른 파일이라는 뜻이므로, 연결을 다시 맺습니다.
   */
  const fileId = statSync(DB_PATH, { throwIfNoEntry: false })?.ino ?? null;

  if (db && fileId !== null && fileId === openedFileId) return db;

  // 파일이 바뀌었거나 지워졌으면 옛 연결을 정리합니다.
  if (db) {
    db.close();
    db = null;
    openedFileId = null;
  }

  mkdirSync(DATA_DIR, { recursive: true }); // data 폴더가 없으면 만듭니다.
  db = new DatabaseSync(DB_PATH);

  // WAL 모드: 봇이 쓰는 동안에도 웹 대시보드가 읽을 수 있게 해줍니다.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  migrate(db);
  openedFileId = statSync(DB_PATH).ino;
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
      organizer_id   TEXT NOT NULL,      -- 파티장(팟을 만든 사람)의 슬랙 ID
      title          TEXT NOT NULL,      -- 예: "김치찌개 먹으러 갈 사람"
      place          TEXT,               -- 모이는 장소. '1F' 또는 'B1' (blocks.ts 의 PLACES)
      meet_at        TEXT,               -- 모이는 시간만 (자유 입력, 예: "12:10")
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
