import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const files = (await readdir('web/test')).filter(f => f.endsWith('.test.ts')).map(f => `web/test/${f}`);
await build({ entryPoints: files, bundle: true, format: 'esm', platform: 'node', tsconfig: 'web/tsconfig.json', outdir: 'dist/test-ui', outExtension: { '.js': '.mjs' }, logLevel: 'error' });
const r = spawnSync(process.execPath, ['--test', ...files.map(f => `dist/test-ui/${f.slice('web/test/'.length).replace(/\.ts$/, '.mjs')}`)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
