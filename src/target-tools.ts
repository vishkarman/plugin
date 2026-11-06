import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Connection } from './connection.js';
import { output, run } from './tool-output.js';

/**
 * Compact projection of one existing SourceTarget. The full project context still comes from the
 * server, but only the target card, asset metadata and access are handed to the model.
 */
export function registerTargetTools(ctx: Context, connection: Connection) {
  ctx.tools.register(defineTool({
    name: 'vishvakarma_read_target',
    description: [
      'Компактно читает одну цель проекта из analysis.targets: атрибуты/текст, доступные операции, ограничения, ревизию.',
      'Используйте перед точечной правкой вместо полного чтения проекта.',
      'Для замены картинки ищите операцию с property "attr:src" (или attr:alt/attr:href) и передайте её в vishvakarma_edit_target.',
    ].join(' '),
    parameters: {
      projectId: { type: 'string', required: true, description: 'Идентификатор проекта' },
      targetId: { type: 'string', required: true, description: 'id цели из выделения или предыдущего контекста' },
    },
    output, isConcurrencySafe: () => true,
    execute: async ({ projectId, targetId }, exec) => run(async () => {
      const context = await connection.adapterProject(projectId, false, String(targetId), exec.signal);
      const target = context.analysis.targets.find(item => item.id === targetId);
      if (!target) throw new Error('Цель не найдена в текущей ревизии; прочитайте выделение заново.');
      return {
        projectId: context.projectId, name: context.name, revisionId: context.revisionId,
        entrypoint: context.entrypoint, access: context.access,
        target: {
          id: target.id, label: target.label, kind: target.kind, scope: target.scope,
          source: target.source, operations: target.operations, limitations: target.limitations,
          relatedTargetIds: target.relatedTargetIds,
        },
        assets: context.assets.map(asset => ({ path: asset.path, mime: asset.mime, size: asset.size, sha256: asset.sha256 })),
      };
    }),
  }));
}
