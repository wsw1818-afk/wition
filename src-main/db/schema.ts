import type Database from 'better-sqlite3'

export function initializeSchema(db: Database.Database): void {
  // 각 테이블을 개별적으로 생성 (하나가 실패해도 나머지는 실행)
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_day (
      id          TEXT PRIMARY KEY,
      mood        TEXT,
      summary     TEXT,
      note_count  INTEGER NOT NULL DEFAULT 0,
      has_notes   INTEGER NOT NULL DEFAULT 0,
      updated_at  INTEGER NOT NULL
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS note_item (
      id          TEXT PRIMARY KEY,
      day_id      TEXT NOT NULL,
      type        TEXT NOT NULL,
      content     TEXT NOT NULL DEFAULT '',
      tags        TEXT NOT NULL DEFAULT '[]',
      pinned      INTEGER NOT NULL DEFAULT 0,
      order_index INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    )
  `)

  db.exec(`CREATE INDEX IF NOT EXISTS idx_noteitem_dayid ON note_item(day_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_noteitem_dayid_order ON note_item(day_id, pinned DESC, order_index ASC)`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS alarm (
      id          TEXT PRIMARY KEY,
      day_id      TEXT NOT NULL,
      time        TEXT NOT NULL,
      label       TEXT NOT NULL DEFAULT '',
      repeat      TEXT NOT NULL DEFAULT 'none',
      enabled     INTEGER NOT NULL DEFAULT 1,
      fired       INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    )
  `)

  db.exec(`CREATE INDEX IF NOT EXISTS idx_alarm_dayid ON alarm(day_id)`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS deleted_items (
      table_name  TEXT NOT NULL,
      item_id     TEXT NOT NULL,
      deleted_at  INTEGER NOT NULL,
      PRIMARY KEY (table_name, item_id)
    )
  `)

  // 마이그레이션: alarm 테이블에 repeat 컬럼 추가 (기존 DB 호환)
  try {
    db.exec(`ALTER TABLE alarm ADD COLUMN repeat TEXT NOT NULL DEFAULT 'none'`)
  } catch {
    // 이미 존재하면 무시
  }

  // 마이그레이션: note_item 테이블의 CHECK 제약조건 제거
  try {
    const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='note_item'").get() as { sql: string } | undefined
    if (tableInfo?.sql && tableInfo.sql.includes('CHECK')) {
      console.log('[Migration] CHECK 제약조건 감지 → 테이블 재생성 시작')
      db.exec(`
        CREATE TABLE note_item_new (
          id          TEXT PRIMARY KEY,
          day_id      TEXT NOT NULL,
          type        TEXT NOT NULL,
          content     TEXT NOT NULL DEFAULT '',
          tags        TEXT NOT NULL DEFAULT '[]',
          pinned      INTEGER NOT NULL DEFAULT 0,
          order_index INTEGER NOT NULL,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        )
      `)
      db.exec(`INSERT INTO note_item_new SELECT id, day_id, type, content, tags, pinned, order_index, created_at, updated_at FROM note_item`)
      db.exec(`DROP TABLE note_item`)
      db.exec(`ALTER TABLE note_item_new RENAME TO note_item`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_noteitem_dayid ON note_item(day_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_noteitem_dayid_order ON note_item(day_id, pinned DESC, order_index ASC)`)
      console.log('[Migration] note_item CHECK 제약조건 제거 완료')
    }
  } catch (e) {
    console.error('[Migration] note_item CHECK 제거 실패:', e)
  }
}
