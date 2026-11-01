// shadcn/ui (Radix, new-york), adapted for DSH's React 18 and isolated Tailwind prefix.
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './utils.js';
const buttonVariants = cva('vkp:inline-flex vkp:items-center vkp:justify-center vkp:gap-2 vkp:whitespace-nowrap vkp:rounded-md vkp:border vkp:border-transparent vkp:text-sm vkp:font-medium vkp:cursor-pointer vkp:outline-none vkp:focus-visible:ring-2 vkp:focus-visible:ring-ring vkp:disabled:pointer-events-none vkp:disabled:opacity-50', {
  variants: { variant: {
    default: 'vkp:bg-primary vkp:text-primary-foreground vkp:hover:opacity-90',
    outline: 'vkp:border-border vkp:bg-background vkp:text-foreground vkp:hover:bg-accent',
    ghost: 'vkp:bg-transparent vkp:text-foreground vkp:hover:bg-accent',
  }, size: { default: 'vkp:h-9 vkp:px-3 vkp:py-2', icon: 'vkp:size-8 vkp:p-1.5' } },
  defaultVariants: { variant: 'default', size: 'default' },
});
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> { asChild?: boolean }
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, type = 'button', ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return <Comp ref={ref} type={asChild ? undefined : type} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
});
Button.displayName = 'Button';
