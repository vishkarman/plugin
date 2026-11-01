import { createElement as h, useEffect, useRef } from 'react';

export function ReloadStudioDialog({ cancel, reload, disabled }: { cancel: () => void; reload: () => void; disabled: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null), cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { dialog.current?.showModal(); cancelButton.current?.focus(); }, []);
  return h('dialog', { ref: dialog, onCancel: cancel, 'aria-labelledby': 'vishvakarma-reload-title', 'aria-describedby': 'vishvakarma-reload-description',
    style: { width: 'min(440px, 85vw)', maxHeight: '85vh', overflow: 'auto', border: '1px solid var(--dsw-alias-border-l1, GrayText)', borderRadius: 12, padding: 24, color: 'var(--dsw-alias-label-primary, CanvasText)', background: 'var(--dsw-alias-bg-base, Canvas)' } },
    h('h2', { id: 'vishvakarma-reload-title', style: { margin: '0 0 16px', fontSize: 20 } }, 'Перезагрузить Studio?'),
    h('p', { id: 'vishvakarma-reload-description' }, 'Studio загрузит актуальный интерфейс с сервера. Несохранённые поля и состояние предпросмотра могут сброситься. Сначала сохраните нужные изменения.'),
    h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 20 } },
      h('button', { ref: cancelButton, type: 'button', onClick: cancel }, 'Отмена'),
      h('button', { type: 'button', onClick: reload, disabled }, 'Перезагрузить')));
}
