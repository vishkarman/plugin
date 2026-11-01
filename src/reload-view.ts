import { createElement as h, useRef } from 'react';
import { HostDialog } from './ui/host-dialog.js';
import { Button } from './ui/button.js';
export function ReloadStudioDialog({ cancel, reload, disabled }: { cancel: () => void; reload: () => void; disabled: boolean }) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  return h(HostDialog, { title: 'Перезагрузить Studio?', compact: true, close: cancel, initialFocus: cancelButton,
    description: 'Studio загрузит актуальный интерфейс с сервера. Несохранённые поля и состояние предпросмотра могут сброситься. Сначала сохраните нужные изменения.',
    actions: h('div', { className: 'vkp:flex vkp:gap-3' },
      h(Button, { ref: cancelButton, variant: 'outline', onClick: cancel }, 'Отмена'),
      h(Button, { onClick: reload, disabled }, 'Перезагрузить')) });
}
