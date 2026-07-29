/**
 * 대시보드를 일정 시간마다 자동으로 다시 불러오는 부품.
 *
 * 'use client' = 이 파일은 브라우저에서 동작합니다.
 * (타이머와 화면 갱신은 서버가 아니라 브라우저가 해야 하는 일이라서요.)
 *
 * router.refresh() 는 페이지 전체를 새로고침하는 게 아니라
 * 서버 쪽 화면만 다시 그려옵니다. 그래서 스크롤 위치가 그대로 유지됩니다.
 */

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export function AutoRefresh({ intervalMs }: { intervalMs: number }) {
  const router = useRouter();
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    const timer = setInterval(() => {
      router.refresh();
      setLastUpdated(new Date());
    }, intervalMs);

    // 화면을 벗어나면 타이머를 정리합니다. 안 하면 타이머가 계속 쌓입니다.
    return () => clearInterval(timer);
  }, [router, intervalMs]);

  const seconds = Math.round(intervalMs / 1000);

  return (
    <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-400 dark:text-slate-500">
      {/* 살아 있다는 표시로 깜빡이는 점 */}
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
      </span>
      {seconds}초마다 자동 갱신
      {/*
        시각은 브라우저에서 계산한 값이라 서버가 그린 첫 화면에는 없습니다.
        (서버와 브라우저의 시각이 달라 경고가 뜨는 걸 피하려고 이렇게 둡니다.)
      */}
      {lastUpdated && (
        <span suppressHydrationWarning>
          · 마지막 {lastUpdated.toLocaleTimeString('ko-KR')}
        </span>
      )}
    </p>
  );
}
