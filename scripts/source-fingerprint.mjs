import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

// Shared by packaging and the lightweight update indicator. No builds, imports
// from the source checkout, network requests or dependency traversal.
export const inputs = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'components.json', 'cordis.patch.yml', 'README.md', 'src', 'contracts', 'skills', 'scripts'];
export async function sourceFingerprint(root) {
  const hash = createHash('sha256');
  async function visit(relative) {
    const path = join(root, relative), info = await stat(path);
    if (info.isDirectory()) { for (const name of (await readdir(path)).sort()) await visit(join(relative, name)); }
    else { hash.update(relative); hash.update('\0'); hash.update(await readFile(path)); }
  }
  for (const relative of inputs) await visit(relative);
  return hash.digest('hex');
}
