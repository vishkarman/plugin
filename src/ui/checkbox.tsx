import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';
import { cn } from './utils.js';
export const Checkbox = React.forwardRef<React.ElementRef<typeof CheckboxPrimitive.Root>, React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>>(({className, ...props}, ref) => <CheckboxPrimitive.Root ref={ref} className={cn('vkp:inline-flex vkp:size-4 vkp:shrink-0 vkp:items-center vkp:justify-center vkp:rounded-sm vkp:border vkp:border-border vkp:bg-background vkp:text-foreground vkp:outline-none vkp:focus-visible:ring-2 vkp:focus-visible:ring-ring vkp:data-[state=checked]:bg-primary vkp:data-[state=checked]:text-primary-foreground vkp:disabled:opacity-50', className)} {...props}><CheckboxPrimitive.Indicator className="vkp:flex vkp:items-center vkp:justify-center"><Check size={12} aria-hidden="true" /></CheckboxPrimitive.Indicator></CheckboxPrimitive.Root>);
Checkbox.displayName = 'Checkbox';
