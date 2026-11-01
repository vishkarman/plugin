import type { Context } from '@deepseek-ai/cordis';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react';
import type { UpdateSettings, UpdateStatus } from './update-contract.js';
import { ToolbarButton } from './toolbar-button.js';
import { HostDialog } from './ui/host-dialog.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { Label } from './ui/label.js';
import { Checkbox } from './ui/checkbox.js';
import { Alert } from './ui/alert.js';

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
    const [status, setStatus] = useState<UpdateStatus | null>(null);
    const [draft, setDraft] = useState<UpdateSettings | null>(null);
    const [error, setError] = useState(''), [connectionError, setConnectionError] = useState(''), [pending, setPending] = useState(false);
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
    return h(HostDialog, { title: 'Обновление Vishvakarma', close, headerAction: h(ToolbarButton, { icon: 'close', label: 'Закрыть обновление', onClick: close }) },
      !status ? h('p', null, 'Читаем состояние плагина…') : h('div', null,
        h('p', null, `Установлено: ${status.installedVersion}`),
        status.runningVersion !== status.installedVersion ? h('p', null, `Сейчас работает: ${status.runningVersion}`) : null,
        status.sourceVersion ? h('p', null, `Версия исходников: ${status.sourceVersion} (локальная сборка)`): null,
        h('p', { style: { overflowWrap: 'anywhere', fontSize: 13 } }, `Профиль текущего окна: ${status.profile} · ${status.profileDirectory}`),
        h(Alert, { role: 'status', 'aria-live': 'polite', className: 'vkp:mt-3' }, status.message),
        status.restartRequired ? h('p', null, 'Перезапустите DSH, чтобы загрузить установленную версию. После запуска проверьте Components → Running.') : null,
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', margin: '16px 0' } },
          h(Button, { type: 'button', disabled: busy || !status.available || !status.settings.development || Boolean(dirty) || status.restartRequired, onClick: () => void action(() => ctx.remote.vishvakarma.checkUpdate()) }, 'Проверить обновление'),
          h(Button, { type: 'button', disabled: busy || !status.canUpdate || Boolean(dirty), onClick: () => void action(() => ctx.remote.vishvakarma.installUpdate()) }, 'Обновить плагин')),
        draft ? h('details', { open: !status.settings.development },
          h('summary', null, 'Источник обновлений'),
          h('p', null, 'Загрузка готовых выпусков пока не подключена. Для локальной разработки можно собирать плагин из своих исходников.'),
          h(Label, { className: 'vkp:flex vkp:items-center vkp:gap-2 vkp:my-3' },
            h(Checkbox, { checked: draft.development, disabled: busy, onCheckedChange: checked => setDraft({ ...draft, development: checked === true }) }), 'Режим разработчика'),
          draft.development ? h(Label, { className: 'vkp:block' }, 'Папка исходников plugin',
            h(Input, { type: 'text', value: draft.directory, disabled: busy, placeholder: '/absolute/path/to/plugin', onChange: e => setDraft({ ...draft, directory: e.currentTarget.value }), className: 'vkp:my-2' }),
            h('span', { style: { fontSize: 13 } }, 'Сборка запускает код из этой папки. Указывайте собственный checkout с установленными зависимостями.')) : null,
          h(Button, { type: 'button', disabled: busy || !dirty || !status.available, style: { marginTop: 12 }, onClick: () => void action(() => ctx.remote.vishvakarma.saveUpdateSettings(draft)) }, 'Сохранить настройки')) : null,
        status.logPath ? h('details', { style: { marginTop: 16 } }, h('summary', null, 'Лог обновления'), h('p', { style: { overflowWrap: 'anywhere', userSelect: 'text', fontSize: 12 } }, status.logPath)) : null),
      error || connectionError ? h(Alert, { className: 'vkp:mt-3' }, error || connectionError) : null);
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
      : h('span', { className: 'vishvakarma-plugin-ui' }, h(Button, { type: 'button', variant: 'outline', title: label, onClick: () => show(true) }, available ? 'Обновление плагина · есть изменения' : 'Обновление плагина'));
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
