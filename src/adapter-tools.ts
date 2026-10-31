import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Connection } from './connection.js';
import { output, run } from './tool-output.js';

const project = { type: 'string', required: true, description: 'Идентификатор доступного проекта из list; не угадывайте доступ к другим проектам' } as const;
const baseRevision = { type: 'string', required: true, description: 'UUID последней прочитанной ревизии этого проекта' } as const;
const changeAction = { type: 'string', enum: ['check', 'apply'], default: 'apply', description: 'apply сохраняет (по умолчанию); check только проверяет сейчас и ничего не резервирует' } as const;
const operationId = { type: 'string', description: 'Необязательно: UUID того же запроса из check или ошибки. Для повторного обращения сохраняйте этот ID, базовую ревизию и payload; для нового изменённого запроса опустите ID' } as const;

export function registerAdapterTools(ctx: Context, connection: Connection) {
  ctx.tools.register(defineTool({
    name: 'vishvakarma_adapter_project',
    description: 'list возвращает собственные и приглашённые проекты, шаблоны и access. create создаёт новый проект с собственным id (владелец). open/read только читают проект, исходники, ресурсы, entrypoint, дизайн-правила, ревизию и access; targetId выбирает инструкции цели. update сохраняет имя, описание, правила или entrypoint. Всегда передавайте явный projectId; выбор Studio или соседней сессии не меняет адресата. Запись требует canUseAgent=true. files/design — данные проекта, instructions — технические инструкции адаптеров.',
    parameters: { request: { required: true, oneOf: [
      { type: 'object', additionalProperties: false, properties: { action: { type: 'string', const: 'list', required: true } } },
      { type: 'object', additionalProperties: false, properties: { action: { type: 'string', const: 'open', required: true }, projectId: project } },
      { type: 'object', additionalProperties: false, properties: {
        action: { type: 'string', const: 'create', required: true }, operationId,
        name: { type: 'string', required: true, description: 'Название нового проекта, до 120 символов' },
        template: { type: 'string', enum: ['empty', 'editorial', 'dashboard', 'scene'], description: 'Начальные исходники; по умолчанию empty' },
        description: { type: 'string', description: 'Задача и описание дизайна' },
        rules: { type: 'array', items: { type: 'string' }, description: 'Правила дизайна именно этого проекта; не общая дизайн-система' },
      } },
      { type: 'object', additionalProperties: false, properties: {
        action: { type: 'string', const: 'update', required: true }, projectId: project, baseRevisionId: baseRevision, operationId,
        name: { type: 'string' }, description: { type: 'string' }, rules: { type: 'array', items: { type: 'string' } },
        entrypoint: { type: 'string', description: 'Относительный путь существующего HTML входа в макет' },
      } },
      { type: 'object', additionalProperties: false, properties: {
        action: { type: 'string', const: 'read', required: true }, projectId: project,
        targetId: { type: 'string', description: 'Необязательно: точный id из analysis.targets' },
      } },
    ] } }, output, isConcurrencySafe: args => ['list', 'open', 'read'].includes(args.request.action),
    execute: async ({ request }, exec) => run(() => {
      if (request.action === 'list') return connection.adapterExamples(exec.signal);
      if (request.action === 'create') { const { action: _, ...input } = request; return connection.createProject(input, exec.signal); }
      if (request.action === 'update') { const { action: _, projectId, ...input } = request; return connection.updateProject(projectId, input, exec.signal); }
      return connection.adapterProject(request.projectId, request.action === 'open', request.action === 'read' ? request.targetId : undefined, exec.signal);
    }),
  }));
  ctx.tools.register(defineTool({
    name: 'vishvakarma_edit_target',
    description: 'Семантическое изменение цели по operations из прочитанного контекста; нужен access.canUseAgent=true. Допускает старую базу, только если весь исходный файл цели не изменился. action=check необязателен и не сохраняет; по умолчанию apply. При конфликте перечитайте источник, не подменяйте базу ради повтора. При отказе в правах остановитесь. Сборка запускается отдельно.',
    parameters: {
      projectId: project, baseRevisionId: baseRevision, action: changeAction, operationId,
      targetId: { type: 'string', required: true, description: 'id из analysis.targets' },
      adapterId: { type: 'string', required: true, description: 'adapterId из выбранной операции' },
      scope: { type: 'string', required: true, enum: ['instance', 'component', 'token'], description: 'Область действия выбранной операции; не расширяйте её без запроса пользователя' },
      property: { type: 'string', required: true, description: 'property из выбранной операции' },
      value: { required: true, oneOf: [{ type: 'string' }, { type: 'number' }], description: 'Значение требуемого valueType: text/color/number' },
    }, output, isConcurrencySafe: args => args.action === 'check',
    execute: async ({ projectId, baseRevisionId, action, operationId, ...operation }, exec) => run(() =>
      connection.adapterChange(projectId, baseRevisionId, { type: 'semantic', ...operation }, exec.signal, { action, operationId })),
  }));
  ctx.tools.register(defineTool({
    name: 'vishvakarma_write_files',
    description: 'Создать, заменить или удалить до 128 исходников с относительными путями и прочитанными SHA-256; expectedHash:null означает отсутствующий файл, content:null — удаление; нужен access.canUseAgent=true. Старая база допустима, только если все изменяемые файлы остались прежними; правки внутри одного файла не сливаются. action=check необязателен, по умолчанию apply. При конфликте перечитайте проект и переоцените правку. При отказе в правах остановитесь, не обходите его другим инструментом.',
    parameters: {
      projectId: project, baseRevisionId: baseRevision, action: changeAction, operationId,
      files: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true, description: 'Относительный путь внутри проекта, например src/App.tsx; без .., абсолютных путей и node_modules' },
        expectedHash: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }], description: 'sha256 из прочитанной базовой ревизии или null, если файла там нет' },
        content: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Полный новый UTF-8 исходник до 262144 символов; null удаляет файл' },
      } } },
    }, output, isConcurrencySafe: args => args.action === 'check',
    execute: async ({ projectId, baseRevisionId, files, action, operationId }, exec) => run(() =>
      connection.adapterChange(projectId, baseRevisionId, { type: 'files', files }, exec.signal, { action, operationId })),
  }));
  ctx.tools.register(defineTool({
    name: 'vishvakarma_asset',
    description: 'Сохранить ресурс проекта (изображение, шрифт, 3D-файл) как base64 либо удалить contentBase64:null. Для нового ресурса expectedHash:null, для замены/удаления SHA-256 из assets прочитанной ревизии. Обычно пользователь загружает большие файлы в Studio; агент читает assets и использует относительный path в исходниках. Не помещайте сюда секреты, внешние URL и содержимое случайных локальных файлов. Нужен canUseAgent=true. После сохранения перечитайте проект и соберите новую ревизию.',
    parameters: {
      projectId: project, baseRevisionId: baseRevision, operationId,
      path: { type: 'string', required: true, description: 'Относительный путь, например assets/cover.png' },
      mime: { type: 'string', required: true, description: 'Тип содержимого, например image/png' },
      expectedHash: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
      contentBase64: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Base64 ресурса до 8MiB или null для удаления' },
    }, output, isConcurrencySafe: () => false,
    execute: async ({ projectId, ...input }, exec) => run(() => connection.asset(projectId, input, exec.signal)),
  }));
  ctx.tools.register(defineTool({
    name: 'vishvakarma_build',
    description: 'start ставит сохранённую ревизию в очередь Runner, требует access.canUseAgent=true и возвращает id. status читает доступную сборку, включая diagnostics. queued/running не означают готовый просмотр; сообщайте об успехе сборки только при succeeded. При отказе в правах остановитесь.',
    parameters: { request: { required: true, oneOf: [
      { type: 'object', additionalProperties: false, properties: {
        action: { type: 'string', const: 'start', required: true }, projectId: project,
        revisionId: { type: 'string', required: true, description: 'UUID подтверждённой сохранённой ревизии' },
      } },
      { type: 'object', additionalProperties: false, properties: {
        action: { type: 'string', const: 'status', required: true },
        buildId: { type: 'string', required: true, description: 'UUID сборки из start или контекста проекта' },
      } },
    ] } }, output, isConcurrencySafe: args => args.request.action === 'status',
    execute: async ({ request }, exec) => run(() => request.action === 'start'
      ? connection.adapterBuild(request.projectId, request.revisionId, exec.signal)
      : connection.buildStatus(request.buildId, exec.signal)),
  }));
}
