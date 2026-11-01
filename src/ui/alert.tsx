import * as React from 'react';
import { cn } from './utils.js';
export function Alert({className, ...props}: React.HTMLAttributes<HTMLDivElement>) { return <div role="alert" className={cn('vkp:rounded-md vkp:border vkp:border-border vkp:bg-background vkp:p-3 vkp:text-sm vkp:text-foreground', className)} {...props} />; }
