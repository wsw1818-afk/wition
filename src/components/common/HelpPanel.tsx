import { useState } from 'react'

interface Props {
  onClose: () => void
}

type Tab = 'basic' | 'blocks' | 'shortcuts' | 'sync' | 'tips'

const TABS: { id: Tab; label: string }[] = [
  { id: 'basic', label: '기본 사용법' },
  { id: 'blocks', label: '블록 종류' },
  { id: 'shortcuts', label: '단축키' },
  { id: 'sync', label: '클라우드 동기화' },
  { id: 'tips', label: '꿀팁' },
]

export function HelpPanel({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>('basic')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-[640px] max-h-[80vh] flex flex-col border border-gray-200 dark:border-gray-700"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
          <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100">Wition 도움말</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            &times;
          </button>
        </div>

        {/* 탭 */}
        <div className="flex gap-1 px-6 pt-3 border-b border-gray-100 dark:border-gray-800">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-xs font-medium rounded-t-lg transition-colors
                ${tab === t.id
                  ? 'bg-accent-50 dark:bg-accent-500/10 text-accent-600 dark:text-accent-400 border-b-2 border-accent-500'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* 내용 */}
        <div className="flex-1 overflow-y-auto px-6 py-4 text-sm text-gray-700 dark:text-gray-300 leading-relaxed space-y-4">
          {tab === 'basic' && <BasicHelp />}
          {tab === 'blocks' && <BlocksHelp />}
          {tab === 'shortcuts' && <ShortcutsHelp />}
          {tab === 'sync' && <SyncHelp />}
          {tab === 'tips' && <TipsHelp />}
        </div>

        {/* 푸터 */}
        <div className="px-6 py-3 border-t border-gray-100 dark:border-gray-800 text-center">
          <span className="text-[11px] text-gray-400">Wition v0.1.0</span>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="font-semibold text-gray-800 dark:text-gray-100 mb-2">{title}</h3>
      {children}
    </div>
  )
}

function BasicHelp() {
  return (
    <>
      <Section title="Wition이란?">
        <p>
          Wition은 <strong>캘린더 기반 블록 노트 앱</strong>입니다.
          날짜별로 메모를 작성하고, 다양한 블록 타입으로 내용을 구성할 수 있습니다.
          Notion처럼 블록 단위로 편집하면서, 달력으로 한눈에 기록을 관리합니다.
        </p>
      </Section>

      <Section title="1. 달력에서 날짜 선택">
        <ul className="list-disc ml-5 space-y-1">
          <li>왼쪽 달력에서 원하는 날짜를 클릭하면 오른쪽에 메모 패널이 열립니다.</li>
          <li>오늘 날짜는 <strong>강조 색상</strong>으로 표시됩니다.</li>
          <li>메모가 있는 날짜에는 <strong>점(dot)</strong>이 표시됩니다 (최대 3개).</li>
          <li>공휴일은 <strong className="text-red-500">빨간색</strong>으로 표시되며, 공휴일 이름도 함께 보입니다.</li>
          <li>월 이동은 상단의 <strong>&lt; &gt; 화살표</strong>를 클릭합니다.</li>
        </ul>
      </Section>

      <Section title="2. 메모 작성">
        <ul className="list-disc ml-5 space-y-1">
          <li>오른쪽 패널 하단의 <strong>입력창</strong>에 텍스트를 입력하고 Enter를 누릅니다.</li>
          <li><strong>/</strong>(슬래시)를 입력하면 블록 타입 선택 메뉴가 나타납니다.</li>
          <li>입력창 왼쪽의 <strong>+ 버튼</strong>을 눌러 파일을 첨부할 수 있습니다.</li>
          <li><strong>Ctrl+V</strong>로 클립보드의 스크린샷을 바로 붙여넣을 수 있습니다.</li>
        </ul>
      </Section>

      <Section title="3. 메모 편집">
        <ul className="list-disc ml-5 space-y-1">
          <li>작성된 블록을 <strong>클릭</strong>하면 인라인 편집 모드로 전환됩니다.</li>
          <li>블록 왼쪽의 <strong>드래그 핸들(⋮⋮)</strong>을 잡고 끌어서 순서를 변경합니다.</li>
          <li>블록에 마우스를 올리면 오른쪽에 <strong>메뉴 버튼(···)</strong>이 나타납니다.</li>
          <li>메뉴에서 블록 삭제, 고정(핀), 블록 타입 변환을 할 수 있습니다.</li>
        </ul>
      </Section>

      <Section title="4. 감정 이모지">
        <ul className="list-disc ml-5 space-y-1">
          <li>메모 패널 상단의 <strong>날짜 옆 이모지 버튼</strong>을 클릭합니다.</li>
          <li>그날의 기분을 이모지로 기록하면 달력 셀에도 표시됩니다.</li>
        </ul>
      </Section>

      <Section title="5. 검색">
        <ul className="list-disc ml-5 space-y-1">
          <li><strong>Ctrl+K</strong>를 눌러 검색 패널을 엽니다.</li>
          <li>메모 내용, 태그를 기준으로 전체 검색합니다.</li>
          <li>검색 결과를 클릭하면 해당 날짜로 이동합니다.</li>
        </ul>
      </Section>

      <Section title="6. 달력과 메모 패널 크기 조절">
        <ul className="list-disc ml-5 space-y-1">
          <li>달력과 메모 패널 사이의 <strong>구분선</strong>을 마우스로 드래그하면 너비를 조절할 수 있습니다.</li>
          <li>조절한 너비는 자동으로 저장되어 다음 실행 시에도 유지됩니다.</li>
        </ul>
      </Section>
    </>
  )
}

function BlocksHelp() {
  return (
    <>
      <Section title="블록 종류">
        <p className="mb-3">
          입력창에서 <strong>/</strong>(슬래시)를 입력하면 아래 블록 타입을 선택할 수 있습니다.
        </p>
        <div className="space-y-2">
          <BlockItem icon="T" name="텍스트" desc="일반 텍스트 블록. 기본 블록 타입입니다." />
          <BlockItem icon="H1" name="제목 1" desc="큰 제목. 섹션 구분에 사용합니다." />
          <BlockItem icon="H2" name="제목 2" desc="중간 제목." />
          <BlockItem icon="H3" name="제목 3" desc="작은 제목." />
          <BlockItem icon="•" name="글머리 기호" desc="순서 없는 목록. 항목 나열에 적합합니다." />
          <BlockItem icon="1." name="번호 목록" desc="순서 있는 목록. 단계별 설명에 적합합니다." />
          <BlockItem icon="☑" name="체크리스트" desc="할 일 목록. 체크박스로 완료 여부를 표시합니다." />
          <BlockItem icon="❝" name="인용" desc="인용문 블록. 참고 내용을 강조합니다." />
          <BlockItem icon="—" name="구분선" desc="수평 구분선. 내용을 시각적으로 분리합니다." />
          <BlockItem icon="💡" name="콜아웃" desc="강조 블록. 이모지 + 텍스트로 중요 내용을 표시합니다." />
          <BlockItem icon="</>" name="코드" desc="코드 블록. 프로그래밍 코드를 작성할 수 있습니다." />
          <BlockItem icon="▶" name="토글" desc="접기/펼치기 블록. 길어질 수 있는 내용을 접어둡니다." />
        </div>
      </Section>

      <Section title="텍스트 서식 (인라인 마크다운)">
        <p className="mb-2">텍스트 블록 안에서 마크다운 문법을 사용할 수 있습니다:</p>
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 space-y-1 text-xs font-mono">
          <p><strong>**굵게**</strong> → <strong>굵게</strong></p>
          <p><em>*기울임*</em> → <em>기울임</em></p>
          <p><code>`인라인 코드`</code> → <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">인라인 코드</code></p>
          <p>~~취소선~~ → <span className="line-through">취소선</span></p>
          <p>[file:파일명] → 첨부 파일 링크 (클릭하면 열림)</p>
        </div>
      </Section>
    </>
  )
}

function BlockItem({ icon, name, desc }: { icon: string; name: string; desc: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800 text-xs font-bold text-gray-600 dark:text-gray-300 flex-shrink-0">
        {icon}
      </span>
      <div>
        <span className="font-medium text-gray-800 dark:text-gray-100">{name}</span>
        <span className="text-gray-500 dark:text-gray-400 ml-2">{desc}</span>
      </div>
    </div>
  )
}

function ShortcutsHelp() {
  return (
    <>
      <Section title="전역 단축키">
        <ShortcutTable items={[
          ['Ctrl + K', '검색 패널 열기/닫기'],
          ['Ctrl + N', '오늘 날짜로 이동'],
          ['Ctrl + D', '다크 모드 전환'],
        ]} />
      </Section>

      <Section title="메모 편집 단축키">
        <ShortcutTable items={[
          ['Enter', '새 블록 추가 (입력창에서)'],
          ['/ (슬래시)', '블록 타입 선택 메뉴 열기'],
          ['Ctrl + V', '클립보드 이미지(스크린샷) 붙여넣기'],
          ['Esc', '편집 모드 종료 / 검색 패널 닫기'],
        ]} />
      </Section>

      <Section title="달력 단축키">
        <ShortcutTable items={[
          ['← →', '이전/다음 달 이동 (화살표 버튼)'],
          ['날짜 클릭', '해당 날짜 메모 패널 열기'],
        ]} />
      </Section>
    </>
  )
}

function ShortcutTable({ items }: { items: [string, string][] }) {
  return (
    <table className="w-full text-xs">
      <tbody>
        {items.map(([key, desc], i) => (
          <tr key={i} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
            <td className="py-2 pr-4 w-40">
              <kbd className="px-2 py-1 rounded bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 font-mono text-[11px]">
                {key}
              </kbd>
            </td>
            <td className="py-2 text-gray-600 dark:text-gray-400">{desc}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function SyncHelp() {
  return (
    <>
      <Section title="데이터 저장 방식">
        <p>
          Wition은 <strong>로컬 우선(Local-first)</strong> 방식으로 동작합니다.
          모든 데이터는 먼저 PC의 로컬 데이터베이스(SQLite)에 저장되므로,
          인터넷 연결 없이도 메모를 읽고 쓸 수 있습니다.
        </p>
      </Section>

      <Section title="클라우드 동기화 (Supabase)">
        <p className="mb-2">
          클라우드 동기화가 설정되어 있으면, 여러 PC에서 동일한 데이터를 사용할 수 있습니다.
        </p>
        <ul className="list-disc ml-5 space-y-1">
          <li><strong>자동 동기화</strong>: 앱 시작 시 자동으로 클라우드와 데이터를 동기화합니다.</li>
          <li><strong>실시간 반영</strong>: 메모 추가/수정/삭제 시 백그라운드로 클라우드에 반영됩니다.</li>
          <li><strong>오프라인 지원</strong>: 인터넷이 없어도 로컬에서 정상 동작하며, 다시 연결되면 동기화됩니다.</li>
          <li><strong>충돌 해결</strong>: 같은 메모가 두 곳에서 수정되면, 더 최근에 수정된 버전이 우선됩니다.</li>
        </ul>
      </Section>

      <Section title="다른 PC에서 사용하기">
        <ol className="list-decimal ml-5 space-y-2">
          <li>
            <strong>Wition.exe</strong> 파일을 다른 PC에 복사합니다.
          </li>
          <li>
            exe 파일과 같은 폴더에 <strong>.env</strong> 파일을 생성하고 아래 내용을 입력합니다:
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 mt-1 font-mono text-[11px]">
              <p>VITE_SUPABASE_URL=https://your-project.supabase.co</p>
              <p>VITE_SUPABASE_ANON_KEY=your-anon-key</p>
            </div>
          </li>
          <li>앱을 실행하면 자동으로 클라우드에서 데이터를 가져옵니다.</li>
        </ol>
      </Section>

      <Section title="클라우드 없이 사용하기">
        <p>
          <strong>.env</strong> 파일이 없거나 Supabase 설정이 없으면, 자동으로 <strong>오프라인 모드</strong>로 동작합니다.
          모든 데이터는 로컬에만 저장되며, 클라우드 동기화는 비활성화됩니다.
          언제든 .env 파일을 추가하면 동기화를 시작할 수 있습니다.
        </p>
      </Section>
    </>
  )
}

function TipsHelp() {
  return (
    <>
      <Section title="설정">
        <ul className="list-disc ml-5 space-y-1">
          <li>달력 하단의 <strong>⚙ 설정</strong>을 클릭하면 설정 패널이 열립니다.</li>
          <li><strong>저장 경로 변경</strong>: 데이터가 저장되는 폴더를 변경할 수 있습니다.</li>
          <li><strong>Windows 시작 시 자동 실행</strong>: PC 부팅 시 자동으로 Wition을 시작합니다.</li>
          <li><strong>자동 백업</strong>: 30분마다 자동으로 데이터를 JSON 파일로 백업합니다.</li>
        </ul>
      </Section>

      <Section title="데이터 백업 및 복원">
        <ul className="list-disc ml-5 space-y-1">
          <li><strong>내보내기</strong>: 모든 메모를 JSON 파일로 저장합니다.</li>
          <li><strong>가져오기</strong>: JSON 백업 파일에서 데이터를 복원합니다 (기존 데이터와 병합).</li>
          <li><strong>자동 백업</strong>: 설정에서 활성화하면 30분마다 자동 백업됩니다 (최대 10개 보관).</li>
        </ul>
      </Section>

      <Section title="시스템 트레이">
        <ul className="list-disc ml-5 space-y-1">
          <li>창을 닫으면 <strong>시스템 트레이로 최소화</strong>됩니다 (완전 종료가 아님).</li>
          <li>트레이 아이콘을 <strong>더블클릭</strong>하면 창이 다시 나타납니다.</li>
          <li>트레이 아이콘을 <strong>우클릭</strong> → "종료"를 선택하면 앱이 완전히 종료됩니다.</li>
        </ul>
      </Section>

      <Section title="파일 첨부">
        <ul className="list-disc ml-5 space-y-1">
          <li>입력창 왼쪽의 <strong>+ 버튼</strong>으로 파일을 첨부할 수 있습니다.</li>
          <li><strong>Ctrl+V</strong>로 클립보드의 스크린샷을 바로 붙여넣을 수 있습니다.</li>
          <li>첨부된 파일은 메모에 <strong>[file:파일명]</strong> 형태로 표시됩니다.</li>
          <li>파일명을 클릭하면 해당 파일이 기본 프로그램으로 열립니다.</li>
        </ul>
      </Section>

      <Section title="공휴일 표시">
        <ul className="list-disc ml-5 space-y-1">
          <li>대한민국 공휴일이 달력에 <strong className="text-red-500">빨간색</strong>으로 자동 표시됩니다.</li>
          <li>설날, 추석 등 <strong>음력 공휴일</strong>도 자동으로 양력 변환됩니다.</li>
          <li><strong>대체 공휴일</strong>도 반영됩니다 (2021년부터 확대 적용).</li>
          <li>날짜에 마우스를 올리면 <strong>툴팁</strong>으로 공휴일 이름을 확인할 수 있습니다.</li>
        </ul>
      </Section>

      <Section title="다크 모드">
        <ul className="list-disc ml-5 space-y-1">
          <li>달력 하단의 <strong>🌙 다크 모드 / ☀️ 라이트 모드</strong> 버튼으로 전환합니다.</li>
          <li><strong>Ctrl+D</strong> 단축키로도 전환할 수 있습니다.</li>
          <li>설정은 앱 종료 후에도 유지됩니다.</li>
        </ul>
      </Section>
    </>
  )
}
