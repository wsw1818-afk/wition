import type Database from 'better-sqlite3'

export function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_day (
      id          TEXT PRIMARY KEY,         -- "YYYY-MM-DD"
      mood        TEXT,
      summary     TEXT,                     -- 첫 블록 80자 캐시
      note_count  INTEGER NOT NULL DEFAULT 0,
      has_notes   INTEGER NOT NULL DEFAULT 0,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS note_item (
      id          TEXT PRIMARY KEY,         -- UUID
      day_id      TEXT NOT NULL,
      type        TEXT NOT NULL,
      content     TEXT NOT NULL DEFAULT '',
      tags        TEXT NOT NULL DEFAULT '[]',
      pinned      INTEGER NOT NULL DEFAULT 0,
      order_index INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_noteitem_dayid
      ON note_item(day_id);
    CREATE INDEX IF NOT EXISTS idx_noteitem_dayid_order
      ON note_item(day_id, pinned DESC, order_index ASC);

    CREATE TABLE IF NOT EXISTS alarm (
      id          TEXT PRIMARY KEY,         -- UUID
      day_id      TEXT NOT NULL,            -- "YYYY-MM-DD"
      time        TEXT NOT NULL,            -- "HH:mm"
      label       TEXT NOT NULL DEFAULT '',
      repeat      TEXT NOT NULL DEFAULT 'none', -- "none"|"daily"|"weekdays"|"weekly"
      enabled     INTEGER NOT NULL DEFAULT 1,
      fired       INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_alarm_dayid
      ON alarm(day_id);

    -- 삭제 tombstone (오프라인 삭제 → 동기화 시 원격 반영용)
    CREATE TABLE IF NOT EXISTS deleted_items (
      table_name  TEXT NOT NULL,            -- "note_item" | "alarm" | "note_day"
      item_id     TEXT NOT NULL,
      deleted_at  INTEGER NOT NULL,
      PRIMARY KEY (table_name, item_id)
    );
  `)

  // 마이그레이션: alarm 테이블에 repeat 컬럼 추가 (기존 DB 호환)
  try {
    db.exec(`ALTER TABLE alarm ADD COLUMN repeat TEXT NOT NULL DEFAULT 'none'`)
  } catch {
    // 이미 존재하면 무시
  }
}
