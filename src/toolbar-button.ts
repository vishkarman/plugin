import { createElement as h, type ButtonHTMLAttributes } from 'react';
import { RefreshCw, RotateCw, PanelRight, X } from 'lucide-react';
import { Button } from './ui/button.js';
import { cn } from './ui/utils.js';
const icons = { update: RefreshCw, reload: RotateCw, beside: PanelRight, close: X };
export function ToolbarButton({ icon, label, badge = false, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: keyof typeof icons; label: string; badge?: boolean }) {
  return h(Button, { ...props, type: 'button', variant: 'outline', size: 'icon', title: label, 'aria-label': label, className: cn('vkp:relative', className) },
    h(icons[icon], { size: 18, strokeWidth: 1.7, 'aria-hidden': true }),
    badge ? h('span', { 'aria-hidden': true, 'data-update-available': true, className: 'vkp-update-badge' }) : null);
}
