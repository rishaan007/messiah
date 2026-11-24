import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MESSIAH — The Universal AI Agent Workspace",
  description: "One intelligence layer. Every agent. Every device.",
  applicationName: "MESSIAH",
  authors: [{ name: "Messiah Core Team" }],
  keywords: [
    "AI Workspace",
    "Autonomous Agents",
    "Model Context Protocol",
    "Local Agent Bridge",
  ],
};

export const viewport: Viewport = {
  themeColor: "#090A0F",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark h-full">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@300;400;500;600&family=Geist:wght@300;400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="h-full bg-[#090A0F] text-[#F0F4FC] font-sans antialiased selection:bg-[#00F0FF]/20 selection:text-[#00F0FF]">
        {children}
      </body>
    </html>
  );
}
