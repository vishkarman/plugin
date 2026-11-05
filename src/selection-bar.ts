import type { Context } from '@deepseek-ai/cordis';
import { createElement as h, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SelectionRemote } from './remote.js';
import { selectionContextText } from './selection-dock.js';
import { setPendingTransfer } from './pending-transfer.js';

const STALE_MS = 10 * 60_000;

type SurfaceStore = { subscribe: (listener: () => void) => () => void; get: () => { visible: boolean } };

/**
 * Bottom bar for the fullscreen Studio case: the composer is not on screen while Studio owns the main
 * panel, so this bar shows exactly what would be transferred and offers one explicit transfer action.
 * A click freezes the verified context, stores a pending transfer and switches the main panel to chat;
 * the composer dock inserts it once it mounts. Nothing is sent automatically.
 */
export function selectionBarView(ctx: Context, surface: SurfaceStore) {
  return function SelectionBar() {
    const bounds = useSyncExternalStore(surface.subscribe, surface.get);
    const visible = bounds.visible;
    const [snapshot, setSnapshot] = useState<SelectionRemote | null>(null);
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const showNotice = useCallback((text: string) => {
      setNotice(text);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setNotice(''), 5000);
    }, []);

    const refresh = useCallback(async () => {
      try {
        const result = await ctx.remote.vishvakarma.selection();
        setSnapshot(result.ok ? result.value : null);
      } catch {
        setSnapshot(null);
      }
    }, [ctx]);

    useEffect(() => {
      if (!visible) { setSnapshot(null); setNotice(''); return; }
      void refresh();
      // The selection is published with a ~120 ms debounce on the server; a short poll keeps this bar
      // close enough to the canvas without adding a second event channel.
      const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 250);
      const onFocus = () => void refresh();
      window.addEventListener('focus', onFocus);
      return () => {
        clearInterval(timer);
        window.removeEventListener('focus', onFocus);
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
      };
    }, [visible, refresh]);

    if (!visible || !snapshot?.supported || !snapshot.selection) return null;
    const selection = snapshot.selection;
    const object = selection.targetId !== null;
    const stale = Date.now() - Date.parse(selection.capturedAt) > STALE_MS;
    const readOnly = snapshot.access ? !snapshot.access.canUseAgent : false;
    const project = snapshot.projectName ?? selection.projectId;

    async function transfer() {
      if (!snapshot?.supported || !snapshot.selection) return;
      setBusy(true);
      try {
        const fresh = await ctx.remote.vishvakarma.selection();
        if (!fresh.ok || !fresh.value.supported || !fresh.value.selection) {
          showNotice('Контекст недоступен. Выберите элемент в Studio и попробуйте ещё раз.');
          return;
        }
        const shown = snapshot.selection;
        const next = fresh.value.selection;
        const changed = next.projectId !== shown.projectId || next.revisionId !== shown.revisionId
          || next.targetId !== shown.targetId || next.artboardId !== shown.artboardId
          || next.artboardEntrypoint !== shown.artboardEntrypoint;
        if (changed) {
          setSnapshot(fresh.value);
          showNotice('Выбор изменился — проверьте и нажмите ещё раз.');
          return;
        }
        setPendingTransfer({ id: crypto.randomUUID(), text: selectionContextText(fresh.value), createdAt: Date.now() });
        ctx.layout.selectPanel(null);
      } finally {
        setBusy(false);
      }
    }

    return h('div', {
      style: {
        height: 34, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', minWidth: 0,
        borderTop: '0.5px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-secondary)', fontSize: 12, fontFamily: 'inherit',
      },
    },
      h('span', {
        'aria-hidden': true,
        style: {
          width: 18, height: 18, flex: 'none', display: 'grid', placeItems: 'center', borderRadius: 5,
          border: '0.5px solid var(--dsw-alias-border-l2)', fontSize: 10,
        },
      }, 'V'),
      h('span', {
        style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        title: selectionContextText(snapshot),
      }, object ? `Выбрано: «${selection.targetLabel ?? selection.targetId}»` : `Выбран проект «${project}»`),
      h('span', {
        style: { flex: 'none', color: 'var(--dsw-alias-label-tertiary)' },
      }, `· ${project} · аккаунт ${snapshot.account.displayName}${stale ? ' · последний выбор' : ''}${readOnly ? ' · только чтение' : ''}`),
      notice
        ? h('span', { role: 'status', style: { minWidth: 0, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, notice)
        : null,
      h('button', {
        type: 'button', disabled: busy, onClick: () => void transfer(),
        title: 'Откроет чат и добавит контекст в черновик; сообщение отправляете вы',
        style: {
          marginLeft: 'auto', flex: 'none', border: 0, borderRadius: 999, padding: '3px 10px',
          background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-base)',
          fontFamily: 'inherit', fontSize: 12, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
        },
      }, busy ? 'Передаём…' : 'Передать в чат'));
  };
}
