import * as React from 'react';
import { cn } from './utils.js';
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, type, ...props }, ref) => <input ref={ref} type={type} className={cn('vkp:flex vkp:h-9 vkp:w-full vkp:rounded-md vkp:border vkp:border-border vkp:bg-background vkp:px-3 vkp:py-1 vkp:text-sm vkp:text-foreground vkp:outline-none vkp:focus-visible:ring-2 vkp:focus-visible:ring-ring vkp:disabled:opacity-50', className)} {...props} />);
Input.displayName = 'Input';
