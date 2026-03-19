import { useState, useRef, useEffect, useCallback } from 'react'
import type { NoteItem } from '../../types'
import { parseCodeBlock } from '../../types'
import { BlockActions } from './BlockActions'
import { TagInput } from './TagInput'
import { parseTags } from '../../types'

interface Props {
  item: NoteItem
  onUpdate: (content: string) => void
  onTagsChange: (tags: string[]) => void
  onDelete: () => void
  onTogglePin: () => void
  onCopyMove?: () => void
}

const LANGUAGES = ['text', 'javascript', 'typescript', 'python', 'html', 'css', 'json', 'sql', 'bash', 'java', 'c', 'cpp', 'go', 'rust']

export function CodeBlock({ item, onUpdate, onTagsChange, onDelete, onTogglePin, onCopyMove }: Props) {
  const data = parseCodeBlock(item.content)
  const [code, setCode] = useState(data.code)
  const [language, setLanguage] = useState(data.language)
  const [editing, setEditing] = useState(!data.code)
  const ref = useRef<HTMLTextAreaElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const d = parseCodeBlock(item.content)
    setCode(d.code)
    setLanguage(d.language)
  }, [item.content])

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus()
      autoResize(ref.current)
    }
  }, [editing])

  const doSave = useCallback((c: string, l: string) => {
    onUpdate(JSON.stringify({ language: l, code: c }))
  }, [onUpdate])

  const autoSave = useCallback((value: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSave(value, language), 1000)
  }, [language, doSave])

  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [])

  function save() {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setEditing(false)
    doSave(code, language)
  }

  function changeLang(l: string) {
    setLanguage(l)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    doSave(code, l)
  }

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = 'auto'
    el.style.height = Math.max(el.scrollHeight, 60) + 'px'
  }

  function handleCopy() {
    navigator.clipboard.writeText(data.code)
  }

  // Tab 키 지원
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = ref.current!
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const newVal = code.slice(0, start) + '  ' + code.slice(end)
      setCode(newVal)
      autoSave(newVal)
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start + 2 })
    }
    if (e.key === 'Escape') save()
  }

  return (
    <div className={`group relative rounded-lg transition-colors
      ${item.pinned ? 'border-l-2 border-accent-400' : ''}`}
    >
      <div className="rounded-lg bg-gray-900 dark:bg-gray-950 overflow-hidden">
        {/* 헤더: 언어 선택 + 복사 */}
        <div className="flex items-center justify-between px-3 py-1.5 bg-gray-800 dark:bg-gray-900
                        border-b border-gray-700">
          <select
            value={language}
            onChange={(e) => changeLang(e.target.value)}
            className="text-xs bg-transparent text-gray-400 outline-none cursor-pointer"
          >
            {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <button
            onClick={handleCopy}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            title="복사"
          >
            복사
          </button>
        </div>

        {/* 코드 영역 */}
        {editing ? (
          <textarea
            ref={ref}
            value={code}
            onChange={(e) => { setCode(e.target.value); autoResize(e.target); autoSave(e.target.value) }}
            onBlur={save}
            onKeyDown={handleKeyDown}
            className="w-full bg-transparent text-base text-green-400 font-mono resize-none
                       outline-none leading-relaxed px-3 py-2 min-h-[60px]"
            placeholder="코드를 입력하세요..."
            spellCheck={false}
          />
        ) : (
          <pre
            onClick={() => setEditing(true)}
            className="text-base text-green-400 font-mono whitespace-pre-wrap leading-relaxed
                       cursor-text px-3 py-2 min-h-[40px]"
          >
            {data.code || <span className="text-gray-600">코드를 입력하세요...</span>}
          </pre>
        )}
      </div>

      <TagInput tags={parseTags(item.tags)} onChange={onTagsChange} />
      <BlockActions item={item} onDelete={onDelete} onTogglePin={onTogglePin} onCopyMove={onCopyMove} />
    </div>
  )
}
