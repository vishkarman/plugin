import type { Context } from '@deepseek-ai/cordis';
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react';
import type { SelectionSnapshot } from '../contracts/selection.js';
import type { SelectionRemote } from './remote.js';

/** Public `InputActions` subset from DSH's composer shell; absent outside a session-scoped dock. */
interface InsertActions {
  captureInsertion(): { start: number; end: number; draftRev: number };
  insertText(text: string, span: { start: number; end: number; draftRev: number }): boolean;
}

const STALE_MS = 10 * 60_000;

/** Frozen compact text inserted into the draft; shared by the dock and the Studio context bar. */
export function selectionContextText(snapshot: SelectionSnapshot): string {
  const selection = snapshot.selection!;
  const name = snapshot.projectName ?? selection.projectId;
  const target = selection.targetId
    ? `, выделен «${selection.targetLabel ?? selection.targetId}» (targetId ${selection.targetId})`
    : ', без выбранного элемента';
  const page = selection.artboardEntrypoint ? `, страница ${selection.artboardEntrypoint}` : '';
  const readOnly = snapshot.access && !snapshot.access.canUseAgent
    ? '\nМожно обсуждать; изменения через агента недоступны.'
    : '';
  return `Контекст Vishvakarma: проект «${name}» (projectId ${selection.projectId}), ревизия ${selection.revisionId}${page}${target}.${readOnly}`;
}

const labelStyle = {
  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
} as const;

/**
 * Composer dock entry: the only cross-surface UI for stage A. Shows the published selection while it exists,
 * offers one insertion into the chat draft and disappears without a selection. It never sends the message.
 */
export function selectionDockView(ctx: Context) {
  return function SelectionDock({ inputActions }: { inputActions?: InsertActions }) {
    const [snapshot, setSnapshot] = useState<SelectionRemote | null>(null);
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const showNotice = useCallback((text: string) => {
      setNotice(text);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setNotice(''), 6000);
    }, []);

    const copyText = useCallback(async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        showNotice('Контекст скопирован для DSH.');
      } catch {
        showNotice('Не удалось вставить или скопировать. Скопируйте вручную: ' + text);
      }
    }, [showNotice]);

    const fetchSelection = useCallback(async (): Promise<SelectionRemote | null> => {
      try {
        const result = await ctx.remote.vishvakarma.selection();
        return result.ok ? result.value : null;
      } catch {
        return null;
      }
    }, [ctx]);

    const refresh = useCallback(async () => {
      const next = await fetchSelection();
      setSnapshot(next);
    }, [fetchSelection]);

    useEffect(() => { void refresh(); }, [refresh]);
    useEffect(() => {
      const onFocus = () => void refresh();
      const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
      const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 2000);
      window.addEventListener('focus', onFocus);
      document.addEventListener('visibilitychange', onVisibility);
      return () => {
        clearInterval(timer);
        window.removeEventListener('focus', onFocus);
        document.removeEventListener('visibilitychange', onVisibility);
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
      };
    }, [refresh]);

    if (!snapshot?.supported || !snapshot.selection) return null;
    const selection = snapshot.selection;
    const account = snapshot.account;
    const object = selection.targetId !== null;
    const stale = Date.now() - Date.parse(selection.capturedAt) > STALE_MS;
    const readOnly = snapshot.access ? !snapshot.access.canUseAgent : false;

    async function insert() {
      if (!snapshot?.supported || !snapshot.selection) return;
      setBusy(true);
      try {
        if (!inputActions) {
          await copyText(selectionContextText(snapshot));
          return;
        }
        // Capture the draft span first: insertText rejects a span whose draft revision changed while we read.
        const span = inputActions.captureInsertion();
        const fresh = await fetchSelection();
        if (!fresh?.supported || !fresh.selection) {
          setSnapshot(fresh);
          showNotice('Выделение пропало. Выберите объект в Studio и повторите.');
          return;
        }
        const shown = snapshot.selection;
        const changed = fresh.selection.projectId !== shown.projectId
          || fresh.selection.revisionId !== shown.revisionId
          || fresh.selection.targetId !== shown.targetId
          || fresh.selection.artboardId !== shown.artboardId
          || fresh.selection.artboardEntrypoint !== shown.artboardEntrypoint;
        if (changed) {
          setSnapshot(fresh);
          showNotice('Выбор изменился — нажмите «Вставить в задачу» ещё раз.');
          return;
        }
        if (!inputActions.insertText(selectionContextText(fresh), span)) await copyText(selectionContextText(fresh));
        else showNotice('Контекст добавлен в задачу.');
      } finally {
        setBusy(false);
      }
    }

    return h('div', {
      style: {
        display: 'flex', flexDirection: 'column', gap: 2, padding: '2px 4px', minWidth: 0,
        fontSize: 12, color: 'var(--dsw-alias-label-secondary)', fontFamily: 'inherit',
      },
    },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
        h('span', {
          'aria-hidden': true,
          style: {
            width: 18, height: 18, flex: 'none', display: 'grid', placeItems: 'center', borderRadius: 5,
            border: '0.5px solid var(--dsw-alias-border-l2)', fontSize: 10, color: 'var(--dsw-alias-label-secondary)',
          },
        }, 'V'),
        h('span', { style: labelStyle },
          object ? `Выделен «${selection.targetLabel ?? selection.targetId}»` : `Проект «${snapshot.projectName ?? selection.projectId}»`,
          h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } },
            ` · ${snapshot.projectName ?? selection.projectId} · аккаунт ${account.displayName}`,
            stale ? ' · последний выбор' : '',
            readOnly ? ' · только чтение' : '')),
        h('button', {
          type: 'button', disabled: busy, onClick: () => void insert(),
          title: 'Вставит подготовленный контекст в черновик; сообщение отправляете вы',
          style: {
            marginLeft: 'auto', flex: 'none', border: 'none', borderRadius: 999, padding: '3px 10px',
            background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-base)',
            fontFamily: 'inherit', fontSize: 12, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
          },
        }, busy ? 'Вставляем…' : 'Вставить в задачу')),
      notice ? h('div', { role: 'status', style: { padding: '0 2px', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', ...labelStyle } }, notice) : null);
  };
}
