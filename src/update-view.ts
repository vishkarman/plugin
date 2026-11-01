import type { Context } from '@deepseek-ai/cordis';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { UpdateSettings, UpdateStatus } from './update-contract.js';
import { ToolbarButton } from './toolbar-button.js';

export function updateView(ctx: Context) {
  const storageKey = 'vishvakarma.update-dialog';
  let opened = false;
  try { opened = sessionStorage.getItem(storageKey) === 'open'; } catch {}
  const listeners = new Set<() => void>();
  let updateAvailable = false;
  let noticeRequest: Promise<void> | undefined;
  const refreshNotice = () => noticeRequest ??= (async () => {
    try {
      const reply = await ctx.remote.vishvakarma.updateNotice();
      updateAvailable = reply.ok && reply.value === 'changed';
    } catch { updateAvailable = false; }
    for (const listener of listeners) listener();
  })().finally(() => { noticeRequest = undefined; });
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const show = (next: boolean) => {
    opened = next;
    try { next ? sessionStorage.setItem(storageKey, 'open') : sessionStorage.removeItem(storageKey); } catch {}
    for (const listener of listeners) listener();
  };
  async function value(result: Promise<RemoteResult<UpdateStatus>>) {
    const reply = await result;
    if (!reply.ok) throw new Error(reply.error.message || 'Не удалось получить ответ DSH.');
    return reply.value;
  }
  function UpdateDialog({ close }: { close: () => void }) {
    const dialog = useRef<HTMLDialogElement>(null);
    const [status, setStatus] = useState<UpdateStatus | null>(null);
    const [draft, setDraft] = useState<UpdateSettings | null>(null);
    const [error, setError] = useState(''), [connectionError, setConnectionError] = useState(''), [pending, setPending] = useState(false);
    useEffect(() => { dialog.current?.showModal(); }, []);
    useEffect(() => {
      let active = true, timer: ReturnType<typeof setTimeout>;
      const poll = async () => {
        try {
          const next = await value(ctx.remote.vishvakarma.updateStatus());
          if (active) { setStatus(next); setDraft(old => old ?? next.settings); setConnectionError(''); }
        } catch { if (active) setConnectionError('DSH временно не отвечает. После перезагрузки плагина откройте это окно снова.'); }
        if (active) timer = setTimeout(poll, 1500);
      };
      void poll();
      return () => { active = false; clearTimeout(timer); };
    }, []);
    async function action(run: () => Promise<RemoteResult<UpdateStatus>>) {
      setPending(true); setError('');
      try { const next = await value(run()); setStatus(next); setDraft(next.settings); }
      catch (e) { setError(e instanceof Error ? e.message : 'Действие не выполнено.'); }
      finally { setPending(false); }
    }
    const busy = pending || Boolean(status && ['checking', 'building', 'installing'].includes(status.phase));
    useEffect(() => { if (status && !busy) void refreshNotice(); }, [status?.phase, status?.settings.development, status?.settings.directory, busy]);
    const dirty = draft && status && (draft.development !== status.settings.development || draft.directory !== status.settings.directory);
    return h('dialog', { ref: dialog, onCancel: close, 'aria-label': 'Обновление Vishvakarma', style: { width: 'min(600px, 90vw)', maxHeight: '85vh', overflow: 'auto', border: '1px solid #8886', borderRadius: 12, padding: 24, color: 'var(--dsw-alias-text-primary, #202020)', background: 'var(--dsw-alias-bg-base, #faf9f6)' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 16 } },
        h('h2', { style: { margin: 0, flex: 1, fontSize: 20 } }, 'Обновление Vishvakarma'),
        h('button', { type: 'button', onClick: close, 'aria-label': 'Закрыть обновление' }, 'Закрыть')),
      !status ? h('p', null, 'Читаем состояние плагина…') : h('div', null,
        h('p', null, `Установлено: ${status.installedVersion}`),
        status.runningVersion !== status.installedVersion ? h('p', null, `Сейчас работает: ${status.runningVersion}`) : null,
        status.sourceVersion ? h('p', null, `Версия исходников: ${status.sourceVersion} (локальная сборка)`): null,
        h('p', { style: { overflowWrap: 'anywhere', fontSize: 13 } }, `Профиль текущего окна: ${status.profile} · ${status.profileDirectory}`),
        h('p', { role: 'status', 'aria-live': 'polite' }, status.message),
        status.restartRequired ? h('p', null, 'Перезапустите DSH, чтобы загрузить установленную версию. После запуска проверьте Components → Running.') : null,
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', margin: '16px 0' } },
          h('button', { type: 'button', disabled: busy || !status.available || !status.settings.development || Boolean(dirty) || status.restartRequired, onClick: () => void action(() => ctx.remote.vishvakarma.checkUpdate()) }, 'Проверить обновление'),
          h('button', { type: 'button', disabled: busy || !status.canUpdate || Boolean(dirty), onClick: () => void action(() => ctx.remote.vishvakarma.installUpdate()) }, 'Обновить плагин')),
        draft ? h('details', { open: !status.settings.development },
          h('summary', null, 'Источник обновлений'),
          h('p', null, 'Загрузка готовых выпусков пока не подключена. Для локальной разработки можно собирать плагин из своих исходников.'),
          h('label', { style: { display: 'block', margin: '12px 0' } },
            h('input', { type: 'checkbox', checked: draft.development, disabled: busy, onChange: e => setDraft({ ...draft, development: e.currentTarget.checked }) }), ' Режим разработчика'),
          draft.development ? h('label', { style: { display: 'block' } }, 'Папка исходников plugin',
            h('input', { type: 'text', value: draft.directory, disabled: busy, placeholder: '/absolute/path/to/plugin', onChange: e => setDraft({ ...draft, directory: e.currentTarget.value }), style: { display: 'block', width: '100%', boxSizing: 'border-box', padding: 8, margin: '6px 0' } }),
            h('span', { style: { fontSize: 13 } }, 'Сборка запускает код из этой папки. Указывайте собственный checkout с установленными зависимостями.')) : null,
          h('button', { type: 'button', disabled: busy || !dirty || !status.available, style: { marginTop: 12 }, onClick: () => void action(() => ctx.remote.vishvakarma.saveUpdateSettings(draft)) }, 'Сохранить настройки')) : null,
        status.logPath ? h('details', { style: { marginTop: 16 } }, h('summary', null, 'Лог обновления'), h('p', { style: { overflowWrap: 'anywhere', userSelect: 'text', fontSize: 12 } }, status.logPath)) : null),
      error || connectionError ? h('p', { role: 'alert' }, error || connectionError) : null);
  }
  function UpdateButton({ active = true, compact = false }: { active?: boolean; compact?: boolean }) {
    const available = useSyncExternalStore(subscribe, () => updateAvailable);
    useEffect(() => {
      if (!active) return;
      const refresh = () => { if (document.visibilityState === 'visible') void refreshNotice(); };
      refresh();
      window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
      return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
    }, [active]);
    const label = available ? 'Обновление плагина: есть изменения в исходниках' : 'Обновление плагина';
    return compact ? h(ToolbarButton, { icon: 'update', label, badge: available, onClick: () => show(true) })
      : h('button', { type: 'button', title: label, onClick: () => show(true) }, available ? 'Обновление плагина · есть изменения' : 'Обновление плагина');
  }
  function UpdateOverlay() {
    const visible = useSyncExternalStore(subscribe, () => opened);
    return visible ? h(UpdateDialog, { close: () => show(false) }) : null;
  }
  // This stays independent of the selected panel. Session state reopens it when
  // DSH reloads our Client after installing a new package.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'vishvakarma-updater', order: 10 }, UpdateOverlay));
  ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register({ name: 'plugins.detail.actions', id: 'vishvakarma-update', order: 10 },
    ({ subject }) => subject.kind === 'bundle' && subject.pkg.name === '@vishkarman/plugin' ? h(UpdateButton) : null));
  return UpdateButton;
}
