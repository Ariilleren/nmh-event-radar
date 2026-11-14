import * as React from 'react';
import { cn } from './button';
export function Badge({ className, tone = 'neutral', ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: 'neutral' | 'success' | 'warning' | 'danger' }) {
  const tones = { neutral: 'bg-[#eff2f1] text-[#526564]', success: 'bg-[#e6f3ee] text-[#176759]', warning: 'bg-[#fff0d8] text-[#835010]', danger: 'bg-[#fbe9e7] text-[#983e38]' };
  return <span className={cn('inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px] leading-4 font-semibold', tones[tone], className)} {...props} />;
}
