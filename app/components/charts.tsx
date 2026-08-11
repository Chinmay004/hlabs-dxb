"use client";

import { useMemo, useState } from "react";

/**
 * Hand-rolled SVG charts. The dataset is small (a few hundred buckets) and the
 * interactions are simple, so a charting library would cost more in bundle size
 * than it saves here — and this way the visuals match the rest of the tool
 * exactly.
 */

export interface Series {
  key: string;
  label: string;
  color: string;
}

/** Any object with a `bucket` label; series read the rest by key. Deliberately
 *  loose so callers can pass their own row types without a cast. */
export type Row = { bucket: string } & Record<string, unknown>;

const PAD = { top: 12, right: 12, bottom: 26, left: 40 };

function niceCeil(v: number): number {
  if (v <= 5) return 5;
  const mag = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / mag) * mag;
}

export function BarChart({
  rows,
  series,
  height = 220,
  stacked = true,
}: {
  rows: Row[];
  series: Series[];
  height?: number;
  stacked?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 900;

  const { max, plotW, plotH } = useMemo(() => {
    const totals = rows.map((r) =>
      stacked
        ? series.reduce((s, k) => s + (Number(r[k.key]) || 0), 0)
        : Math.max(...series.map((k) => Number(r[k.key]) || 0)),
    );
    return {
      max: niceCeil(Math.max(1, ...totals)),
      plotW: width - PAD.left - PAD.right,
      plotH: height - PAD.top - PAD.bottom,
    };
  }, [rows, series, stacked, height]);

  if (rows.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted">
        No data in this range.
      </div>
    );
  }

  const bandW = plotW / rows.length;
  const barW = Math.max(1, Math.min(28, bandW * 0.72));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(max * t));

  // Roughly 10 labels regardless of bucket count, so the axis stays readable.
  const labelEvery = Math.max(1, Math.ceil(rows.length / 10));

  const hoverRow = hover != null ? rows[hover] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ height }}
        preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => {
          const y = PAD.top + plotH - (t / max) * plotH;
          return (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 6}
                y={y + 3}
                textAnchor="end"
                fontSize={9}
                fill="var(--muted)"
              >
                {t}
              </text>
            </g>
          );
        })}

        {rows.map((row, i) => {
          const cx = PAD.left + bandW * i + bandW / 2;
          let acc = 0;

          return (
            <g key={row.bucket}>
              <rect
                x={PAD.left + bandW * i}
                y={PAD.top}
                width={bandW}
                height={plotH}
                fill={hover === i ? "var(--hover)" : "transparent"}
                onMouseEnter={() => setHover(i)}
              />
              {series.map((s) => {
                const v = Number(row[s.key]) || 0;
                if (v <= 0) return null;
                const h = (v / max) * plotH;
                const y = stacked
                  ? PAD.top + plotH - h - acc
                  : PAD.top + plotH - h;
                if (stacked) acc += h;
                return (
                  <rect
                    key={s.key}
                    x={cx - barW / 2}
                    y={y}
                    width={barW}
                    height={Math.max(1, h)}
                    fill={s.color}
                    opacity={hover == null || hover === i ? 1 : 0.35}
                    pointerEvents="none"
                  />
                );
              })}
              {i % labelEvery === 0 ? (
                <text
                  x={cx}
                  y={height - 8}
                  textAnchor="middle"
                  fontSize={9}
                  fill="var(--muted)"
                >
                  {row.bucket.slice(2)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-[11px] text-muted">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ background: s.color }}
            />
            {s.label}
          </span>
        ))}
      </div>

      {hoverRow ? (
        <div className="pointer-events-none absolute right-2 top-2 rounded border border-[color:var(--border)] bg-[color:var(--surface-2)] px-2.5 py-2 text-[11px] shadow-lg">
          <div className="mb-1 font-semibold">{hoverRow.bucket}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-muted">
                <span
                  className="inline-block h-2 w-2 rounded-sm"
                  style={{ background: s.color }}
                />
                {s.label}
              </span>
              <span className="tabular-nums font-medium">
                {Number(hoverRow[s.key]) || 0}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

