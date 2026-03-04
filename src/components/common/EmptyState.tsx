interface Props {
  onAdd: () => void
}

export function EmptyState({ onAdd }: Props) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 py-16 px-6 text-center">
      {/* 간단한 일러스트 (SVG) */}
      <div className="w-16 h-16 mb-4 rounded-2xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
        <svg className="w-8 h-8 text-gray-300 dark:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
      </div>

      <p className="text-sm text-gray-400 dark:text-gray-500 mb-4 leading-relaxed">
        아직 기록이 없어요.<br />
        오늘의 첫 메모를 남겨보세요.
      </p>

      <button
        onClick={onAdd}
        className="text-sm px-4 py-2 rounded-lg bg-accent-500 text-white hover:bg-accent-600
                   transition-colors shadow-sm"
      >
        + 메모 추가
      </button>
    </div>
  )
}
