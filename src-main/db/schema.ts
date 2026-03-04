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
      type        TEXT NOT NULL CHECK(type IN ('text','checklist')),
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
  `)
}
