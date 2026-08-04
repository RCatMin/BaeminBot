/**
 * 라이트/다크 모드를 직접 고르는 버튼.
 *
 * 예전에는 OS 설정(prefers-color-scheme)만 따라갔는데, 그러면 사용자가
 * OS와 다르게 보고 싶어도 방법이 없었습니다. 여기서 고른 값은 localStorage에
 * 저장해두고 <html data-theme="..."> 로 실어서, globals.css의
 * :root[data-theme] 규칙이 OS 설정보다 우선하도록 만듭니다.
 */

'use client';

import { useState } from 'react';

type Theme = 'light' | 'dark';

/** layout.tsx의 인라인 스크립트가 <html>에 이미 심어둔 값을 읽습니다. 서버에는 document가 없습니다. */
function readTheme(): Theme | null {
  if (typeof document === 'undefined') return null;
  return (document.documentElement.dataset.theme as Theme | undefined) ?? 'light';
}

export function ThemeToggle() {
  // 지연 초기화 함수라 서버에서는 null, 클라이언트에서 마운트될 때 한 번 더 불려
  // 실제 값을 읽습니다. 두 값이 달라 하이드레이션 경고가 나므로 아래
  // suppressHydrationWarning으로 눈감아 줍니다(auto-refresh.tsx와 같은 패턴).
  const [theme, setTheme] = useState<Theme | null>(readTheme);

  function toggle(): void {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    setTheme(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="화면 모드 전환"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-card text-[14px]"
    >
      <span suppressHydrationWarning>
        {theme === 'dark' ? '☀️' : theme === 'light' ? '🌙' : null}
      </span>
    </button>
  );
}
