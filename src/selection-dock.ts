import type { Context } from '@deepseek-ai/cordis';
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react';
import type { SelectionSnapshot } from '../contracts/selection.js';
import type { SelectionRemote } from './remote.js';
import type { MediaProfileSummary } from './media-contract.js';

/** Public `InputActions` subset from DSH's composer shell; absent outside a session-scoped dock. */
interface InsertActions {
  captureInsertion(): { start: number; end: number; draftRev: number };
  insertText(text: string, span: { start: number; end: number; draftRev: number }): boolean;
}

const STALE_MS = 10 * 60_000;
const ASPECTS = ['1:1', '4:3', '16:9', '9:16', '3:2', '21:9'] as const;

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

const fieldStyle = {
  width: '100%', boxSizing: 'border-box', padding: '4px 6px', borderRadius: 5,
  border: '0.5px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit', fontSize: 12,
} as const;

const smallButton = (busy: boolean) => ({
  border: 'none', borderRadius: 999, padding: '3px 10px', fontFamily: 'inherit', fontSize: 12,
  cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
} as const);

/**
 * Composer dock entry: shows the published selection while it exists, inserts its compact context
 * into the DSH draft, and (for a project with agent edits allowed) offers image generation through
 * the platform's manual mode: `agent` prepares a chat request, `direct` calls the plugin host.
 */
export function selectionDockView(ctx: Context) {
  return function SelectionDock({ inputActions }: { inputActions?: InsertActions }) {
    const [snapshot, setSnapshot] = useState<SelectionRemote | null>(null);
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const [mode, setMode] = useState<'agent' | 'direct'>('agent');
    const [profiles, setProfiles] = useState<MediaProfileSummary[]>([]);
    const [formOpen, setFormOpen] = useState(false);
    const [profileId, setProfileId] = useState('core:draft');
    const [prompt, setPrompt] = useState('');
    const [aspect, setAspect] = useState('');
    const [replace, setReplace] = useState(false);
    const [generating, setGenerating] = useState(false);
    const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const showNotice = useCallback((text: string) => {
      setNotice(text);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setNotice(''), 8000);
    }, []);

    const copyText = useCallback(async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        showNotice('Текст скопирован. Вставьте его в задачу вручную.');
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

    useEffect(() => {
      let active = true;
      void (async () => {
        try {
          const [settings, catalog] = await Promise.all([
            ctx.remote.vishvakarma.mediaSettings(),
            ctx.remote.vishvakarma.mediaProfiles(),
          ]);
          if (!active) return;
          if (settings.ok && settings.value.supported) setMode(settings.value.manualGenerationMode);
          if (catalog.ok && catalog.value.length) {
            setProfiles(catalog.value);
            setProfileId(current => catalog.value.some((profile: MediaProfileSummary) => profile.id === current) ? current : catalog.value[0].id);
          }
        } catch { /* старая установка: ручная генерация остаётся только через агента */ }
      })();
      return () => { active = false; };
    }, [ctx]);

    if (!snapshot?.supported || !snapshot.selection) return null;
    const selection = snapshot.selection;
    const account = snapshot.account;
    const object = selection.targetId !== null;
    const stale = Date.now() - Date.parse(selection.capturedAt) > STALE_MS;
    const readOnly = snapshot.access ? !snapshot.access.canUseAgent : false;
    const selectedProfile = profiles.find(profile => profile.id === profileId) ?? null;
    const profileOptions: Array<Pick<MediaProfileSummary, 'id' | 'title' | 'costHintUsd'>> = profiles.length
      ? profiles
      : [{ id: 'core:draft', title: 'Быстрый черновик', costHintUsd: null }];
    const effectiveMode = readOnly ? 'agent' : mode;

    async function freshOrNotice(): Promise<SelectionSnapshot | null> {
      const fresh = await fetchSelection();
      if (!fresh?.supported || !fresh.selection) {
        setSnapshot(fresh);
        showNotice('Выделение пропало. Выберите объект в Studio и повторите.');
        return null;
      }
      const changed = fresh.selection.projectId !== selection.projectId
        || fresh.selection.revisionId !== selection.revisionId
        || fresh.selection.targetId !== selection.targetId
        || fresh.selection.artboardId !== selection.artboardId
        || fresh.selection.artboardEntrypoint !== selection.artboardEntrypoint;
      if (changed) {
        setSnapshot(fresh);
        showNotice('Выбор изменился — повторите действие.');
        return null;
      }
      return fresh;
    }

    async function insertContext() {
      if (!snapshot?.supported || !snapshot.selection) return;
      setBusy(true);
      try {
        const text = selectionContextText(snapshot);
        if (!inputActions) { await copyText(text); return; }
        const span = inputActions.captureInsertion();
        const fresh = await freshOrNotice();
        if (!fresh) return;
        if (!inputActions.insertText(selectionContextText(fresh), span)) await copyText(text);
        else showNotice('Контекст добавлен в задачу.');
      } finally { setBusy(false); }
    }

    function generationRequestText(fresh: SelectionSnapshot): string {
      const aspectLine = aspect ? `\nАспект: ${aspect}.` : '';
      const replaceLine = replace && selection.targetId
        ? '\nЗамени выделенное изображение, сохранив его путь (replace:true, sourceAsset — путь этого изображения).'
        : '';
      return `${selectionContextText(fresh)}\nСгенерируй изображение профилем ${profileId}. Промпт: ${prompt.trim()}${aspectLine}${replaceLine}`;
    }

    async function submitGeneration() {
      if (generating || busy) return;
      if (!prompt.trim()) { showNotice('Введите промпт.'); return; }
      setGenerating(true);
      try {
        if (effectiveMode === 'agent') {
          if (!inputActions) {
            const fresh = await freshOrNotice();
            if (fresh) await copyText(generationRequestText(fresh));
            return;
          }
          const span = inputActions.captureInsertion();
          const fresh = await freshOrNotice();
          if (!fresh) return;
          if (!inputActions.insertText(generationRequestText(fresh), span)) await copyText(generationRequestText(fresh));
          else { showNotice('Запрос добавлен в черновик — отправьте сообщение.'); setFormOpen(false); }
          return;
        }
        const reply = await ctx.remote.vishvakarma.generateMedia({
          prompt: prompt.trim(), profile: profileId, ...(aspect ? { aspectRatio: aspect } : {}),
          ...(replace && !!selection.targetId ? { replace: true } : {}),
        });
        if (!reply.ok) throw new Error(reply.error.message || 'Генерация не удалась.');
        const asset = reply.value.assets[0];
        showNotice(`Готово: ${asset?.path ?? 'изображение'} (ревизия ${reply.value.revisionId.slice(0, 8)}). Обновите Studio, если картинка не появилась.`);
        setFormOpen(false);
      } catch (error) {
        showNotice(error instanceof Error ? error.message : 'Генерация не удалась.');
      } finally { setGenerating(false); }
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
        !readOnly ? h('button', {
          type: 'button', disabled: busy || generating, onClick: () => setFormOpen(open => !open),
          title: 'Сгенерировать изображение по выделению',
          style: { ...smallButton(busy || generating), marginLeft: 'auto', flex: 'none', background: 'transparent', color: 'var(--dsw-alias-label-primary)', border: '0.5px solid var(--dsw-alias-border-l2)' },
        }, formOpen ? 'Скрыть' : 'Сгенерировать…') : null,
        h('button', {
          type: 'button', disabled: busy || generating, onClick: () => void insertContext(),
          title: 'Вставит подготовленный контекст в черновик; сообщение отправляете вы',
          style: { ...smallButton(busy || generating), ...(readOnly ? { marginLeft: 'auto' } : {}), flex: 'none', background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-base)' },
        }, busy ? 'Вставляем…' : 'Вставить в задачу')),
      notice ? h('div', { role: 'status', style: { padding: '0 2px', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', ...labelStyle } }, notice) : null,
      formOpen && !readOnly ? h('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4, padding: 6, borderRadius: 6,
          border: '0.5px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
        },
      },
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
          h('label', { style: { display: 'flex', gap: 4, alignItems: 'center' } }, 'Профиль',
            h('select', {
              value: profileId, disabled: generating, onChange: (event: any) => setProfileId(String(event.target.value)),
              style: { ...fieldStyle, width: 'auto', maxWidth: 220 },
            }, ...profileOptions.map(profile =>
              h('option', { value: profile.id }, `${profile.title}${profile.costHintUsd ? ` · ~$${profile.costHintUsd}` : ''}`)))),
          h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } },
            effectiveMode === 'agent' ? 'запрос уйдёт агенту' : 'генерация напрямую из DSH')),
        h('textarea', {
          value: prompt, disabled: generating, rows: 2, placeholder: 'Что нарисовать или что изменить на выделенном изображении',
          onInput: (event: any) => setPrompt(String(event.target.value)),
          style: { ...fieldStyle, resize: 'vertical', minHeight: 44 },
        }),
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
          h('label', { style: { display: 'flex', gap: 4, alignItems: 'center' } }, 'Аспект',
            h('select', {
              value: aspect, disabled: generating, onChange: (event: any) => setAspect(String(event.target.value)),
              style: { ...fieldStyle, width: 'auto' },
            }, h('option', { value: '' }, 'как решит модель'), ...ASPECTS.map(value => h('option', { value }, value)))),
          object ? h('label', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
            h('input', { type: 'checkbox', checked: replace, disabled: generating, onChange: (event: any) => setReplace(!!event.target.checked) }),
            'заменить выделенное изображение') : null,
          h('button', {
            type: 'button', disabled: !prompt.trim() || generating,
            onClick: () => void submitGeneration(),
            style: { ...smallButton(!prompt.trim() || generating), marginLeft: 'auto', background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-base)' },
          }, generating ? 'Генерируем…' : (effectiveMode === 'agent' ? 'Вставить запрос' : 'Сгенерировать'))),
        selectedProfile?.description ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, selectedProfile.description) : null,
      ) : null);
  };
}
