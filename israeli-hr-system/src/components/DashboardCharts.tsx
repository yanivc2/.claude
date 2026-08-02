"use client";

import { useMemo, useRef, useState } from "react";

// ─────────────────────────────────────────────────────────────────────────
// גרפי לוח הבקרה — SVG/HTML טהור (בלי ספריית גרפים), מותאמים למצב כהה ו-RTL.
// עוקב אחר עקרונות dataviz: סדרה יחידה בגוון מותג, זיהוי דרך תווית ולא צבע בלבד,
// ציר זמן LTR, שכבת hover, וצירים/רשת רסנניים.
// ─────────────────────────────────────────────────────────────────────────

export interface TrendPoint {
  label: string; // שם חודש בעברית
  count: number;
}

export interface StatusDatum {
  label: string;
  count: number;
  // גוון נקודת הסטטוס (Tailwind bg classes, כולל dark:) — זיהוי מלווה תווית.
  dot: string;
}

// ── גרף מגמת קליטה (סדרת מותג יחידה, ציר זמן, hover) ────────────────────────
export function HiringTrendChart({ data }: { data: TrendPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const W = 320;
  const H = 120;
  const padX = 10;
  const padY = 14;
  const max = Math.max(1, ...data.map((d) => d.count));

  const pts = useMemo(() => {
    const n = data.length;
    return data.map((d, i) => {
      const x = n <= 1 ? W / 2 : padX + (i * (W - padX * 2)) / (n - 1);
      const y = padY + (1 - d.count / max) * (H - padY * 2);
      return { x, y, ...d };
    });
  }, [data, max]);

  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const areaPath =
    pts.length > 0
      ? `M${pts[0].x},${H - padY} ` +
        pts.map((p) => `L${p.x},${p.y}`).join(" ") +
        ` L${pts[pts.length - 1].x},${H - padY} Z`
      : "";

  function onMove(e: React.MouseEvent) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || pts.length === 0) return;
    const rel = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestD = Infinity;
    pts.forEach((p, i) => {
      const d = Math.abs(p.x - rel);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHover(best);
  }

  if (data.every((d) => d.count === 0)) {
    return <p className="py-10 text-center text-sm text-slate-400 dark:text-slate-500">אין נתוני קליטה עדיין.</p>;
  }

  const active = hover !== null ? pts[hover] : null;

  return (
    <div className="relative" dir="ltr" ref={wrapRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full overflow-visible" role="img" aria-label="מגמת קליטת עובדים">
        {/* קווי רשת רסנניים */}
        {[0.5, 1].map((f) => (
          <line
            key={f}
            x1={padX}
            x2={W - padX}
            y1={padY + f * (H - padY * 2)}
            y2={padY + f * (H - padY * 2)}
            className="stroke-slate-100 dark:stroke-slate-800"
            strokeWidth={1}
          />
        ))}
        <path d={areaPath} className="fill-brand-500/10 dark:fill-brand-400/10" />
        <path d={linePath} fill="none" className="stroke-brand-600 dark:stroke-brand-400" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {active && (
          <line x1={active.x} x2={active.x} y1={padY - 4} y2={H - padY} className="stroke-slate-300 dark:stroke-slate-600" strokeWidth={1} strokeDasharray="3 3" />
        )}
        {pts.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={hover === i ? 4 : 2.5}
            className="fill-brand-600 dark:fill-brand-400 transition-all"
          />
        ))}
      </svg>
      {/* תוויות ציר החודשים */}
      <div className="mt-1 flex justify-between px-1 text-[10px] text-slate-400 dark:text-slate-500">
        {data.map((d) => (
          <span key={d.label}>{d.label}</span>
        ))}
      </div>
      {/* טולטיפ */}
      {active && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-lg bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white shadow-lg dark:bg-slate-700"
          style={{ left: `${(active.x / W) * 100}%`, top: `${(active.y / H) * 100}%` }}
        >
          {active.count} · {active.label}
        </div>
      )}
    </div>
  );
}

// ── פילוח לפי סטטוס (עמודות בגוון מותג + נקודת סטטוס ותווית) ────────────────
export function StatusBreakdownChart({ data }: { data: StatusDatum[] }) {
  const total = data.reduce((s, d) => s + d.count, 0);
  const max = Math.max(1, ...data.map((d) => d.count));

  if (total === 0) {
    return <p className="py-10 text-center text-sm text-slate-400 dark:text-slate-500">אין עדיין עובדים.</p>;
  }

  return (
    <div className="space-y-3.5">
      {data.map((d) => (
        <div key={d.label} title={`${d.label}: ${d.count}`}>
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 font-medium text-slate-700 dark:text-slate-200">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${d.dot}`} />
              {d.label}
            </span>
            <span className="tabular-nums font-bold text-slate-800 dark:text-slate-100">{d.count}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div
              className="h-2 rounded-full bg-gradient-to-l from-brand-500 to-brand-600 transition-[width] duration-500 dark:from-brand-400 dark:to-brand-500"
              style={{ width: `${(d.count / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
