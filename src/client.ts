import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-commands/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-browser/client';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import { createElement as h, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { studioRemote, type StudioConnection } from './remote.js';
import { DesktopStudio, desktopBrowser, type StudioControls } from './studio-view.js';
import { updateView } from './update-view.js';
import { ToolbarButton } from './toolbar-button.js';
import { Button } from './ui/button.js';
import { Alert } from './ui/alert.js';
import { installStyles } from './ui/styles.js';
import { ReloadStudioDialog } from './reload-view.js';

const panelId = 'vishvakarma' as MainPanelId;
export const inject = ['remote', 'commandUi', 'layout', 'slots'];
export async function apply(ctx: Context) {
  ctx.effect(() => installStyles());
  await ctx.remote.$mount(studioRemote);
  ctx.inject(['remote.vishvakarma'], child => registerWorkspace(child));
}
function registerWorkspace(ctx: Context) {
  const UpdateButton = updateView(ctx);
  const getConnection = async () => {
    const result = await ctx.remote.vishvakarma.studio();
    if (!result.ok) throw new Error('Не удалось получить подключение Vishvakarma от DSH Host.');
    if (!result.value.available) throw new Error(result.value.message);
    return result.value;
  };
  // The global slot keeps the Studio guest mounted while DSH changes the central panel.
  // Only its public main-slot anchor controls geometry; no DSH DOM is inspected.
  let surface: { visible: boolean; left: number; top: number; width: number; height: number } = { visible: false, left: 0, top: 0, width: 0, height: 0 };
  const listeners = new Set<() => void>();
  const publish = (next: typeof surface) => { surface = next; for (const listener of listeners) listener(); };
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panelId }, Anchor));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: panelId, order: 0 }, Studio));
  function Anchor() {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      const element = ref.current!;
      const measure = () => { const rect = element.getBoundingClientRect(); publish({ visible: true, left: rect.left, top: rect.top, width: rect.width, height: rect.height }); };
      const observer = new ResizeObserver(measure);
      observer.observe(element); window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true); measure();
      return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); publish({ ...surface, visible: false }); };
    }, []);
    return h('div', { ref, style: { width: '100%', height: '100%', minHeight: 0 }, 'aria-hidden': true });
  }
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: panelId, label: () => 'Vishvakarma', order: 250,
  }, ({ size }) => h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
    h('path', { d: 'M4 5h16v14H4zM8 9l4 7 4-7M4 5l4-3h12v3', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }))));
  ctx.commandUi.register({
    name: 'vishvakarma', label: () => 'Открыть Vishvakarma', description: () => 'Рабочая область дизайн-проектов',
    available: () => true, ui: { kind: 'action', run: () => { ctx.layout.selectPanel(panelId); } },
  });
  function Studio() {
    const bounds = useSyncExternalStore(subscribe, () => surface);
    const [opened, setOpened] = useState(false);
    useEffect(() => { if (bounds.visible) setOpened(true); }, [bounds.visible]);
    const [connection, setConnection] = useState<StudioConnection | null>(null);
    const [error, setError] = useState(''), [actionError, setActionError] = useState('');
    const [attempt, setAttempt] = useState(0);
    const [besideUrl, setBesideUrl] = useState<string | null>(null);
    const currentUrl = useRef('');
    const studio = useRef<StudioControls>(null);
    const [studioLoading, setStudioLoading] = useState(true), [confirmReload, setConfirmReload] = useState(false);
    useEffect(() => {
      if (!opened) return;
      let active = true;
      void getConnection().then(value => { if (active) { setConnection(value); setError(''); } }, reason => {
        if (active) setError(reason instanceof Error ? reason.message : 'Studio недоступна.');
      });
      return () => { active = false; };
    }, [attempt, opened]);
    function besideChat() {
      if (!connection) return;
      const sidebar = ctx.get('sidebarRight'), tabs = ctx.get('sidebarRightTabs');
      if (!sidebar || !tabs?.get('browser')) { setActionError('Включите Browser-пакет DSH, чтобы открыть Studio рядом с чатом.'); return; }
      setActionError('');
      const url = new URL(currentUrl.current || connection.url);
      url.searchParams.delete('surface');
      setBesideUrl(url.href);
      ctx.layout.selectPanel(null);
    }
    useEffect(() => {
      if (!besideUrl || bounds.visible) return;
      setBesideUrl(null);
      if (ctx.layout.panelInfo.getSnapshot().activePanelId !== null) return;
      // DSH creates the current chat's sidebar store during render. Open from
      // the following commit, after the Studio anchor has been removed.
      const sidebar = ctx.get('sidebarRight');
      try {
        if (!sidebar?.mounted.getSnapshot()) throw new Error('Сначала откройте или создайте чат в DSH, затем нажмите «Открыть Studio рядом с чатом».');
        sidebar.openTab('browser', { params: { url: besideUrl } });
      } catch (reason) {
        setActionError(reason instanceof Error && !sidebar?.mounted.getSnapshot() ? reason.message : 'Не удалось открыть Studio рядом с чатом. Откройте чат и повторите действие.');
        ctx.layout.selectPanel(panelId);
      }
    }, [besideUrl, bounds.visible]);
    const sameSite = connection && new URL(connection.url).hostname === window.location.hostname;
    const desktop = desktopBrowser();
    function reloadStudio() {
      setConfirmReload(false); setActionError('');
      try {
        if (!studio.current) throw new Error('Studio недоступна для перезагрузки.');
        studio.current.reload();
      } catch (reason) { setActionError(reason instanceof Error ? reason.message : 'Не удалось перезагрузить Studio. Повторите действие.'); }
    }
    return h('section', { className: 'vishvakarma-plugin-ui', style: { position: 'fixed', left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height, pointerEvents: 'auto', minHeight: 0, display: bounds.visible ? 'flex' : 'none', flexDirection: 'column', background: 'var(--vkp-background)' } },
      h('header', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--vkp-border)' } },
        h('strong', null, 'Vishvakarma'),
        h('span', { style: { flex: 1 } }),
        h(UpdateButton, { active: bounds.visible, compact: true }),
        desktop ? h(ToolbarButton, { icon: 'reload', label: 'Перезагрузить Studio', onClick: () => setConfirmReload(true), disabled: !connection || studioLoading }) : null,
        h(ToolbarButton, { icon: 'beside', label: 'Открыть Studio рядом с чатом', onClick: besideChat, disabled: !connection }),
        h(ToolbarButton, { icon: 'close', label: 'Закрыть Studio и вернуться к чату', onClick: () => ctx.layout.selectPanel(null) })),
      confirmReload ? h(ReloadStudioDialog, { cancel: () => setConfirmReload(false), reload: reloadStudio, disabled: studioLoading }) : null,
      actionError ? h(Alert, { className: 'vkp:m-2' }, actionError) : null,
      error ? h(Alert, { className: 'vkp:m-4 vkp:space-y-3' }, h('p', null, error),
        h(Button, { type: 'button', onClick: () => setAttempt(value => value + 1) }, 'Повторить'))
      : !connection ? h('p', { style: { padding: 24 } }, 'Подключаем Studio…')
      : desktop ? h(DesktopStudio, { ref: studio, url: connection.url, bridge: desktop, onNavigate: url => { currentUrl.current = url; }, onLoadingChange: setStudioLoading })
      : !sameSite ? h('div', { style: { padding: 24 } },
        h('p', null, 'Адрес Studio и DSH используют разные локальные имена. Для браузерной сессии откройте Studio рядом с чатом либо настройте одинаковое имя (например, 127.0.0.1).'),
        h(Button, { type: 'button', onClick: besideChat }, 'Открыть рядом с чатом'))
      : h('iframe', { title: 'Vishvakarma Studio', src: connection.url, style: { width: '100%', flex: 1, minHeight: 0, border: 0 }, allow: 'clipboard-write' }));
  }
}
