import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "덕소중학교 AI 이미지 분류",
  description: "덕소중학교 학생들이 Teachable Machine 이미지 분류 모델을 제출하고 비교하는 수업용 앱",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
