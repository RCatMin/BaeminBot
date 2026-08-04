import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "점심팟 대시보드",
  description: "점심팟 모집 · 정산 현황을 한눈에",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-app text-primary">
        {children}
      </body>
    </html>
  );
}
