import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '云上旅行 · A2UI 旅行规划助手',
  description: '由 A2UI 驱动的真实数据旅行规划器',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
