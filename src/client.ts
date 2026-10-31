import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-commands/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-browser/client';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import { studioRemote } from './remote.js';

export const inject = ['remote', 'commandUi', 'sidebarRight', 'sidebarRightTabs'];
export async function apply(ctx: Context) {
  await ctx.remote.$mount(studioRemote);
  ctx.inject(['remote.vishvakarma'], child => registerCommand(child));
}
function registerCommand(ctx: Context) {
  ctx.commandUi.register({
    name: 'vishvakarma', label: () => 'Открыть Vishvakarma', description: () => 'Studio локального дизайн-проекта',
    available: () => true,
    ui: { kind: 'action', run: () => { void openStudio(); } },
  });
  async function openStudio() {
    try {
      const result = await ctx.remote.vishvakarma.studio();
      if (!result.ok) throw new Error('Не удалось получить подключение Vishvakarma от DSH Host.');
      if (!result.value.available) throw new Error(result.value.message);
      if (!ctx.sidebarRightTabs.get('browser')) throw new Error('Панель Browser недоступна. Включите Browser-пакет DSH.');
      // The public controller resolves the registered Browser tab type.
      ctx.sidebarRight.openTab('browser', { params: { url: result.value.url } });
    } catch (error) { window.alert(error instanceof Error ? error.message : 'Панель Browser недоступна. Включите Browser-пакет DSH.'); }
  }
}
