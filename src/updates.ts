import type { Context } from '@deepseek-ai/cordis';
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot';
import type { PluginManager } from '@deepseek-ai/dsh-plugin-manager';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import semver from 'semver';
import { z } from 'zod';
import { serverInfo, type Config } from './connection.js';
import { updateSettingsSchema, type UpdateNotice, type UpdateSettings, type UpdateStatus } from './update-contract.js';
import { sourceFingerprint } from '../scripts/source-fingerprint.mjs';

const packageName = '@vishkarman/plugin';
// Capture the loaded version once. Reading the replaced manifest later is not a runtime check.
const runningVersion: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const candidateSchema = z.object({
  protocol: z.literal(1), profile: z.string(), dshHome: z.string(), sourceVersion: z.string(), sourceFingerprint: z.string(),
  previousVersion: z.string(), dshVersion: z.string(), serverVersion: z.string(), apiVersion: z.string(),
  installationId: z.string(), origin: z.string(), capabilities: z.array(z.string()), logPath: z.string(),
  version: z.string().optional(), archive: z.string().optional(), archiveHash: z.string().optional(),
  fileHashes: z.record(z.string(), z.string()).optional(), preserved: z.array(z.tuple([z.string(), z.string().nullable()])).optional(),
}).strict();
type Candidate = z.infer<typeof candidateSchema>;
type Job = {
  pid: number; id: string; phase: UpdateStatus['phase']; message: string; logPath: string;
  candidate?: Candidate; restartRequired?: boolean;
};
const busy = (phase: string) => ['checking', 'building', 'installing'].includes(phase);
async function json(file: string) { return JSON.parse(await readFile(file, 'utf8')); }
async function optionalJson(file: string) { try { return await json(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } }
async function atomicJson(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } }
async function fingerprint(file: string) {
  try { return `${(await stat(file)).mode & 0o777}:${sha(await readFile(file))}`; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}

/** Local source preparation and current-profile installation have separate responsibilities. */
export class PluginUpdates {
  private readonly profile: ProfileContext | undefined;
  private readonly stateDir: string;
  private readonly stateFile: string;
  private readonly settingsFile: string;
  private readonly lockFile: string;
  private noticeCache?: { key: string; expires: number; result: Promise<UpdateNotice> };
  constructor(private readonly ctx: Context, private readonly config: Config) {
    this.profile = ctx.get('profileContext');
    const key = sha(this.profile?.dir ?? 'unavailable').slice(0, 16);
    this.stateDir = join(homedir(), process.platform === 'darwin' ? 'Library/Caches/Vishvakarma' : '.cache/vishvakarma', 'plugin-updates', key);
    this.stateFile = join(this.stateDir, 'state.json');
    this.lockFile = join(this.stateDir, 'operation.lock');
    this.settingsFile = this.profile ? join(this.profile.dir, 'vishvakarma-updates.json') : '';
  }
  private manager(): PluginManager | undefined { return this.ctx.get('pluginManager'); }
  private async settings(): Promise<UpdateSettings> {
    return updateSettingsSchema.parse(this.settingsFile && await optionalJson(this.settingsFile) || { development: false, directory: '' });
  }
  private packageFile() { return join(this.profile!.dir, 'node_modules', packageName, 'package.json'); }
  private async installedVersion() { return this.profile ? (await json(this.packageFile())).version as string : runningVersion; }
  async notice(): Promise<UpdateNotice> {
    try {
      const settings = await this.settings();
      if (!this.profile || !settings.development || !isAbsolute(settings.directory)) return 'unknown';
      const installed = await this.installedVersion(), key = settings.directory + '\0' + installed;
      if (this.noticeCache?.key === key && this.noticeCache.expires > Date.now()) return this.noticeCache.result;
      const result = (async (): Promise<UpdateNotice> => {
        const info = await optionalJson(join(dirname(this.packageFile()), 'dist/build-info.json'));
        if (!info?.sourceFingerprint) return 'unknown';
        const pkg = await json(join(settings.directory, 'package.json'));
        if (pkg.name !== packageName) return 'unknown';
        return await sourceFingerprint(settings.directory) === info.sourceFingerprint ? 'current' : 'changed';
      })().catch(() => 'unknown' as const);
      this.noticeCache = { key, expires: Date.now() + 30000, result };
      return result;
    } catch { return 'unknown'; }
  }
  private async state(): Promise<Job | null> {
    const state: Job | null = await optionalJson(this.stateFile);
    if (state && busy(state.phase) && !alive(state.pid)) {
      const verified = state.candidate?.fileHashes && await this.filesMatch(state.candidate);
      state.phase = verified ? 'done' : 'error';
      state.message = verified ? 'Пакет установлен. Проверьте статус Running в DSH.' : 'Обновление прервано закрытием DSH. Выполните проверку и повторите обновление.';
      state.restartRequired = verified && await this.installedVersion() !== runningVersion;
      await atomicJson(this.stateFile, state);
    }
    return state;
  }
  async status(): Promise<UpdateStatus> {
    const state = await this.state(), settings = await this.settings(), installedVersion = await this.installedVersion();
    const available = Boolean(this.profile && this.manager());
    const restartRequired = installedVersion !== runningVersion || Boolean(state?.restartRequired && state.candidate?.version !== runningVersion);
    return {
      available, profile: this.profile?.name ?? '', profileDirectory: this.profile?.dir ?? '', runningVersion, installedVersion,
      sourceVersion: state?.candidate?.sourceVersion ?? '', settings, phase: state?.phase ?? 'idle',
      message: !available ? 'Обновление доступно в профиле DSH с включённым менеджером плагинов.' : state?.message ?? (settings.development ? 'Нажмите «Проверить обновление», чтобы проверить исходники и совместимость.' : 'Выберите источник обновления в настройках.'),
      canUpdate: available && settings.development && state?.phase === 'ready' && !restartRequired,
      restartRequired, logPath: state?.logPath ?? '',
    };
  }
  private async lock(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    try { const handle = await open(this.lockFile, 'wx', 0o600); await handle.writeFile(String(process.pid)); await handle.close(); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(await readFile(this.lockFile, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1 || alive(pid)) throw new Error('Обновление этого профиля уже выполняется.');
      await rm(this.lockFile); return this.lock();
    }
  }
  async saveSettings(input: UpdateSettings): Promise<UpdateStatus> {
    if (!this.profile) throw new Error('Профиль DSH недоступен.');
    await this.lock();
    try {
      const settings = updateSettingsSchema.parse(input);
      settings.directory = settings.directory.trim();
      if (settings.development) settings.directory = await this.checkout(settings.directory);
      await atomicJson(this.settingsFile, settings);
      this.noticeCache = undefined;
      await rm(this.stateFile, { force: true });
    } finally { await rm(this.lockFile, { force: true }); }
    return this.status();
  }
  private async checkout(directory: string) {
    if (!isAbsolute(directory)) throw new Error('Укажите абсолютный путь к исходникам plugin.');
    const root = await realpath(directory), pkg = await json(join(root, 'package.json'));
    if (pkg.name !== packageName) throw new Error('В выбранной папке нет исходников @vishkarman/plugin.');
    await stat(join(root, 'scripts/update-dsh.mjs'));
    await stat(join(root, 'node_modules/esbuild'));
    return root;
  }
  async start(action: 'check' | 'install'): Promise<UpdateStatus> {
    if (!this.profile || !this.manager()) throw new Error('Менеджер плагинов DSH недоступен.');
    const settings = await this.settings();
    if (!settings.development) throw new Error('Готовые выпуски ещё не подключены. Для локальной сборки включите режим разработчика.');
    if (await this.installedVersion() !== runningVersion) throw new Error('Сначала перезапустите DSH, чтобы загрузить уже установленную версию.');
    await this.lock();
    try {
      const old = await this.state();
      if (action === 'install' && old?.phase !== 'ready') throw new Error('Сначала проверьте обновление.');
      const job: Job = { pid: process.pid, id: randomUUID(), phase: action === 'check' ? 'checking' : 'building', message: action === 'check' ? 'Проверяем исходники и совместимость…' : 'Собираем обновление…', logPath: '', candidate: old?.candidate };
      await atomicJson(this.stateFile, job);
      // The manager belongs to DSH, not this plugin. Do not cancel this promise on
      // plugin disposal: HMR may unload our UI while the manager finishes its work.
      void this.execute(action, settings, job).catch(() => {}).finally(() => rm(this.lockFile, { force: true }));
    } catch (e) { await rm(this.lockFile, { force: true }); throw e; }
    return this.status();
  }
  private async execute(action: 'check' | 'install', settings: UpdateSettings, job: Job) {
    try {
      const candidate = await this.prepare(settings, job, action === 'check');
      job.candidate = candidate; job.logPath = candidate.logPath;
      if (action === 'check') {
        const info = await optionalJson(join(dirname(this.packageFile()), 'dist/build-info.json'));
        const changed = info?.sourceFingerprint !== candidate.sourceFingerprint;
        job.phase = changed ? 'ready' : 'idle';
        job.message = changed ? 'Есть изменения в локальных исходниках. Совместимость проверена.' : 'Установлена сборка этих исходников. Обновление не требуется.';
      } else {
        await this.install(candidate, job);
      }
    } catch (e) {
      job.phase = 'error'; job.message = e instanceof Error ? e.message : 'Не удалось обновить плагин.';
    } finally { this.noticeCache = undefined; await atomicJson(this.stateFile, job); }
  }
  /** The development source builds a package; the installer below consumes a package. */
  private async prepare(settings: UpdateSettings, job: Job, check: boolean): Promise<Candidate> {
    const root = await this.checkout(settings.directory), profile = this.profile!;
    if (await realpath(join(profile.home, 'profiles', profile.name)) !== await realpath(profile.dir)) throw new Error('Расположение профиля отличается от стандартного DSH_HOME/profiles. Обновление не начато.');
    const resultFile = join(this.stateDir, `${job.id}-candidate.json`), contextFile = join(this.stateDir, `${job.id}-context.json`);
    const logPath = join(this.stateDir, `${job.id}.log`); job.logPath = logPath;
    await atomicJson(this.stateFile, job);
    const invocation = profile.packageManager ?? { command: 'pnpm', args: [], env: {} };
    const dshVersion = (await json(profile.installAnchor)).version;
    await atomicJson(contextFile, { dshVersion, serverUrl: this.config.serverUrl, credentialsFile: this.config.credentialsFile });
    const args = [...invocation.args, 'exec', 'node', join(root, 'scripts/update-dsh.mjs'), '--dsh-home', profile.home, '--profile', profile.name, '--context-file', contextFile, '--result-file', resultFile, check ? '--check' : '--prepare'];
    if (!check) args.push('--expected-fingerprint', job.candidate!.sourceFingerprint);
    const handle = await open(logPath, 'wx', 0o600);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(invocation.command, args, { cwd: root, env: { ...process.env, ...invocation.env, DSH_HOME: profile.home }, stdio: ['ignore', handle.fd, handle.fd], detached: process.platform !== 'win32' });
        let timedOut = false, force: NodeJS.Timeout | undefined;
        const signal = (name: NodeJS.Signals) => { try { process.platform === 'win32' ? child.kill(name) : process.kill(-child.pid!, name); } catch {} };
        const timer = setTimeout(() => { timedOut = true; signal('SIGTERM'); force = setTimeout(() => signal('SIGKILL'), 3000); }, 600000);
        child.once('error', error => { clearTimeout(timer); if (force) clearTimeout(force); reject(new Error(`Не удалось запустить сборку: ${error.message}`)); });
        child.once('close', code => { clearTimeout(timer); if (force) clearTimeout(force); code === 0 ? resolve() : reject(new Error(timedOut ? 'Сборка превысила время ожидания.' : 'Подготовка обновления не завершена. Подробности в логе.')); });
      });
      const candidate = candidateSchema.parse(await json(resultFile));
      if (candidate.profile !== profile.name || await realpath(candidate.dshHome) !== await realpath(profile.home)) throw new Error('Сборка подготовлена для другого профиля.');
      return candidate;
    } catch (e) {
      const diagnostic = (await readFile(logPath, 'utf8')).split('\n').findLast(line => line.startsWith('Обновление не завершено: '));
      if (diagnostic) throw new Error(diagnostic.slice('Обновление не завершено: '.length, 1000));
      throw e;
    } finally { await handle.close(); await rm(contextFile, { force: true }); await rm(resultFile, { force: true }); }
  }
  private async filesMatch(candidate: Candidate) {
    if (await this.installedVersion() !== candidate.version || !candidate.fileHashes) return false;
    for (const [file, hash] of Object.entries(candidate.fileHashes)) {
      if (!['dist/host.js', 'dist/client.js', 'dist/connect.js', 'dist/build-info.json', 'cordis.patch.yml'].includes(file)) return false;
      try { if (sha(await readFile(join(dirname(this.packageFile()), file))) !== hash) return false; } catch { return false; }
    }
    return Object.keys(candidate.fileHashes).length === 5;
  }
  private async install(candidate: Candidate, job: Job) {
    if (!candidate.archive || !candidate.version || !candidate.archiveHash || !candidate.preserved || !semver.gt(candidate.version, await this.installedVersion())) throw new Error('Сборка не содержит нового устанавливаемого пакета.');
    if (candidate.previousVersion !== await this.installedVersion()) throw new Error('Плагин уже изменён другим процессом. Повторите проверку.');
    if (sha(await readFile(candidate.archive)) !== candidate.archiveHash) throw new Error('Архив изменился после сборки. Повторите проверку.');
    const info = await serverInfo(candidate.origin, AbortSignal.timeout(10000));
    if (info.installationId !== candidate.installationId || info.apiVersion !== candidate.apiVersion || candidate.capabilities.some(c => !info.capabilities.includes(c))) throw new Error('Сервер изменился после сборки или несовместим. Повторите проверку.');
    const unchanged = async () => {
      for (const [file, hash] of candidate.preserved!) if (await fingerprint(file) !== hash) throw new Error('Настройки изменились во время обновления. Они не перезаписывались; проверьте результат.');
    };
    await unchanged();
    const manifest = await json(join(this.profile!.dir, 'package.json'));
    job.phase = 'installing'; job.message = 'Менеджер DSH устанавливает обновление…';
    await atomicJson(this.stateFile, job);
    const manager = this.manager();
    if (!manager) throw new Error('Менеджер плагинов DSH отключён.');
    const result = await manager.installBundle(candidate.archive, { enabled: manifest.dsh?.profile?.bundles?.includes(packageName) === true });
    if (result.packageResult?.logPath) job.logPath = result.packageResult.logPath;
    await unchanged();
    if (!['applied', 'restart-required'].includes(result.application)) throw new Error(`DSH не подтвердил применение обновления (${result.error?.code ?? result.application}). Подробности в логе или на странице Plugins.`);
    if (!await this.filesMatch(candidate)) throw new Error('Установленные файлы не совпали со сборкой. Проверьте Plugins перед повтором.');
    job.phase = 'done'; job.restartRequired = result.application === 'restart-required';
    job.message = job.restartRequired ? 'Обновление установлено. Перезапустите DSH.' : 'Обновление установлено и применено DSH.';
  }
}
