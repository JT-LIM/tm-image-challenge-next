import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TM 이미지 모델 채점방",
  description: "학생들이 Teachable Machine 이미지 모델을 제출하고 교사가 실시간으로 채점하는 수업용 앱",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
