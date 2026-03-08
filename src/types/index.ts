/* ───────────────────────── 핵심 데이터 모델 ─────────────────────── */

export type BlockType =
  | 'text'
  | 'checklist'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bulleted_list'
  | 'numbered_list'
  | 'quote'
  | 'divider'
  | 'callout'
  | 'code'
  | 'toggle'

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

/** 블록 타입별 기본 content 값 */
export function getDefaultContent(type: BlockType): string {
  switch (type) {
    case 'checklist':
      return JSON.stringify([{ id: crypto.randomUUID?.() || String(Date.now()), text: '', done: false }])
    case 'divider':
      return '---'
    case 'callout':
      return JSON.stringify({ emoji: '💡', text: '' })
    case 'code':
      return JSON.stringify({ language: 'text', code: '' })
    case 'toggle':
      return JSON.stringify({ title: '', children: '' })
    default:
      return ''
  }
}

/** 콜아웃 블록 내부 구조 */
export interface CalloutData {
  emoji: string
  text: string
}

/** 코드 블록 내부 구조 */
export interface CodeBlockData {
  language: string
  code: string
}

/** 토글 블록 내부 구조 */
export interface ToggleData {
  title: string
  children: string
}

export function parseCallout(content: string): CalloutData {
  try { return JSON.parse(content) }
  catch { return { emoji: '💡', text: '' } }
}

export function parseCodeBlock(content: string): CodeBlockData {
  try { return JSON.parse(content) }
  catch { return { language: 'text', code: '' } }
}

export function parseToggle(content: string): ToggleData {
  try { return JSON.parse(content) }
  catch { return { title: '', children: '' } }
}

/** 슬래시 커맨드 메뉴 항목 */
export interface SlashMenuItem {
  type: BlockType
  label: string
  description: string
  icon: string
}

export const SLASH_MENU_ITEMS: SlashMenuItem[] = [
  { type: 'text',          label: '텍스트',       description: '일반 텍스트 블록',     icon: 'T' },
  { type: 'heading1',      label: '제목 1',       description: '큰 제목',              icon: 'H1' },
  { type: 'heading2',      label: '제목 2',       description: '중간 제목',            icon: 'H2' },
  { type: 'heading3',      label: '제목 3',       description: '작은 제목',            icon: 'H3' },
  { type: 'bulleted_list', label: '글머리 기호',   description: '순서 없는 목록',       icon: '•' },
  { type: 'numbered_list', label: '번호 목록',    description: '순서 있는 목록',       icon: '1.' },
  { type: 'checklist',     label: '체크리스트',   description: '할 일 목록',           icon: '☑' },
  { type: 'quote',         label: '인용',         description: '인용문 블록',          icon: '❝' },
  { type: 'divider',       label: '구분선',       description: '수평 구분선',          icon: '—' },
  { type: 'callout',       label: '콜아웃',       description: '강조 블록',            icon: '💡' },
  { type: 'code',          label: '코드',         description: '코드 블록',            icon: '</>' },
  { type: 'toggle',        label: '토글',         description: '접기/펼치기 블록',     icon: '▶' },
]

/** 알람 반복 유형 */
export type RepeatType = 'none' | 'daily' | 'weekdays' | 'weekly'

export const REPEAT_LABELS: Record<RepeatType, string> = {
  none: '반복 없음',
  daily: '매일',
  weekdays: '평일 (월~금)',
  weekly: '매주',
}

/** 알람 (alarm 테이블 1:1) */
export interface Alarm {
  id: string
  day_id: string
  time: string          // "HH:mm"
  label: string
  repeat: RepeatType
  enabled: number       // 0 | 1
  fired: number         // 0 | 1
  created_at: number
  updated_at: number
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

export interface AuthUser {
  id: string
  email: string
}

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
  saveClipboardImage: (base64: string) => Promise<{ name: string; path: string; size: number } | null>
  getCalendarWidth: () => Promise<number>
  setCalendarWidth: (width: number) => Promise<void>
  syncNow:          () => Promise<{ ok: boolean; pulled?: number; pushed?: number; reason?: string }>
  getSyncStatus:    () => Promise<{ online: boolean; reachable: boolean; lastSyncAt: number }>
  onSyncDone:       (cb: () => void) => () => void
  onSyncStatus:     (cb: (status: string) => void) => () => void
  getAlarms:           (dayId: string) => Promise<Alarm[]>
  upsertAlarm:         (alarm: Alarm) => Promise<boolean>
  deleteAlarm:         (id: string) => Promise<boolean>
  getAlarmDaysByMonth: (yearMonth: string) => Promise<string[]>
  getUpcomingAlarms:   (todayStr: string) => Promise<Alarm[]>
  onAlarmNavigate:     (cb: (dayId: string) => void) => () => void
  onAlarmFire:         (cb: (alarm: { id: string; day_id: string; time: string; label: string; repeat: string }) => void) => () => void
  authSignup:       (email: string, password: string) => Promise<{ ok: boolean; error?: string }>
  authLogin:        (email: string, password: string) => Promise<{ ok: boolean; user?: AuthUser; error?: string }>
  authLogout:       () => Promise<{ ok: boolean }>
  authGetSession:   () => Promise<{ authenticated: boolean; user?: AuthUser; offline?: boolean; reason?: string }>
  minimize:         () => void
  maximize:         () => void
  close:            () => void
}

declare global {
  interface Window { api: ElectronAPI }
}
