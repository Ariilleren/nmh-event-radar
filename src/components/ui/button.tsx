import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export const buttonVariants = cva('inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-teal-600', {
  variants: { variant: { default: 'bg-primary text-white hover:bg-[#10665e]', outline: 'border border-border bg-white text-foreground hover:bg-muted', ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground', destructive: 'bg-red-50 text-red-800 border border-red-200 hover:bg-red-100' }, size: { default: 'min-h-10 px-4 py-2.5', sm: 'min-h-9 px-3 py-2 text-xs', icon: 'size-10 shrink-0' } },
  defaultVariants: { variant: 'default', size: 'default' },
});
export function Button({ className, variant, size, type = 'button', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button type={type} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
