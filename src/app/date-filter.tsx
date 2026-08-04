/**
 * 날짜별로 팟을 골라 보는 달력 팝업.
 *
 * 8월부터 11월까지, 그 이후로도 계속 쓸 걸 감안해 만들었습니다.
 * 드롭다운에 날짜를 전부 나열하면 몇 달만 지나도 목록이 끝없이 길어지는데,
 * 달력은 한 달 단위로만 보여주고 월 이동 버튼으로 넘기니 개수가 늘어도 그대로입니다.
 *
 * 'use client' 인 이유: 버튼 클릭으로 팝업을 열고 닫는 것, 달을 넘기는 것 모두
 * 브라우저에서 일어나는 상호작용이라 서버 컴포넌트로는 못 합니다.
 *
 * 서버가 "팟이 있었던 날짜와 그날 개수" 전체 목록을 한 번에 내려주면,
 * 이 컴포넌트는 그 안에서 원하는 달만 골라 격자로 그립니다. 달을 넘길 때마다
 * 서버에 다시 물어보지 않아도 되니 화면 전환이 즉각적입니다.
 */

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export type DateOption = { date: string; count: number };

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** '2026-08-04' → 한국 시간 기준 Date 객체. */
function parseIsoDate(iso: string): Date {
  return new Date(`${iso}T00:00:00+09:00`);
}

/** (연, 0-11월, 일) → '2026-08-04' */
function toIso(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function formatMonthLabel(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long' });
}

function formatSelectedLabel(iso: string): string {
  return parseIsoDate(iso).toLocaleDateString('ko-KR', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });
}

export function DateFilter({
  dates,
  selected,
}: {
  dates: DateOption[];
  selected: string | null;
}) {
  const router = useRouter();
  const countByDate = new Map(dates.map((d) => [d.date, d.count]));

  // 처음 열 때 보여줄 달: 고른 날짜가 있으면 그 달, 없으면 가장 최근에 팟이 있었던 달.
  // (이 컴포넌트는 dates가 비어 있으면 아예 렌더링되지 않으므로 — page.tsx의
  //  DateFilterBar 참고 — dates[0]이 항상 있다고 가정해도 안전합니다.)
  const anchor = parseIsoDate(selected ?? dates[0].date);

  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(anchor.getFullYear());
  const [viewMonth, setViewMonth] = useState(anchor.getMonth()); // 0~11

  // 팝업이 닫혀 있을 때 Esc를 누를 일이 없으니, 열려 있을 때만 감시합니다.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  function changeMonth(delta: number): void {
    let month = viewMonth + delta;
    let year = viewYear;
    if (month < 0) {
      month = 11;
      year -= 1;
    } else if (month > 11) {
      month = 0;
      year += 1;
    }
    setViewMonth(month);
    setViewYear(year);
  }

  function pickDay(day: number): void {
    setOpen(false);
    router.push(`/?date=${toIso(viewYear, viewMonth, day)}`);
  }

  function clearFilter(): void {
    setOpen(false);
    router.push('/');
  }

  const firstWeekday = new Date(viewYear, viewMonth, 1).getDay(); // 0=일요일
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  // 달력 격자를 채우기 위해, 1일 앞을 빈 칸으로 밀어둡니다.
  const cells: (number | null)[] = [
    ...Array<null>(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  return (
    <div className="relative text-[13px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-xl border border-line bg-card px-3 py-1.5 text-primary"
      >
        <span className="text-secondary">날짜별 보기</span>
        <span className="font-medium">
          {selected ? formatSelectedLabel(selected) : '전체 보기'}
        </span>
        <ChevronDown open={open} />
      </button>

      {open && (
        <>
          {/*
            화면 전체를 덮는 투명한 배경. 여기를 누르면 팝업이 닫힙니다.
            팝업(z-20)이 이 배경(z-10) 위에 그려지므로, 팝업 안을 눌렀을 때는
            클릭이 팝업에서 먼저 잡히고 이 배경까지 내려오지 않습니다.
          */}
          <div
            role="presentation"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10"
          />

          {/*
            버튼이 화면 오른쪽에 있을 땐(넓은 화면) 패널도 오른쪽 기준으로 붙여야
            왼쪽으로 안 넘칩니다. 좁은 화면에서는 이 버튼이 도구줄 맨 왼쪽으로
            줄바꿈되므로, 그때는 반대로 왼쪽 기준이어야 오른쪽으로 자연스럽게 펼쳐집니다.
          */}
          <div className="absolute left-0 top-full z-20 mt-2 w-72 max-w-[calc(100vw-2.5rem)] rounded-2xl border border-line bg-card p-4 shadow-[var(--shadow-card)] sm:left-auto sm:right-0">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => changeMonth(-1)}
                aria-label="이전 달"
                className="rounded-full p-1.5 text-secondary hover:bg-line/60"
              >
                ‹
              </button>
              <p className="font-semibold">{formatMonthLabel(viewYear, viewMonth)}</p>
              <button
                type="button"
                onClick={() => changeMonth(1)}
                aria-label="다음 달"
                className="rounded-full p-1.5 text-secondary hover:bg-line/60"
              >
                ›
              </button>
            </div>

            <div className="mt-3 grid grid-cols-7 text-center text-[11px] text-tertiary">
              {WEEKDAYS.map((w) => (
                <span key={w}>{w}</span>
              ))}
            </div>

            <div className="mt-1 grid grid-cols-7 gap-y-1">
              {cells.map((day, i) => {
                if (day === null) return <span key={`blank-${i}`} />;

                const iso = toIso(viewYear, viewMonth, day);
                const count = countByDate.get(iso);
                const isSelected = selected === iso;

                // 그날 팟이 없으면 숫자만 흐리게 보여주고, 누를 수는 없게 합니다.
                if (!count) {
                  return (
                    <span
                      key={iso}
                      className="flex h-9 items-center justify-center text-tertiary/50"
                    >
                      {day}
                    </span>
                  );
                }

                return (
                  <button
                    key={iso}
                    type="button"
                    onClick={() => pickDay(day)}
                    title={`${count}건`}
                    className={`mx-auto flex h-9 w-9 items-center justify-center rounded-full font-medium ${
                      isSelected ? 'bg-accent text-white' : 'bg-accent-soft text-accent'
                    }`}
                  >
                    {day}
                  </button>
                );
              })}
            </div>

            {selected && (
              <button
                type="button"
                onClick={clearFilter}
                className="mt-3 w-full rounded-xl border border-line py-1.5 text-center text-secondary"
              >
                전체 보기로 돌아가기
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ChevronDown({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      className={`h-3 w-3 text-tertiary transition-transform ${open ? 'rotate-180' : ''}`}
      fill="none"
    >
      <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
