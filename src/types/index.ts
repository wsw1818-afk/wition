/* ───────────────────────── 핵심 데이터 모델 ─────────────────────── */

export type BlockType = 'text' | 'checklist'

/** 달력 셀 표시용 (NoteDay 테이블 1:1) */
export interface NoteDay {
  id: string            // "YYYY-MM-DD"
  mood: string | null
  summary: string | null
  note_count: number
  has_notes: number     // 0 | 1
  updated_at: number
}

/** 메모 블록 (NoteItem 테이블 1:1) */
export interface NoteItem {
  id: string
  day_id: string
  type: BlockType
  content: string       // text → 문자열, checklist → ChecklistEntry[] JSON
  tags: string          // string[] JSON
  pinned: number        // 0 | 1
  order_index: number
  created_at: number
  updated_at: number
}

/** 체크리스트 블록 내부 항목 */
export interface ChecklistEntry {
  id: string
  text: string
  done: boolean
}

/* ──────────────────────── content 파싱 헬퍼 ──────────────────────── */

export function parseChecklist(content: string): ChecklistEntry[] {
  try { return JSON.parse(content) }
  catch { return [] }
}

export function parseTags(tags: string): string[] {
  try { return JSON.parse(tags) }
  catch { return [] }
}

/* ──────────────────────── window.api 타입 ────────────────────────── */

export interface ElectronAPI {
  getNoteDays:      (yearMonth: string) => Promise<NoteDay[]>
  getNoteDay:       (date: string) => Promise<NoteDay | null>
  getNoteItems:     (dayId: string) => Promise<NoteItem[]>
  search:           (query: string) => Promise<NoteItem[]>
  upsertNoteItem:   (item: NoteItem) => Promise<NoteDay | null>
  deleteNoteItem:   (id: string, dayId: string) => Promise<NoteDay | null>
  reorderNoteItems: (dayId: string, orderedIds: string[]) => Promise<void>
  updateMood:       (dayId: string, mood: string | null) => Promise<void>
  isDarkMode:       () => Promise<boolean>
  setDarkMode:      (mode: string) => Promise<boolean>
  getAutoLaunch:    () => Promise<boolean>
  setAutoLaunch:    (enabled: boolean) => Promise<void>
  getDataPath:      () => Promise<string>
  changeDataPath:   () => Promise<string | null>
  openDataFolder:   () => Promise<void>
  exportData:       () => Promise<string | null>
  importData:       () => Promise<boolean>
  attachFile:       () => Promise<{ name: string; path: string; size: number }[] | null>
  openAttachment:   (fileName: string) => Promise<boolean>
  getBackupConfig:  () => Promise<{ autoBackup: boolean; backupPath: string; backupIntervalMin: number; backupKeepCount: number }>
  setBackupConfig:  (cfg: Partial<{ autoBackup: boolean; backupPath: string; backupIntervalMin: number; backupKeepCount: number }>) => Promise<void>
  changeBackupPath: () => Promise<string | null>
  runBackupNow:     () => Promise<boolean>
  checkConflicts:   () => Promise<string[]>
  minimize:         () => void
  maximize:         () => void
  close:            () => void
}

declare global {
  interface Window { api: ElectronAPI }
}
