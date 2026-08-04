import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "밥머거 대시보드",
  description: "밥머거로 만든 점심팟 모집 · 정산 현황을 한눈에",
};

/**
 * 화면이 그려지기 전에 먼저 실행돼서 <html data-theme="...">를 심어둡니다.
 *
 * 이걸 React가 그리고 난 뒤에 하면(useEffect 등) 처음엔 OS 설정대로 잠깐
 * 보였다가 저장해둔 값으로 바뀌는 깜빡임(FOUC)이 생깁니다. 그래서 React보다
 * 먼저 실행되는 일반 <script>로 처리합니다.
 */
const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('theme');
    var theme = stored || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // data-theme="light"는 서버가 그리는 기본값이고, 실제 값은 아래 스크립트가
    // 그리기 전에 덮어씁니다. 그래서 둘이 다를 수 있는데, suppressHydrationWarning이
    // 없으면 React가 이걸 오류로 보고 트리 전체를 다시 그리면서 이 스크립트가 만든
    // 수정 결과를 잃어버립니다. (Next.js 공식 가이드: preventing-flash-before-hydration)
    <html lang="ko" className="h-full antialiased" data-theme="light" suppressHydrationWarning>
      <head>
        <script
          type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
      </head>
      <body className="min-h-full flex flex-col bg-app text-primary">
        {children}
      </body>
    </html>
  );
}
