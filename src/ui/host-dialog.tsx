import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { cn } from './utils.js';
// A native top-layer dialog must cover Electron webviews. Do not add a second
// Radix modal/focus trap inside it or portal its content outside this element.
export function HostDialog({ title, children, close, actions, headerAction, description, initialFocus, compact = false }: { title: string; children?: ReactNode; close: () => void; actions?: ReactNode; headerAction?: ReactNode; description?: string; initialFocus?: RefObject<HTMLElement>; compact?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null), titleId = useId(), descriptionId = useId();
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.showModal(); initialFocus?.current?.focus();
    return () => { ref.current?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} className={cn('vishvakarma-plugin-ui vkp-host-dialog', compact && 'vkp-host-dialog-compact')} aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} onCancel={event => { event.preventDefault(); close(); }}>
    <header className="vkp:flex vkp:items-center vkp:gap-4 vkp:mb-4"><h2 id={titleId} className="vkp:flex-1 vkp:text-xl vkp:font-semibold">{title}</h2>{headerAction}</header>
    {description && <p id={descriptionId}>{description}</p>}{children}
    {actions && <footer className="vkp:flex vkp:justify-end vkp:gap-3 vkp:mt-5">{actions}</footer>}
  </dialog>;
}
