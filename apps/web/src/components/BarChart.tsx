import { useState } from "react";

export interface BarDatum {
  label: string;
  value: number;
  detail?: string;
}

const SERIES = "#2a78d6";
const H = 180;
const PAD_LEFT = 32;
const PAD_BOTTOM = 22;
const PAD_TOP = 10;

function niceMax(v: number): number {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => v / s <= 4) ?? pow * 10;
  return Math.ceil(v / step) * step;
}

// Single-series vertical bars: one hue, rounded data-end, recessive grid,
// per-bar hover readout, and a table view so no value hides behind hover.
export default function BarChart({ data, unit, title }: { data: BarDatum[]; unit: string; title: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const width = Math.max(320, data.length * 28 + PAD_LEFT);
  const slot = (width - PAD_LEFT) / Math.max(1, data.length);
  const barW = Math.max(4, Math.min(22, slot - 6));
  const y = (v: number) => PAD_TOP + (H - PAD_BOTTOM - PAD_TOP) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(data.length / 12);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold text-slate-900">{title}</div>
        <button onClick={() => setTable((t) => !t)} className="text-xs text-slate-500 hover:text-slate-900">
          {table ? "Chart" : "Table"}
        </button>
      </div>
      {data.length === 0 ? (
        <div className="h-[180px] flex items-center justify-center text-sm text-slate-400">No calls in this period.</div>
      ) : table ? (
        <div className="max-h-[180px] overflow-auto">
          <table className="w-full text-sm">
            <tbody>
              {data.map((d) => (
                <tr key={d.label} className="border-b border-slate-100">
                  <td className="py-1 text-slate-600">{d.label}</td>
                  <td className="py-1 text-right font-medium text-slate-900">{d.value.toLocaleString()} {unit}</td>
                  <td className="py-1 pl-3 text-xs text-slate-500">{d.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative overflow-x-auto">
          <svg width="100%" viewBox={`0 0 ${width} ${H}`} style={{ minWidth: 320, maxHeight: 240 }} role="img" aria-label={title}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD_LEFT} x2={width} y1={y(t)} y2={y(t)} stroke="#e2e8f0" strokeWidth={1} />
                <text x={PAD_LEFT - 6} y={y(t) + 4} textAnchor="end" fontSize={10} fill="#64748b">
                  {Math.round(t).toLocaleString()}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const cx = PAD_LEFT + slot * i + slot / 2;
              const top = y(d.value);
              const h = H - PAD_BOTTOM - top;
              const r = Math.min(4, barW / 2, h);
              return (
                <g key={d.label} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
                  <rect x={cx - slot / 2} y={0} width={slot} height={H - PAD_BOTTOM} fill="transparent" />
                  {d.value > 0 && (
                    <path
                      d={`M${cx - barW / 2},${H - PAD_BOTTOM} V${top + r} Q${cx - barW / 2},${top} ${cx - barW / 2 + r},${top} H${cx + barW / 2 - r} Q${cx + barW / 2},${top} ${cx + barW / 2},${top + r} V${H - PAD_BOTTOM} Z`}
                      fill={SERIES}
                      opacity={hover === null || hover === i ? 1 : 0.45}
                    />
                  )}
                  {i % labelEvery === 0 && (
                    <text x={cx} y={H - 6} textAnchor="middle" fontSize={10} fill="#64748b">
                      {d.label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {hover !== null && (
            <div
              className="pointer-events-none absolute top-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-sm"
              style={{ left: `min(calc(${((PAD_LEFT + slot * hover + slot / 2) / width) * 100}% + 8px), calc(100% - 160px))` }}
            >
              <div className="font-semibold text-slate-900">
                {data[hover].value.toLocaleString()} {unit}
              </div>
              <div className="text-slate-500">{data[hover].label}</div>
              {data[hover].detail && <div className="text-slate-500">{data[hover].detail}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
