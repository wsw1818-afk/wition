/** 인라인 마크다운 서식을 React 엘리먼트로 렌더링
 *  지원: **굵게**, *기울임*, `코드`, [링크](url), [file:경로], [[YYYY-MM-DD]]
 */
export function InlineRenderer({ text, onDateClick }: { text: string; onDateClick?: (date: string) => void }) {
  const parts = parseInline(text)
  if (parts.length === 1 && parts[0].type === 'text') return <>{text}</>

  return (
    <>
      {parts.map((part, i) => {
        switch (part.type) {
          case 'bold':
            return <strong key={i} className="font-semibold">{part.content}</strong>
          case 'italic':
            return <em key={i}>{part.content}</em>
          case 'code':
            return (
              <code key={i} className="px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-800
                                       text-red-500 dark:text-red-400 text-[13px] font-mono">
                {part.content}
              </code>
            )
          case 'link':
            return (
              <a key={i} href={part.url} target="_blank" rel="noopener noreferrer"
                className="text-accent-500 hover:underline cursor-pointer">
                {part.content}
              </a>
            )
          case 'datelink': {
            const dateStr = part.content
            return (
              <button
                key={i}
                onClick={(e) => { e.stopPropagation(); onDateClick?.(dateStr) }}
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded
                           bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400
                           hover:bg-blue-100 dark:hover:bg-blue-500/20 transition-colors cursor-pointer text-[13px]"
                title={`${dateStr}로 이동`}
              >
                📅 {dateStr}
              </button>
            )
          }
          case 'file': {
            // timestamp prefix 제거하여 원본 파일명 표시
            const displayName = part.content.replace(/^\d+_/, '')
            return (
              <button key={i}
                onClick={(e) => { e.stopPropagation(); window.api.openAttachment(part.content) }}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded
                           bg-accent-50 dark:bg-accent-500/10 text-accent-600 dark:text-accent-400
                           hover:bg-accent-100 dark:hover:bg-accent-500/20 transition-colors cursor-pointer"
                title={`파일 열기: ${displayName}`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                  <polyline points="13 2 13 9 20 9" />
                </svg>
                {displayName}
              </button>
            )
          }
          default:
            return <span key={i}>{part.content}</span>
        }
      })}
    </>
  )
}

interface InlinePart {
  type: 'text' | 'bold' | 'italic' | 'code' | 'link' | 'file' | 'datelink'
  content: string
  url?: string
}

function parseInline(text: string): InlinePart[] {
  const parts: InlinePart[] = []
  // 순서: datelink → file → link → bold → code → italic
  const regex = /\[\[(\d{4}-\d{2}-\d{2})\]\]|\[file:(.+?)\]|\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|`(.+?)`|\*(.+?)\*/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: text.slice(lastIndex, match.index) })
    }
    if (match[1] !== undefined) {
      parts.push({ type: 'datelink', content: match[1] })
    } else if (match[2] !== undefined) {
      parts.push({ type: 'file', content: match[2] })
    } else if (match[3] !== undefined) {
      parts.push({ type: 'link', content: match[3], url: match[4] })
    } else if (match[5] !== undefined) {
      parts.push({ type: 'bold', content: match[5] })
    } else if (match[6] !== undefined) {
      parts.push({ type: 'code', content: match[6] })
    } else if (match[7] !== undefined) {
      parts.push({ type: 'italic', content: match[7] })
    }
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', content: text.slice(lastIndex) })
  }

  if (parts.length === 0) parts.push({ type: 'text', content: text })
  return parts
}
