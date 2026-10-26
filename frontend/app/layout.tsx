import type { Metadata } from "next";
import "./globals.css";
import "./replica.css";
import "./source-operations.css";
import "./visual-theme.css";
import "./dashboard-motion.css";
import "./collection-console.css";
import "./matrix-pulse.css";
import "./observatory.css";
import "@/components/table-scroll-frame.css";
import { DashboardMotion } from "@/components/dashboard-motion";

export const metadata: Metadata = {
  title: "MCN 矩阵数据台",
  description: "矩阵全局、主题与账号的真实已保存数据，只读分享。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased"><DashboardMotion />{children}</body>
    </html>
  );
}
