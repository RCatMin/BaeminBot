/**
 * 날짜별로 팟을 골라 보는 드롭다운.
 *
 * 'use client' 인 이유: 선택하는 순간 바로 그 날짜의 화면으로 이동해야 하는데,
 * 그건 브라우저에서 일어나는 일(주소창 이동)이라 서버 컴포넌트로는 못 합니다.
 *
 * 서버가 이미 "팟이 있었던 날짜 목록"을 만들어서 내려주고, 여기서는
 * 그걸 드롭다운으로 보여주기만 합니다. (없는 날짜를 골라서 빈 화면 보는 일이 없도록)
 */

'use client';

import { useRouter } from 'next/navigation';

export type DateOption = { date: string; count: number };

/** 2026-08-04 → "8월 4일 (수)" */
function formatDateLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00+09:00`);
  return d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
}

export function DateFilter({
  dates,
  selected,
}: {
  dates: DateOption[];
  selected: string | null;
}) {
  const router = useRouter();

  return (
    <label className="mt-3 flex items-center gap-2 text-sm">
      <span className="text-slate-500 dark:text-slate-400">날짜별 보기</span>
      <select
        value={selected ?? 'all'}
        onChange={(e) => {
          const value = e.target.value;
          router.push(value === 'all' ? '/' : `/?date=${value}`);
        }}
        className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
      >
        <option value="all">전체 보기</option>
        {dates.map((d) => (
          <option key={d.date} value={d.date}>
            {formatDateLabel(d.date)} · {d.count}건
          </option>
        ))}
      </select>
    </label>
  );
}
