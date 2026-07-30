"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/daily", label: "Daily" },
  { href: "/brokerages", label: "Brokerages" },
  { href: "/brokers", label: "Brokers" },
  { href: "/projects", label: "Projects" },
  { href: "/leads", label: "Leads" },
  { href: "/activity", label: "Activity" },
  { href: "/sync", label: "Sync" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-20 border-b border-[color:var(--border)] bg-[color:var(--background)]/95 backdrop-blur">
      <div className="mx-auto flex h-12 max-w-[1600px] items-center gap-1 px-4">
        <Link href="/" className="mr-4 flex items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded bg-[color:var(--accent)] text-[11px] font-bold text-white">
            H
          </span>
          <span className="text-[13px] font-semibold tracking-tight">
            DXB Registry
          </span>
        </Link>

        <nav className="flex items-center gap-0.5">
          {LINKS.map((l) => {
            const active =
              l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className="rounded px-2.5 py-1.5 text-[13px] transition-colors"
                style={{
                  background: active ? "var(--surface-2)" : "transparent",
                  color: active ? "var(--foreground)" : "var(--muted)",
                }}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
