import { cp, readFile, writeFile } from 'node:fs/promises';
import { context } from 'esbuild';

// /judge is drawn by React. A reader without JavaScript (an AI judge fetching the URL) must still get the content,
// so judge.html carries the whole judge brief as static text inside #root. JUDGING.md stays the single source.
function judgeHtml(index, brief) {
  const text = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const title = '4lpha NEAR: judge guide';
  const about = 'Judge guide for 4lpha NEAR: reproduce without funds, hosted simulation, mainnet evidence, security attack proof and known limits.';
  const fallback = `
      <p>This is the judge guide for 4lpha NEAR. The visual layout needs JavaScript; the full content follows as plain Markdown, also served at <a href="/judge.md">/judge.md</a>. Source: <a href="https://github.com/4lphaAI/4lpha-NEAR">github.com/4lphaAI/4lpha-NEAR</a>.</p>
      <pre>${text(brief)}</pre>
    `;
  const edits = [
    [/<title>[^<]*<\/title>/, `<title>${title}</title>`],
    [/(<meta (?:name|property)="(?:og:|twitter:)?title" content=")[^"]*"/g, `$1${title}"`],
    [/(<meta (?:name|property)="(?:og:|twitter:)?description" content=")[^"]*"/g, `$1${about}"`],
    [/<!--static-->[\s\S]*<!--\/static-->/, () => fallback],
  ];
  return edits.reduce((html, [from, to]) => {
    if (!html.match(from)) throw new Error(`build-ui: web/index.html no longer matches ${from}`);
    return html.replace(from, to);
  }, index);
}

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
await cp('JUDGING.md', 'dist/ui/judge.md');
await writeFile('dist/ui/judge.html', judgeHtml(await readFile('web/index.html', 'utf8'), await readFile('JUDGING.md', 'utf8')));
await cp('web/app/icon.png', 'dist/ui/icon.png');
await cp('web/app/apple-icon.png', 'dist/ui/apple-icon.png');

if (process.argv.includes('--serve')) {
  await ctx.serve({ host: '127.0.0.1', port: 4174, servedir: 'dist/ui', fallback: 'dist/ui/index.html' });
  console.log('UI preview: http://127.0.0.1:4174');
} else {
  await ctx.dispose();
}
