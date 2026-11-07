import type { Context } from '@deepseek-ai/cordis';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
const BASE_TTL_MS = 7 * 24 * 60 * 60_000;
const BASE_LIMIT = 10;
const safeSegment = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_');
export const workspaceBaseRoot = (credentialsFile: string, projectId: string) => join(dirname(credentialsFile), 'chat', 'workspace-base', safeSegment(projectId));
export const workspaceRoot = (credentialsFile: string) => join(dirname(credentialsFile), 'chat', 'workspace');
export const workspaceRootFor = (credentialsFile: string, exec?: any) => {
  const cwd = exec?.agent?.session?.header?.cwd ?? exec?.agent?.session?.cwd ?? exec?.agent?.options?.cwd;
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


async function writeSnapshot(context: { projectId: string; revisionId: string; files: Array<{ path: string; content: string; sha256: string }> }, root: string) {
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

async function collectBaseGarbage(credentialsFile: string, projectId: string) {
  const root = workspaceBaseRoot(credentialsFile, projectId);
  const names = await readdir(root).catch(() => []);
  const entries = [];
  for (const name of names) {
    const path = join(root, name);
    const info = await stat(path).catch(() => null);
    if (info?.isDirectory()) entries.push({ path, age: Date.now() - info.mtimeMs });
  }
  entries.sort((a, b) => b.age - a.age);
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index].age > BASE_TTL_MS || index >= BASE_LIMIT) await rm(entries[index].path, { recursive: true, force: true });
  }
}

/** Write the current project sources and their provenance into the workspace. */
export async function syncWorkspaceFromContext(context: { projectId: string; revisionId: string; files: Array<{ path: string; content: string; sha256: string }> }, root: string, credentialsFile?: string) {
  const manifest = await writeSnapshot(context, root);
  if (credentialsFile) {
    await writeSnapshot(context, join(workspaceBaseRoot(credentialsFile, context.projectId), context.revisionId));
    await collectBaseGarbage(credentialsFile, context.projectId);
  }
  return manifest;
}

/** Fetch the project sources into the chat workspace together with provenance. */
export function registerWorkspaceTools(ctx: Context, connection: Connection, credentialsFile: string) {
  ctx.tools.register(defineTool({
    name: 'vishvakarma_workspace_sync',
    description: 'Синхронизировать исходники проекта в рабочую папку чата и записать манифест ревизии. Вызывайте перед редактированием локальных файлов; устаревшая папка не должна публиковаться.',
    parameters: { projectId: { type: 'string', required: true, description: 'Идентификатор проекта' }, files: { type: 'array', items: { type: 'string' }, description: 'Необязательно: синхронизировать только эти пути' } },
    output, isConcurrencySafe: () => false,
    execute: async ({ projectId, files }, exec) => run(async () => {
      const context = await connection.adapterProject(String(projectId), false, undefined, exec.signal, Array.isArray(files) ? files.map(String) : undefined);
      const manifest = await syncWorkspaceFromContext(context, workspaceRootFor(credentialsFile, exec), credentialsFile);
      return { projectId: manifest.projectId, revisionId: manifest.revisionId, files: Object.keys(manifest.files) };
    }),
  }));
}

/** Read-only snapshot diagnostics for the agent and chat UI. */
export function registerWorkspaceStatusTools(ctx: Context, connection: Connection, credentialsFile: string) {
  ctx.tools.register(defineTool({
    name: 'vishvakarma_workspace_status',
    description: 'Показать состояние рабочей копии: базовая ревизия, актуальная ревизия проекта, устаревание, число файлов и размер immutable base. Ничего не меняет.',
    parameters: { projectId: { type: 'string', required: true, description: 'Идентификатор проекта' } },
    output, isConcurrencySafe: () => true,
    execute: async ({ projectId }, exec) => run(async () => {
      const root = workspaceRootFor(credentialsFile, exec);
      const manifest = await readWorkspaceManifestAt(root);
      if (!manifest) return { synced: false, projectId };
      const base = join(workspaceBaseRoot(credentialsFile, String(projectId)), manifest.revisionId);
      let bytes = 0, entries = 0;
      const walk = async (dir: string) => {
        for (const name of await readdir(dir).catch(() => [])) {
          const path = join(dir, name);
          const info = await stat(path).catch(() => null);
          if (!info) continue;
          if (info.isDirectory()) await walk(path);
          else { bytes += info.size; entries += 1; }
        }
      };
      await walk(base);
      const current = await connection.adapterProject(String(projectId), false, undefined, exec.signal);
      return { synced: true, projectId, baseRevisionId: manifest.revisionId, currentRevisionId: current.revisionId,
        stale: manifest.revisionId !== current.revisionId, files: Object.keys(manifest.files).length, baseBytes: bytes, baseEntries: entries };
    }),
  }));
}
