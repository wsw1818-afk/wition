const MOODS = ['😊', '😐', '😔', '🔥', '💡', '🎉', '😴', '💪']

interface Props {
  selected: string | null
  onChange: (mood: string | null) => void
}

export function MoodPicker({ selected, onChange }: Props) {
  return (
    <div className="flex items-center gap-1">
      {MOODS.map((m) => (
        <button
          key={m}
          onClick={() => onChange(selected === m ? null : m)}
          className={`w-7 h-7 rounded-md flex items-center justify-center text-base
                      transition-all duration-100
                      ${selected === m
                        ? 'bg-accent-100 dark:bg-accent-500/20 scale-110 ring-1 ring-accent-300'
                        : 'hover:bg-gray-100 dark:hover:bg-gray-800 opacity-60 hover:opacity-100'}`}
          title={m}
        >
          {m}
        </button>
      ))}
    </div>
  )
}
