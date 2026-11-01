#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { finished } from 'node:stream/promises';
import { build } from 'esbuild';
import semver from 'semver';
import { parse } from 'yaml';
import { inputs, sourceFingerprint } from './source-fingerprint.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const settingsFile = join(root, '.dsh-update.local.json');
const packageName = '@vishkarman/plugin';
const macCli = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const sha = value => createHash('sha256').update(value).digest('hex');
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());

const help = `Обновление локальной сборки Vishvakarma в существующем профиле DSH.

  pnpm update:dsh --dsh-home /absolute/dsh-home --profile desktop
  pnpm update:dsh                 # повторное обновление запомненного профиля
  pnpm update:dsh --check         # только проверка, без установки

  --dsh /absolute/path/to/dsh     # другой штатный CLI (по умолчанию Desktop на macOS)
  --help                         # эта справка

Профиль и DSH_HOME задаются вместе; успешная установка запоминает выбор локально.
Каждый пакет получает уникальную local-версию. Исходники, их версия и dist не меняются.
Настройки и credentials сохраняются; запущенный DSH автоматически не перезапускается.
`;

async function exists(path) { try { await access(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--') continue;
    if (['--help', '--check', '--prepare'].includes(name)) { result[name.slice(2)] = true; continue; }
    if (!['--dsh-home', '--profile', '--dsh', '--result-file', '--context-file', '--expected-fingerprint'].includes(name) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Неизвестный или неполный параметр. Используйте pnpm update:dsh --help.');
    result[name.slice(2)] = args[++i];
  }
  if (Boolean(result.profile) !== Boolean(result['dsh-home'])) throw new Error('Укажите --profile и --dsh-home вместе: другой профиль не выбирается неявно.');
  if (result.prepare && !result['result-file']) throw new Error('--prepare требует --result-file.');
  for (const key of ['result-file', 'context-file']) if (result[key] && !isAbsolute(result[key])) throw new Error(`--${key} должен быть абсолютным путём.`);
  return result;
}

async function targetFor(args) {
  const saved = await exists(settingsFile) ? await json(settingsFile) : {};
  const target = args.profile ? { profile: args.profile, dshHome: args['dsh-home'], dsh: args.dsh ?? saved.dsh } : { ...saved, ...(args.dsh ? { dsh: args.dsh } : {}) };
  if (!target.profile || !target.dshHome) throw new Error('Сначала выберите профиль: pnpm update:dsh --dsh-home /absolute/dsh-home --profile desktop');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(target.profile) || !isAbsolute(target.dshHome)) throw new Error('Нужны имя профиля без путей и абсолютный --dsh-home.');
  target.dshHome = await realpath(target.dshHome);
  target.dsh ??= process.platform === 'darwin' && await exists(macCli) ? macCli : 'dsh';
  if (typeof target.dsh !== 'string' || !target.dsh || target.dsh.startsWith('-')) throw new Error('Некорректный путь CLI DSH.');
  return { profile: target.profile, dshHome: target.dshHome, dsh: target.dsh };
}

// Only the profile and home patch layers are used by this Desktop update command.
// Config overrides replace the row's config, matching DSH's patch semantics.
async function pluginConfig(patchFiles) {
  let config = {};
  for (const file of patchFiles) {
    if (!await exists(file)) continue;
    let rows;
    try { rows = parse(await readFile(file, 'utf8'), { logLevel: 'silent' }); } catch { throw new Error(`Не удалось прочитать YAML настроек: ${file}`); }
    if (rows == null) continue;
    if (!Array.isArray(rows)) throw new Error(`Ожидался список patch-записей: ${file}`);
    function visit(row) {
      if (!row || typeof row !== 'object') return;
      if (row.id === 'vishvakarma' && (!row.name || row.name === packageName) && Object.hasOwn(row, 'config')) {
        if (!row.config || typeof row.config !== 'object' || Array.isArray(row.config)) throw new Error('Некорректная config-запись Vishvakarma в patch.');
        config = row.config;
      }
      if (Array.isArray(row.insert)) row.insert.forEach(visit);
    }
    rows.forEach(visit);
  }
  return config;
}

async function fingerprints(paths) {
  const result = new Map();
  for (const path of paths) {
    if (!await exists(path)) { result.set(path, null); continue; }
    const info = await stat(path);
    result.set(path, `${info.mode & 0o777}:${sha(await readFile(path))}`);
  }
  return result;
}
async function assertUnchanged(before, what) {
  const after = await fingerprints([...before.keys()]);
  if ([...before].some(([path, hash]) => after.get(path) !== hash)) throw new Error(`${what} изменились во время обновления. Автоматического восстановления поверх чужих изменений не выполнялось.`);
}
async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

async function acquireLock(path) {
  try { const handle = await open(path, 'wx', 0o600); await handle.writeFile(String(process.pid)); await handle.close(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(path, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`Проверьте файл блокировки: ${path}`);
    try { process.kill(pid, 0); } catch (e) {
      if (e.code === 'ESRCH') { await rm(path); return acquireLock(path); }
      throw e;
    }
    throw new Error(`Этот профиль уже обновляет процесс ${pid}.`);
  }
}

function run(command, args, { cwd = root, env = process.env, timeout = 180000, log } = {}) {
  return new Promise((resolveRun, reject) => {
    if (stop.signal.aborted) return reject(new Error('Обновление отменено.'));
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const output = []; let size = 0, ended = false, failure, forceTimer;
    const sendSignal = signal => { try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); } catch {} };
    const kill = () => { sendSignal('SIGTERM'); forceTimer ??= setTimeout(() => sendSignal('SIGKILL'), 3000); };
    const cancel = () => { failure = new Error('Обновление отменено.'); kill(); };
    const timer = setTimeout(() => { failure = new Error('Команда превысила время ожидания.'); kill(); }, timeout);
    stop.signal.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', data => { size += data.length; if (size < 4 * 1024 * 1024) output.push(data); log?.write(data); });
    child.stderr.on('data', data => log?.write(data));
    const finish = (error, code) => {
      if (ended) return; ended = true; clearTimeout(timer); clearTimeout(forceTimer); stop.signal.removeEventListener('abort', cancel);
      if (error || failure || code !== 0) reject(failure ?? new Error(error?.code === 'ENOENT' ? `Команда не найдена: ${command}` : `Команда завершилась с ошибкой${code == null ? '' : ` (${code})`}.`));
      else resolveRun(Buffer.concat(output).toString('utf8').trim());
    };
    child.once('error', error => finish(error)); child.once('close', code => finish(null, code));
  });
}

async function main() {
  const args = options(process.argv.slice(2));
  if (args.help) { console.log(help); return; }
  if (!semver.satisfies(process.versions.node, '>=24 <25')) throw new Error('Запустите команду с Node.js 24.');
  const target = await targetFor(args), profileDir = join(target.dshHome, 'profiles', target.profile);
  if (!await exists(join(profileDir, 'package.json'))) throw new Error('Профиль не существует. Команда не создаёт и не сбрасывает профили DSH.');
  const currentPackageFile = join(profileDir, 'node_modules', packageName, 'package.json');
  if (!await exists(currentPackageFile)) throw new Error('В выбранном профиле Vishvakarma ещё не установлен. Выполните первую установку по README.');
  const current = await json(currentPackageFile), source = await json(join(root, 'package.json'));
  if (current.name !== packageName || source.name !== packageName || !semver.valid(source.version) || !semver.valid(current.version)) throw new Error('Неверный пакет или версия Vishvakarma.');
  const cache = join(homedir(), process.platform === 'darwin' ? 'Library/Caches/Vishvakarma' : '.cache/vishvakarma', 'plugin-updates');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const key = sha(`${target.dshHome}\0${target.profile}`).slice(0, 16), lockPath = join(cache, key + '.lock');
  await acquireLock(lockPath);
  let stage, log, logHandle, logPath, preserved, installing = false;
  try {
    const env = { ...process.env, DSH_HOME: target.dshHome };
    console.log(`Профиль: ${target.profile}\nDSH_HOME: ${target.dshHome}\nУстановлено: ${current.version}`);
    logPath = join(cache, `${key}-${Date.now()}.log`);
    logHandle = await open(logPath, 'wx', 0o600);
    log = logHandle.createWriteStream({ autoClose: true });
    log.on('error', () => stop.abort());
    const liveContext = args['context-file'] ? await json(args['context-file']) : null;
    const dshVersion = liveContext?.dshVersion ?? await run(target.dsh, ['--version'], { env, timeout: 15000, log });
    if (!semver.valid(dshVersion)) throw new Error('CLI не вернул версию DSH. Проверьте --dsh.');
    for (const [name, range] of Object.entries(source.peerDependencies ?? {})) {
      if (name.startsWith('@deepseek-ai/dsh-') && !semver.satisfies(dshVersion, range)) throw new Error(`DSH ${dshVersion} несовместим: ${name} требует ${range}. Установка не начата.`);
    }
    const patches = [join(profileDir, 'cordis.patch.yml'), join(target.dshHome, 'cordis.patch.yml')];
    const patchState = await fingerprints(patches);
    const config = liveContext ?? await pluginConfig(patches);
    await assertUnchanged(patchState, 'Patch-настройки');
    stage = await mkdtemp(join(tmpdir(), 'vishvakarma-update-'));
    const fingerprint = await sourceFingerprint(root);
    if (args['expected-fingerprint'] && args['expected-fingerprint'] !== fingerprint) throw new Error('Исходники изменились после проверки. Нажмите «Проверить обновление» ещё раз.');
    for (const path of inputs) { await mkdir(dirname(join(stage, path)), { recursive: true }); await cp(join(root, path), join(stage, path), { recursive: true }); }
    if (fingerprint !== await sourceFingerprint(root)) throw new Error('Исходники изменились при копировании. Повторите команду после сохранения файлов.');
    await symlink(join(root, 'node_modules'), join(stage, 'node_modules'), 'dir');

    // Derive the check from the copied client/contracts, not a second version matrix.
    const provenance = await json(join(stage, 'contracts/source.json'));
    const modules = Object.keys(provenance.files);
    const compatibilitySource = `export { serverInfo, originOf, defaultCredentialsFile } from './src/connection.ts';\n` +
      modules.map((file, i) => `import * as c${i} from ${JSON.stringify('./contracts/' + file)};`).join('\n') +
      `\nexport const capabilities = [${modules.map((_, i) => `c${i}`).join(',')}].flatMap(m => Object.entries(m).filter(([k,v]) => (k === 'CAPABILITY' || k.endsWith('_CAPABILITY')) && typeof v === 'string').map(([,v]) => v));`;
    await build({ stdin: { contents: compatibilitySource, resolveDir: stage }, outfile: join(stage, 'compatibility.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent' });
    const compatibility = await import(pathToFileURL(join(stage, 'compatibility.mjs')).href);
    const origin = compatibility.originOf(config.serverUrl ?? 'http://127.0.0.1:3000');
    const credentialsFile = config.credentialsFile ?? compatibility.defaultCredentialsFile;
    if (typeof credentialsFile !== 'string' || !isAbsolute(credentialsFile)) throw new Error('credentialsFile в настройках должен быть абсолютным путём.');
    preserved = await fingerprints([...patches, credentialsFile, join(target.dshHome, 'settings.yaml'), join(profileDir, 'settings.yaml')]);
    async function compatibleServer() {
      const info = await compatibility.serverInfo(origin, AbortSignal.any([stop.signal, AbortSignal.timeout(10000)]));
      const missing = [...new Set(compatibility.capabilities)].filter(value => !info.capabilities.includes(value));
      if (missing.length) throw new Error(`Сначала обновите сервер ${info.serverVersion}: отсутствуют возможности ${missing.join(', ')}. Установка не начата.`);
      return info;
    }
    const info = await compatibleServer();
    console.log(`Совместимость: DSH ${dshVersion}, сервер ${info.serverVersion} (${origin}) — OK.`);
    const candidate = { protocol: 1, profile: target.profile, dshHome: target.dshHome, sourceVersion: source.version, sourceFingerprint: fingerprint, previousVersion: current.version, dshVersion, serverVersion: info.serverVersion, apiVersion: info.apiVersion, installationId: info.installationId, origin, capabilities: [...new Set(compatibility.capabilities)], logPath };
    if (args.check) {
      if (args['result-file']) await atomicJson(args['result-file'], candidate);
      console.log('Проверка завершена. Профиль и сохранённый выбор не изменены.'); return;
    }

    // Prerelease inputs keep their label; stable inputs produce a development
    // build of the next patch so they never compare lower than the stable input.
    const base = semver.prerelease(source.version) ? source.version : `${semver.inc(source.version, 'patch')}-local`;
    const version = `${base}${semver.prerelease(source.version) ? '.local' : ''}.${Date.now()}.${process.pid}`;
    if (!semver.gt(version, current.version)) throw new Error(`Исходники ${source.version} старее установленного пакета ${current.version}. Обновите checkout; откат автоматически не выполняется.`);
    await writeFile(join(stage, 'package.json'), JSON.stringify({ ...source, version }, null, 2) + '\n');
    const pnpmEntry = process.env.npm_execpath;
    const pnpm = pnpmEntry && /pnpm/.test(pnpmEntry) ? [process.execPath, [pnpmEntry]] : ['pnpm', []];
    console.log(`Сборка ${version} во временной папке…`);
    await run(pnpm[0], [...pnpm[1], 'build'], { cwd: stage, env, log });
    await atomicJson(join(stage, 'dist/build-info.json'), { sourceVersion: source.version, sourceFingerprint: fingerprint });
    await run(pnpm[0], [...pnpm[1], 'pack', '--pack-destination', cache], { cwd: stage, env, log });
    const archive = join(cache, `vishkarman-plugin-${version}.tgz`);
    if (!await exists(archive)) throw new Error('Сборка не создала ожидаемый архив.');
    if (fingerprint !== await sourceFingerprint(root)) throw new Error('Исходники изменились во время сборки. Установка не начата; повторите команду после сохранения файлов.');
    if ((await compatibleServer()).installationId !== info.installationId) throw new Error('Установка сервера изменилась во время сборки. Подключение не перенастраивалось; повторите проверку.');
    await assertUnchanged(preserved, 'Настройки или credentials');
    if ((await json(currentPackageFile)).version !== current.version) throw new Error('Другой процесс уже обновил плагин. Повторите команду.');
    if (args.prepare) {
      const fileHashes = {};
      for (const file of ['dist/host.js', 'dist/client.js', 'dist/connect.js', 'dist/build-info.json', 'cordis.patch.yml']) fileHashes[file] = sha(await readFile(join(stage, file)));
      await atomicJson(args['result-file'], { ...candidate, version, archive, archiveHash: sha(await readFile(archive)), fileHashes, preserved: [...preserved] });
      console.log(`Подготовлено: ${version}. Установку выполнит менеджер текущего DSH.`);
      return;
    }
    console.log(`Установка через штатный CLI DSH…`);
    installing = true;
    await run(target.dsh, ['plugin', '--profile', target.profile, 'add', archive], { cwd: root, env, log });
    await assertUnchanged(preserved, 'Настройки или credentials');
    const installedDir = dirname(currentPackageFile), installed = await json(currentPackageFile);
    if (installed.version !== version) throw new Error('Установщик завершился, но версия пакета не совпадает. Проверьте профиль DSH.');
    for (const file of ['dist/host.js', 'dist/client.js', 'dist/connect.js', 'dist/build-info.json', 'cordis.patch.yml']) {
      if (sha(await readFile(join(installedDir, file))) !== sha(await readFile(join(stage, file)))) throw new Error(`Установленный файл не совпадает со сборкой: ${file}`);
    }
    const manifest = await json(join(profileDir, 'package.json'));
    const enabled = manifest.dsh?.profile?.bundles?.includes(packageName) === true;
    await atomicJson(settingsFile, target);
    await atomicJson(join(cache, key + '.json'), { ...target, sourceVersion: source.version, sourceFingerprint: fingerprint, previousVersion: current.version, version, archive, serverVersion: info.serverVersion, dshVersion, installedAt: new Date().toISOString() });
    console.log(`Установлено: ${version}\nАрхив: ${archive}\nНастройки и credentials не изменились. Профиль запомнен: далее pnpm update:dsh.`);
    console.log(enabled ? 'Перезапустите выбранный профиль DSH. В Plugins → Vishvakarma проверьте новую версию и статус Running для включённого компонента. Проверена установка файлов, запуск компонента не проверялся.' : 'Пакет установлен; bundle остаётся выключенным. Проверьте Plugins → Vishvakarma и перезапустите выбранный профиль при необходимости.');
  } catch (error) {
    if (installing && preserved) await assertUnchanged(preserved, 'Настройки или credentials');
    throw error;
  } finally {
    try {
      if (log) { log.end(); await finished(log); }
    } finally {
      if (logHandle && logHandle.fd >= 0) await logHandle.close();
      if (logPath) console.log(`Лог команды: ${logPath}`);
      if (stage) await rm(stage, { recursive: true, force: true });
      await rm(lockPath, { force: true });
    }
  }
}

try { await main(); }
catch (error) { console.error(`Обновление не завершено: ${error instanceof Error ? error.message : 'неизвестная ошибка'}`); process.exitCode = 1; }
