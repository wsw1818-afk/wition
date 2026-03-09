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

/** NoteItem 삭제 + NoteDay 캐시 자동 갱신 + tombstone 기록 (트랜잭션) */
export function deleteNoteItem(db: Database.Database, id: string, dayId: string): NoteDayRow | undefined {
  const now = Date.now()
  const run = db.transaction(() => {
    db.prepare('DELETE FROM note_item WHERE id = ?').run(id)
    addTombstone(db, 'note_item', id)
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

/* ────────────────────────── 알람 CRUD ──────────────────────────── */

export type RepeatType = 'none' | 'daily' | 'weekdays' | 'weekly'

export interface AlarmRow {
  id: string
  day_id: string
  time: string        // "HH:mm"
  label: string
  repeat: RepeatType  // 반복 유형
  enabled: number     // 0 | 1
  fired: number       // 0 | 1
  created_at: number
  updated_at: number
}

export function getAlarmsByDay(db: Database.Database, dayId: string): AlarmRow[] {
  return db
    .prepare('SELECT * FROM alarm WHERE day_id = ? ORDER BY time ASC')
    .all(dayId) as AlarmRow[]
}

export function getPendingAlarms(db: Database.Database): AlarmRow[] {
  return db
    .prepare('SELECT * FROM alarm WHERE enabled = 1 AND fired = 0 ORDER BY day_id, time')
    .all() as AlarmRow[]
}

export function upsertAlarm(db: Database.Database, alarm: AlarmRow): void {
  db.prepare(`
    INSERT INTO alarm (id, day_id, time, label, repeat, enabled, fired, created_at, updated_at)
    VALUES (@id, @day_id, @time, @label, @repeat, @enabled, @fired, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      day_id=@day_id, time=@time, label=@label, repeat=@repeat,
      enabled=@enabled, fired=@fired, updated_at=@updated_at
  `).run(alarm)
}

export function deleteAlarm(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM alarm WHERE id = ?').run(id)
  addTombstone(db, 'alarm', id)
}

export function markAlarmFired(db: Database.Database, id: string): void {
  db.prepare('UPDATE alarm SET fired = 1, updated_at = ? WHERE id = ?').run(Date.now(), id)
}

/** 월간 알람이 있는 날짜 목록 (달력 아이콘 표시용) */
export function getAlarmDaysByMonth(db: Database.Database, yearMonth: string): string[] {
  const pattern = `${yearMonth}-%`
  const rows = db
    .prepare('SELECT DISTINCT day_id FROM alarm WHERE day_id LIKE ? AND enabled = 1')
    .all(pattern) as Array<{ day_id: string }>
  return rows.map(r => r.day_id)
}

/** 다가오는 알람 (일회성은 오늘 이후, 반복은 시작일 이전도 포함, 최대 20건) */
export function getUpcomingAlarms(db: Database.Database, todayStr: string): AlarmRow[] {
  return db
    .prepare(`
      SELECT * FROM alarm
      WHERE enabled = 1 AND (fired = 0 OR repeat != 'none')
        AND (day_id >= ? OR repeat != 'none')
      ORDER BY
        CASE WHEN repeat != 'none' THEN 0 ELSE 1 END,
        day_id ASC, time ASC
      LIMIT 20
    `)
    .all(todayStr) as AlarmRow[]
}

/** 반복 알람 목록 (repeat != 'none') */
export function getRepeatingAlarms(db: Database.Database): AlarmRow[] {
  return db
    .prepare("SELECT * FROM alarm WHERE repeat != 'none' AND enabled = 1 ORDER BY time ASC")
    .all() as AlarmRow[]
}

/** 반복 알람 fired 리셋 (매일 자정 호출용) */
export function resetRepeatingAlarmsFired(db: Database.Database): void {
  db.prepare("UPDATE alarm SET fired = 0, updated_at = ? WHERE repeat != 'none' AND fired = 1")
    .run(Date.now())
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
      // 인라인 마크다운/파일 태그 제거하여 순수 텍스트만 추출
      summary = stat.first_content
        .replace(/\[file:.+?\]/g, '')       // [file:경로] 제거
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [링크](url) → 링크 텍스트만
        .replace(/\*\*(.+?)\*\*/g, '$1')    // **굵게** → 굵게
        .replace(/\*(.+?)\*/g, '$1')        // *기울임* → 기울임
        .replace(/`(.+?)`/g, '$1')          // `코드` → 코드
        .replace(/\n/g, ' ')                // 줄바꿈 → 공백
        .trim()
        .slice(0, 80) || null
    }
  }

  db.prepare(`
    INSERT INTO note_day (id, note_count, has_notes, summary, updated_at)
    VALUES (@id, @count, @hasNotes, @summary, @now)
    ON CONFLICT(id) DO UPDATE SET
      note_count = @count, has_notes = @hasNotes, summary = @summary, updated_at = @now
  `).run({ id: dayId, count, hasNotes: count > 0 ? 1 : 0, summary, now })
}

/** 모든 날짜의 summary 캐시를 재계산 (앱 시작 시 1회, updated_at 유지) */
export function refreshAllSummaries(db: Database.Database): void {
  const days = db.prepare('SELECT id, updated_at FROM note_day WHERE has_notes = 1').all() as Array<{ id: string; updated_at: number }>
  for (const day of days) {
    // updated_at을 기존 값으로 유지하여 push 트리거 방지
    refreshDayCache(db, day.id, day.updated_at)
  }
}

/* ────────────────────── 삭제 Tombstone ──────────────────────── */

export interface DeletedItem {
  table_name: string
  item_id: string
  deleted_at: number
}

/** 삭제 tombstone 기록 */
export function addTombstone(db: Database.Database, tableName: string, itemId: string): void {
  db.prepare(`
    INSERT OR REPLACE INTO deleted_items (table_name, item_id, deleted_at)
    VALUES (?, ?, ?)
  `).run(tableName, itemId, Date.now())
}

/** 미처리 tombstone 조회 */
export function getTombstones(db: Database.Database): DeletedItem[] {
  return db.prepare('SELECT * FROM deleted_items').all() as DeletedItem[]
}

/** tombstone 존재 여부 확인 */
export function isTombstoned(db: Database.Database, tableName: string, itemId: string): boolean {
  const row = db.prepare('SELECT 1 FROM deleted_items WHERE table_name = ? AND item_id = ?').get(tableName, itemId)
  return !!row
}

/** 동기화 완료된 tombstone 삭제 */
export function clearTombstones(db: Database.Database, tableName: string, itemIds: string[]): void {
  if (itemIds.length === 0) return
  const placeholders = itemIds.map(() => '?').join(',')
  db.prepare(`DELETE FROM deleted_items WHERE table_name = ? AND item_id IN (${placeholders})`).run(tableName, ...itemIds)
}
