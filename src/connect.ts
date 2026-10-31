#!/usr/bin/env node
import { mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultCredentialsFile, originOf, privateJson, currentUser, serverInfo, type Credentials } from './connection.js';

const [url, tokenFile, outputFile = defaultCredentialsFile] = process.argv.slice(2);
try {
  if (!url || !tokenFile) throw new Error('Использование: vishvakarma-connect <server-origin> <приватный-json-токена> [credentials-file]');
  const origin = originOf(url), info = await serverInfo(origin);
  const issued = await privateJson(resolve(tokenFile)) as Credentials;
  if (issued.installationId !== info.installationId || !/^[A-Za-z0-9_-]{43}$/.test(issued.token)) throw new Error('Токен принадлежит другой установке или некорректен.');
  await currentUser(origin, issued.token);
  const file = resolve(outputFile), temporary = file + '.' + randomUUID();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(temporary, JSON.stringify({ origin, installationId: info.installationId, tokenId: issued.tokenId, token: issued.token }) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, file); await chmod(file, 0o600);
  console.log('Подключено: ' + origin + '\nФайл подключения: ' + file + '\nСекрет сохранён только в приватном файле.');
} catch (error) { console.error(error instanceof Error ? error.message : 'Подключение не выполнено.'); process.exitCode = 1; }
