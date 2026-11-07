import type { Context } from '@deepseek-ai/cordis';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Connection } from './connection.js';
import { output, run } from './tool-output.js';

export interface WorkspaceManifest {
  projectId: string;
  revisionId: string;
  files: Record<string, string>;
}

export const WORKSPACE_MANIFEST = '.vishvakarma-workspace.json';
export const workspaceRoot = (credentialsFile: string) => join(dirname(credentialsFile), 'chat', 'workspace');
export const workspaceRootFor = (credentialsFile: string, exec?: any) => {
  const cwd = exec?.agent?.session?.cwd ?? exec?.agent?.options?.cwd;
  return typeof cwd === 'string' && cwd ? cwd : workspaceRoot(credentialsFile);
};

export async function readWorkspaceManifestAt(root: string): Promise<WorkspaceManifest | null> {
  try {
    const raw = JSON.parse(await readFile(join(root, WORKSPACE_MANIFEST), 'utf8'));
    if (typeof raw?.projectId !== 'string' || typeof raw?.revisionId !== 'string' || typeof raw?.files !== 'object') return null;
    return raw as WorkspaceManifest;
  } catch { return null; }
}
export const readWorkspaceManifest = (credentialsFile: string) => readWorkspaceManifestAt(workspaceRoot(credentialsFile));


/** Write the current project sources and their provenance into the workspace. */
export async function syncWorkspaceFromContext(context: { projectId: string; revisionId: string; files: Array<{ path: string; content: string; sha256: string }> }, root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const files: Record<string, string> = {};
  for (const file of context.files) {
    const target = resolve(root, file.path);
    if (!target.startsWith(resolve(root) + '/')) throw new Error('Недопустимый путь проекта.');
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.content, { mode: 0o600 });
    files[file.path] = file.sha256;
  }
  const manifest: WorkspaceManifest = { projectId: context.projectId, revisionId: context.revisionId, files };
  await writeFile(join(root, WORKSPACE_MANIFEST), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return manifest;
}

/** Fetch the project sources into the chat workspace together with provenance. */
export function registerWorkspaceTools(ctx: Context, connection: Connection, credentialsFile: string) {
  ctx.tools.register(defineTool({
    name: 'vishvakarma_workspace_sync',
    description: 'Синхронизировать исходники проекта в рабочую папку чата и записать манифест ревизии. Вызывайте перед редактированием локальных файлов; устаревшая папка не должна публиковаться.',
    parameters: { projectId: { type: 'string', required: true, description: 'Идентификатор проекта' } },
    output, isConcurrencySafe: () => false,
    execute: async ({ projectId }, exec) => run(async () => {
      const context = await connection.adapterProject(String(projectId), false, undefined, exec.signal);
      const manifest = await syncWorkspaceFromContext(context, workspaceRootFor(credentialsFile, exec));
      return { projectId: manifest.projectId, revisionId: manifest.revisionId, files: Object.keys(manifest.files) };
    }),
  }));
}
