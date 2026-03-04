import type Database from 'better-sqlite3'

/* ────────────────────────────── 타입 ────────────────────────────── */
export interface NoteDayRow {
  id: string
  mood: string | null
  summary: string | null
  note_count: number
  has_notes: number
  updated_at: number
}

export interface NoteItemRow {
  id: string
  day_id: string
  type: string
  content: string
  tags: string
  pinned: number
  order_index: number
  created_at: number
  updated_at: number
}

/* ────────────────────────────── READ ────────────────────────────── */

/** 월 단위 NoteDay 조회 (달력 dot 표시용) */
export function getNoteDaysByMonth(db: Database.Database, yearMonth: string): NoteDayRow[] {
  const pattern = `${yearMonth}-%`
  return db
    .prepare('SELECT * FROM note_day WHERE id LIKE ? ORDER BY id')
    .all(pattern) as NoteDayRow[]
}

/** 단일 NoteDay 조회 */
export function getNoteDay(db: Database.Database, date: string): NoteDayRow | undefined {
  return db
    .prepare('SELECT * FROM note_day WHERE id = ?')
    .get(date) as NoteDayRow | undefined
}

/** 해당 날짜의 NoteItem 목록 (pinned 우선, order_index 순) */
export function getNoteItems(db: Database.Database, dayId: string): NoteItemRow[] {
  return db
    .prepare('SELECT * FROM note_item WHERE day_id = ? ORDER BY pinned DESC, order_index ASC')
    .all(dayId) as NoteItemRow[]
}

/** 전체 검색 (content, tags 대상, 최대 100건) */
export function searchItems(db: Database.Database, query: string): NoteItemRow[] {
  const like = `%${query}%`
  return db
    .prepare(`
      SELECT * FROM note_item
      WHERE content LIKE @q OR tags LIKE @q
      ORDER BY updated_at DESC
      LIMIT 100
    `)
    .all({ q: like }) as NoteItemRow[]
}

/* ────────────────────────────── WRITE ───────────────────────────── */

/** NoteItem 추가 또는 수정 + NoteDay 캐시 자동 갱신 (트랜잭션) */
export function upsertNoteItem(db: Database.Database, item: NoteItemRow): NoteDayRow | undefined {
  const now = Date.now()
  const run = db.transaction(() => {
    db.prepare(`
      INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at)
      VALUES (@id, @day_id, @type, @content, @tags, @pinned, @order_index, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        type=@type, content=@content, tags=@tags,
        pinned=@pinned, order_index=@order_index, updated_at=@updated_at
    `).run({ ...item, updated_at: now })

    refreshDayCache(db, item.day_id, now)
    return getNoteDay(db, item.day_id)
  })
  return run()
}

/** NoteItem 삭제 + NoteDay 캐시 자동 갱신 (트랜잭션) */
export function deleteNoteItem(db: Database.Database, id: string, dayId: string): NoteDayRow | undefined {
  const now = Date.now()
  const run = db.transaction(() => {
    db.prepare('DELETE FROM note_item WHERE id = ?').run(id)
    refreshDayCache(db, dayId, now)
    return getNoteDay(db, dayId)
  })
  return run()
}

/** NoteItem 순서 변경 + updated_at 갱신 (트랜잭션) */
export function reorderNoteItems(db: Database.Database, dayId: string, orderedIds: string[]): void {
  const now = Date.now()
  const run = db.transaction(() => {
    const stmt = db.prepare(
      'UPDATE note_item SET order_index = @idx, updated_at = @now WHERE id = @id AND day_id = @dayId'
    )
    orderedIds.forEach((id, idx) => stmt.run({ idx, now, id, dayId }))
    refreshDayCache(db, dayId, now)
  })
  run()
}

/** 감정 이모지 설정 */
export function updateMood(db: Database.Database, dayId: string, mood: string | null): void {
  const now = Date.now()
  db.prepare(`
    INSERT INTO note_day (id, mood, note_count, has_notes, updated_at)
    VALUES (@id, @mood, 0, 0, @now)
    ON CONFLICT(id) DO UPDATE SET mood = @mood, updated_at = @now
  `).run({ id: dayId, mood, now })
}

/* ────────────────────────── 내부 헬퍼 ──────────────────────────── */

/** NoteDay의 캐시 컬럼(note_count, has_notes, summary)을 재계산 */
function refreshDayCache(db: Database.Database, dayId: string, now: number): void {
  // 단일 쿼리로 count + 첫 번째 아이템 조회
  const stat = db.prepare(`
    SELECT
      COUNT(*) AS cnt,
      (SELECT content FROM note_item WHERE day_id = @dayId ORDER BY order_index ASC LIMIT 1) AS first_content,
      (SELECT type    FROM note_item WHERE day_id = @dayId ORDER BY order_index ASC LIMIT 1) AS first_type
    FROM note_item
    WHERE day_id = @dayId
  `).get({ dayId }) as { cnt: number; first_content: string | null; first_type: string | null }

  const count = stat.cnt
  let summary: string | null = null

  if (stat.first_content) {
    if (stat.first_type === 'checklist') {
      try {
        const items = JSON.parse(stat.first_content) as Array<{ text: string }>
        summary = items.map(i => i.text).join(', ').slice(0, 80)
      } catch { /* 파싱 실패 시 null */ }
    } else {
      summary = stat.first_content.slice(0, 80)
    }
  }

  db.prepare(`
    INSERT INTO note_day (id, note_count, has_notes, summary, updated_at)
    VALUES (@id, @count, @hasNotes, @summary, @now)
    ON CONFLICT(id) DO UPDATE SET
      note_count = @count, has_notes = @hasNotes, summary = @summary, updated_at = @now
  `).run({ id: dayId, count, hasNotes: count > 0 ? 1 : 0, summary, now })
}
