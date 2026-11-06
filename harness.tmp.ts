import { registerImportTools } from './src/import-tools.ts';
let tool: any; let operation: any;
const ctx: any = { tools: { register: (value: any) => { tool = value; } } };
const connection: any = {
  adapterProject: async () => ({ revisionId: '11111111-1111-4111-8111-111111111111', files: [{ path: 'index.html', sha256: 'old' }] }),
  adapterChange: async (_p: string, _b: string, op: any) => { operation = op; return { saved: true, revisionId: '22222222-2222-4222-8222-222222222222' }; },
};
registerImportTools(ctx, connection, '/tmp/vk-import-test/credentials.json');
const result = await tool.execute({ projectId: 'proj', baseRevisionId: '11111111-1111-4111-8111-111111111111', files: [{ sourcePath: 'build/index.html', targetPath: 'index.html' }] }, { signal: new AbortController().signal });
console.log('files', JSON.stringify(operation.files));
console.log('result', JSON.stringify(result));
