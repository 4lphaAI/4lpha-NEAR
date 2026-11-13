import { cp } from 'node:fs/promises';
import { context } from 'esbuild';

const ctx = await context({
  entryPoints: ['web/main.tsx'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  tsconfig: 'web/tsconfig.json',
  outdir: 'dist/ui',
  entryNames: '[name]',
  minify: true,
  sourcemap: false,
  alias: { '@rainbow-me/rainbowkit': './web/shims/rainbowkit.tsx' },
  define: {
    'process.env.NEXT_PUBLIC_AGENTIC_WALLET_ENABLED': '"false"',
    'process.env.NEXT_PUBLIC_AGENTIC_DCA_ENABLED': '"false"',
    'process.env.NEXT_PUBLIC_AGENTIC_MEME_ENABLED': '"false"',
    'process.env.NEXT_PUBLIC_AGENTIC_EARN_ENABLED': '"false"',
    'process.env.NODE_ENV': '"production"',
  },
  external: ['/fonts/*', '/pets/*', '/design/*'],
});
await ctx.rebuild();
await cp('web/index.html', 'dist/ui/index.html');
await cp('web/public', 'dist/ui', { recursive: true });
await cp('web/app/icon.png', 'dist/ui/icon.png');
await cp('web/app/apple-icon.png', 'dist/ui/apple-icon.png');

if (process.argv.includes('--serve')) {
  await ctx.serve({ host: '127.0.0.1', port: 4174, servedir: 'dist/ui', fallback: 'dist/ui/index.html' });
  console.log('UI preview: http://127.0.0.1:4174');
} else {
  await ctx.dispose();
}
