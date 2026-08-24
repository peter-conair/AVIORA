import type { ReactNode } from 'react';

type BadgeTone = 'teal' | 'green' | 'amber' | 'red' | 'gray';

interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
}

const toneClasses: Record<BadgeTone, string> = {
  teal: 'bg-brand-50 text-brand-800 ring-brand-600/20',
  green: 'bg-green-50 text-green-800 ring-green-600/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  red: 'bg-red-50 text-red-800 ring-red-600/20',
  gray: 'bg-slate-100 text-slate-700 ring-slate-500/20',
};

/** Map a raw status string to a badge tone. */
export function statusTone(status: string): BadgeTone {
  const s = status.toLowerCase();
  if (['completed', 'accepted', 'active', 'done'].includes(s)) {
    return s === 'active' ? 'teal' : 'green';
  }
  if (['pending', 'trial', 'trialing', 'in_progress', 'started'].includes(s)) return 'amber';
  if (['expired', 'cancelled', 'canceled', 'revoked', 'suspended', 'failed'].includes(s))
    return 'red';
  return 'gray';
}

export function Badge({ tone = 'gray', children }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${toneClasses[tone]}`}
    >
      {children}
    </span>
  );
}
