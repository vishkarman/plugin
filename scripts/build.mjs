import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const provenance = JSON.parse(await readFile('contracts/source.json', 'utf8'));
for (const [file, source] of Object.entries(provenance.files)) {
  const contract = await readFile('contracts/' + file);
  if (createHash('sha256').update(contract).digest('hex') !== source.sha256) throw new Error('Contract copy hash differs from source.json: ' + file);
}
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/host.ts', 'src/connect.ts'], outdir: 'dist', bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['@deepseek-ai/*'], banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" }, sourcemap: true });
const client = await build({ entryPoints: ['src/client.ts'], bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', external: ['@deepseek-ai/*'], write: false });
await writeFile('dist/client.js', 'window.__ModuleLoader__.load({id:"@vishkarman/plugin",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n' + client.outputFiles[0].text + '\nreturn module.exports;}});\n');
