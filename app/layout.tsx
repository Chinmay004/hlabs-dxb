import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Nav } from "./components/nav";
import { THEME_KEY } from "./components/theme";

/**
 * Replays the stored theme onto <html> before the first paint. Without it the
 * page renders in the system theme and then snaps to the chosen one once React
 * hydrates — a full-page flash on every navigation-free load. Deliberately
 * synchronous and inline in <head>; a deferred module would be too late.
 */
const THEME_BOOTSTRAP = `try{var t=localStorage.getItem(${JSON.stringify(
  THEME_KEY,
)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "DXB Registry — Dubai brokerage & broker intelligence",
  description:
    "Daily mirror of the DLD/RERA registry: newly licensed brokerages, newly licensed brokers, and the leads that fall out of them.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      // The bootstrap script mutates `data-theme` before React hydrates, so the
      // client <html> attributes legitimately differ from the server's.
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-full">
        <Nav />
        <main className="mx-auto max-w-[1600px] px-4 py-5">{children}</main>
      </body>
    </html>
  );
}
