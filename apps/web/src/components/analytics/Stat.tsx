import type { ReactNode } from 'react';

interface StatProps {
  label: string;
  value: string;
  hint?: ReactNode;
}

/**
 * One measure. `value` is already formatted by the caller — counts through the
 * count formatter, money through the money formatter, and nothing here divides
 * anything.
 */
export function Stat({ label, value, hint }: StatProps) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <span className="break-words text-xs text-slate-500">{label}</span>
      <span className="break-words text-lg font-bold text-slate-900">{value}</span>
      {hint ? <span className="break-words text-xs text-slate-500">{hint}</span> : null}
    </div>
  );
}
