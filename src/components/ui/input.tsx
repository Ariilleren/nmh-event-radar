import * as React from 'react';
import { cn } from './button';
export const fieldClass = 'w-full min-w-0 rounded-xl border border-input bg-white px-3 py-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60';
export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) { return <input className={cn(fieldClass, className)} {...props} />; }
export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea className={cn(fieldClass, 'min-h-24 resize-y', className)} {...props} />; }
export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) { return <select className={cn(fieldClass, 'cursor-pointer', className)} {...props} />; }
export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) { return <label className={cn('mb-1.5 block text-sm font-medium', className)} {...props} />; }
