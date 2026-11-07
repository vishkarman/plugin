import type { Context } from '@deepseek-ai/cordis';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Connection } from './connection.js';
import { output, run } from './tool-output.js';
import { readWorkspaceManifestAt, workspaceBaseRoot, workspaceRootFor } from './workspace-tools.js';

const MAX_FILES = 8;
const MAX_EDITS = 32;

/** Apply exact, base-bound string replacements without sending whole files through the model. */
export function registerPatchTools(ctx: Context, connection: Connection, credentialsFile: string) {
  ctx.tools.register(defineTool({
    name: 'vishvakarma_patch_files',
    description: 'Точечно изменить существующие исходники по закреплённой базе: точные замены find→replace, без fuzzy-поиска и без полного содержимого файла. Требует vishvakarma_workspace_sync и совпадения baseRevisionId.',
    parameters: {
      projectId: { type: 'string', required: true, description: 'Идентификатор проекта' },
      baseRevisionId: { type: 'string', required: true, description: 'UUID базовой ревизии из workspace_sync' },
      files: { type: 'array', required: true, description: 'До 8 файлов: path и edits [{find, replace}]' },
    },
    output, isConcurrencySafe: () => false,
    execute: async ({ projectId, baseRevisionId, files }, exec) => run(async () => {
      const root = workspaceRootFor(credentialsFile, exec);
      const manifest = await readWorkspaceManifestAt(root);
      if (!manifest || manifest.projectId !== projectId || manifest.revisionId !== baseRevisionId) {
        throw new Error('Нет синхронизированной базы этой ревизии. Сначала vishvakarma_workspace_sync.');
      }
      if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) throw new Error('Нужно от 1 до 8 файлов.');
      const baseDir = join(workspaceBaseRoot(credentialsFile, projectId), baseRevisionId);
      const changed: Array<{ path: string; content: string; expectedHash: string }> = [];
      for (const raw of files as Array<Record<string, unknown>>) {
        const path = String(raw.path ?? '');
        const expectedHash = manifest.files[path];
        if (!path || !expectedHash) throw new Error('Файл отсутствует в закреплённой базе: ' + path);
        const target = resolve(baseDir, path);
        if (!target.startsWith(resolve(baseDir) + '/')) throw new Error('Недопустимый путь файла.');
        let content = await readFile(target, 'utf8').catch(() => null);
        if (content === null) throw new Error('Файл базы недоступен: ' + path);
        const edits = Array.isArray(raw.edits) ? raw.edits : [];
        if (edits.length < 1 || edits.length > MAX_EDITS) throw new Error('Нужно от 1 до ' + MAX_EDITS + ' замен на файл.');
        for (const edit of edits as Array<Record<string, unknown>>) {
          const find = String(edit.find ?? ''), replace = String(edit.replace ?? '');
          if (!find) throw new Error('Пустой find запрещён.');
          if (!content.includes(find)) throw new Error('Точный фрагмент не найден в ' + path + ': ' + find.slice(0, 80));
          content = content.split(find).join(replace);
        }
        changed.push({ path, content, expectedHash });
      }
      const result = await connection.adapterChange(projectId, baseRevisionId, { type: 'files', files: changed }, exec.signal);
      if (!('saved' in result) || !result.saved) throw new Error('Сервер не подтвердил патч.');
      return { saved: true, revisionId: result.revisionId, files: changed.map(file => file.path) };
    }),
  }));
}
