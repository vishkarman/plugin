import { createElement as h, type ButtonHTMLAttributes } from 'react';

type Icon = 'update' | 'beside' | 'close';
const paths: Record<Icon, string> = {
  update: 'M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3a7 7 0 0 0 11.6-1',
  beside: 'M3 4h18v16H3zM12 4v16M6 8h3M6 12h3M15 8h3M15 12h3',
  close: 'M6 6l12 12M18 6 6 18',
};
export function ToolbarButton({ icon, label, badge = false, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: Icon; label: string; badge?: boolean }) {
  return h('button', { ...props, type: 'button', title: label, 'aria-label': label,
    style: { position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, padding: 6, border: '1px solid #8884', borderRadius: 7, color: 'inherit', background: 'transparent', cursor: props.disabled ? 'default' : 'pointer', opacity: props.disabled ? 0.45 : 1 } },
  h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: paths[icon] })),
  badge ? h('span', { 'aria-hidden': true, 'data-update-available': true, style: { position: 'absolute', top: 1, right: 1, width: 8, height: 8, borderRadius: '50%', background: '#287cff', boxShadow: '0 0 0 2px var(--dsw-alias-bg-base, #faf9f6)' } }) : null);
}
