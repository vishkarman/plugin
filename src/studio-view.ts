import { createElement as h, forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { DesktopBrowserBridge, DesktopBrowserReservation } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types';

// Public Desktop browser bridge; the shell owns the guest's sandbox and cookies.
export function desktopBrowser(): DesktopBrowserBridge | undefined {
  const carrier = (globalThis as typeof globalThis & {
    dshDesktop?: { protocolVersion: number; browser?: DesktopBrowserBridge };
  }).dshDesktop;
  return window.location.origin === 'dsh-app://app' && carrier?.protocolVersion === 1 ? carrier.browser : undefined;
}

interface StudioGuest extends HTMLElement {
  loadURL(url: string): Promise<void>;
  reload(): void;
}

export interface StudioControls { reload(): void }
interface DesktopStudioProps {
  url: string; bridge: DesktopBrowserBridge; onNavigate?: (url: string) => void;
  onLoadingChange?: (loading: boolean) => void;
}
export const DesktopStudio = forwardRef<StudioControls, DesktopStudioProps>(function DesktopStudio({ url, bridge, onNavigate, onLoadingChange }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const page = useRef<StudioGuest | null>(null);
  const navigation = useRef(onNavigate);
  navigation.current = onNavigate;
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { onLoadingChange?.(loading); }, [loading, onLoadingChange]);
  useImperativeHandle(ref, () => ({
    reload() {
      if (!page.current || loading) throw new Error('Studio ещё не готова к перезагрузке.');
      setError('');
      // Reload the existing guest: keep its current project URL, browser login,
      // sessionStorage and DSH lease. Loading events also cover cancelled unloads.
      page.current.reload();
    },
  }), [loading]);
  useEffect(() => {
    const container = host.current!;
    const lifetime = new AbortController();
    let reservation: DesktopBrowserReservation | undefined;
    let guest: StudioGuest | undefined;
    let unsubscribe: (() => void) | undefined;
    setError(''); setLoading(true);
    const release = () => {
      unsubscribe?.(); unsubscribe = undefined;
      if (page.current === guest) page.current = null;
      guest?.remove(); guest = undefined;
      const owned = reservation; reservation = undefined;
      if (owned) void bridge.release(owned.lease).catch(() => {
        console.error('Vishvakarma: failed to release Desktop browser guest.');
      });
    };
    const failed = () => {
      if (!lifetime.signal.aborted) {
        setLoading(false);
        setError('Не удалось открыть Studio. Проверьте, что сервер запущен, и повторите подключение.');
      }
    };
    void (async () => {
      // All projects of one server share the user's browser login, independently of the DSH chat.
      const acquired = await bridge.acquire('vishvakarma:' + new URL(url).origin);
      if (lifetime.signal.aborted) { await bridge.release(acquired.lease); return; }
      reservation = acquired;
      const element = document.createElement('webview') as StudioGuest;
      guest = element;
      page.current = element;
      element.setAttribute('aria-label', 'Vishvakarma Studio');
      element.setAttribute('name', acquired.lease);
      element.setAttribute('partition', acquired.partition);
      element.setAttribute('allowpopups', '');
      // DSH accepts only its own reservation bootstrap; navigate after the guest is attached.
      element.setAttribute('src', 'about:blank#' + acquired.lease);
      Object.assign(element.style, { display: 'flex', width: '100%', height: '100%', minWidth: '0', minHeight: '0', flex: '1', border: '0' });
      unsubscribe = bridge.onOpenRequested(acquired.lease, value => {
        if (lifetime.signal.aborted) return;
        const destination = new URL(value);
        if (['http:', 'https:'].includes(destination.protocol) && !destination.username && !destination.password)
          window.open(destination.href, '_blank', 'noopener,noreferrer');
      });
      let navigated = false;
      let ready = false;
      const trackUrl = (event: Event) => {
        const value = event as Event & { url: string; isMainFrame?: boolean };
        if (value.isMainFrame === false) return;
        try { if (new URL(value.url).origin === new URL(url).origin) navigation.current?.(value.url); } catch {}
      };
      element.addEventListener('did-navigate', trackUrl, { signal: lifetime.signal });
      element.addEventListener('did-navigate-in-page', trackUrl, { signal: lifetime.signal });
      element.addEventListener('dom-ready', () => {
        if (!navigated) {
          navigated = true;
          const studioUrl=new URL(url);studioUrl.searchParams.set('surface','dsh-desktop');
          void element.loadURL(studioUrl.href).catch(failed);
        } else { ready = true; setLoading(false); setError(''); }
      }, { signal: lifetime.signal });
      element.addEventListener('did-start-loading', () => { setLoading(true); }, { signal: lifetime.signal });
      element.addEventListener('did-stop-loading', () => { if (ready) setLoading(false); }, { signal: lifetime.signal });
      element.addEventListener('did-fail-load', event => {
        const failure = event as Event & { isMainFrame?: boolean; errorCode?: number };
        if (failure.isMainFrame && failure.errorCode !== -3) failed();
      }, { signal: lifetime.signal });
      element.addEventListener('render-process-gone', failed, { signal: lifetime.signal });
      element.addEventListener('destroyed', failed, { signal: lifetime.signal });
      container.append(element);
    })().catch(() => { release(); failed(); });
    return () => { lifetime.abort(); release(); };
  }, [url, bridge, attempt]);

  return h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 } },
    loading ? h('p', { role: 'status', style: { margin: 0, padding: '8px 16px' } }, 'Открываем Studio…') : null,
    error ? h('div', { role: 'alert', style: { padding: '8px 16px' } }, h('p', null, error),
      h('button', { type: 'button', onClick: () => setAttempt(value => value + 1) }, 'Повторить')) : null,
    h('div', { ref: host, style: { display: 'flex', flex: 1, minWidth: 0, minHeight: 0 } }));
});
