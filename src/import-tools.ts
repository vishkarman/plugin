import type { Context } from '@deepseek-ai/cordis';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Connection } from './connection.js';
import { output, run } from './tool-output.js';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const MAX_FILES = 8;
const MAX_BYTES = 512 * 1024;

/**
 * Publish already-generated local files byte-for-byte without asking the model to reproduce their
 * contents in tool arguments. Source paths are constrained to the plugin's chat workspace.
 */
export function registerImportTools(ctx: Context, connection: Connection, credentialsFile: string) {
  ctx.tools.register(defineTool({
    name: 'vishvakarma_import_files',
    description: [
      'Публикует готовые локальные файлы в проект байт-в-байт без передачи их содержимого в аргументах.',
      'Используйте для файлов, которые агент уже создал/изменил в рабочей папке чата, вместо vishvakarma_write_files с большим содержимым.',
      'sourcePath — путь относительно рабочей папки текущей чат-сессии; targetPath — путь файла в проекте.',
      'expectedHash можно не указывать: мост возьмёт текущий хеш из проекта; при конфликте ничего не записывает.',
    ].join(' '),
    parameters: {
      projectId: { type: 'string', required: true, description: 'Идентификатор проекта' },
      baseRevisionId: { type: 'string', required: true, description: 'UUID прочитанной ревизии проекта' },
      files: { type: 'array', required: true, description: 'До 8 файлов: sourcePath, targetPath, expectedHash?' },
    },
    output,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => run(async () => {
      const projectId = String(args.projectId ?? '');
      const baseRevisionId = String(args.baseRevisionId ?? '');
      const entries = Array.isArray(args.files) ? args.files : [];
      if (!projectId || !/^[0-9a-f-]{36}$/i.test(baseRevisionId) || entries.length < 1 || entries.length > MAX_FILES) {
        throw new Error('Нужен проект, UUID ревизии и от 1 до 8 файлов.');
      }
      const workspace = join(dirname(credentialsFile), 'chat', 'workspace');
      const root = await realpath(workspace).catch(() => null);
      if (!root) throw new Error('Рабочая папка чата ещё не создана.');
      const context = await connection.adapterProject(projectId, false, undefined, exec.signal);
      if (context.revisionId !== baseRevisionId) throw new Error('Ревизия проекта изменилась; прочитайте проект заново.');
      const existing = new Map(context.files.map(file => [file.path, file.sha256]));
      const imported: Array<{ sourcePath: string; targetPath: string; bytes: number; sha256: string }> = [];
      const files: Array<{ path: string; content: string; expectedHash: string | null }> = [];
      for (const raw of entries as Array<Record<string, unknown>>) {
        const sourcePath = String(raw.sourcePath ?? '');
        const targetPath = String(raw.targetPath ?? '');
        if (!sourcePath || !targetPath || targetPath.includes('..') || targetPath.startsWith('/')) throw new Error('Некорректный sourcePath/targetPath.');
        const candidate = resolve(root, sourcePath);
        const real = await realpath(candidate).catch(() => null);
        if (!real || relative(root, real).startsWith('..')) throw new Error('sourcePath вне рабочей папки чата.');
        const info = await stat(real);
        if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Можно импортировать только текстовые файлы до 512 КБ.');
        const bytes = await readFile(real);
        if (bytes.includes(0)) throw new Error('Файл не является текстовым (содержит NUL).');
        const content = bytes.toString('utf8');
        if (content.includes('\uFFFD')) throw new Error('Файл не является корректным UTF-8.');
        const hash = sha256(bytes);
        const expectedHash = typeof raw.expectedHash === 'string' ? raw.expectedHash : existing.get(targetPath) ?? null;
        files.push({ path: targetPath, content, expectedHash });
        imported.push({ sourcePath, targetPath, bytes: info.size, sha256: hash });
      }
      const result = await connection.adapterChange(projectId, baseRevisionId, { type: 'files', files }, exec.signal);
      if (!('saved' in result) || !result.saved) throw new Error('Сервер не подтвердил импорт файлов.');
      return { saved: true, revisionId: result.revisionId, files: imported };
    }),
  }));
}
