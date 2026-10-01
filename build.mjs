// Bundles the game into a single self-contained HTML file (dist/NeonCoast.html)
// that runs by double-clicking it on Windows (or any OS) - no server, no install.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const dev = process.argv.includes('--dev');
const root = path.dirname(new URL(import.meta.url).pathname);

const result = await esbuild.build({
  entryPoints: [path.join(root, 'src/main.js')],
  bundle: true,
  format: 'iife',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  target: 'es2020',
  write: false,
  legalComments: 'none',
  logLevel: 'warning',
});

const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const out = html.replace('<!--GAME_SCRIPT-->', () => `<script>\n${js}\n</script>`);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const file = path.join(root, 'dist/NeonCoast.html');
fs.writeFileSync(file, out);
console.log(`Built ${file} (${(out.length / 1024 / 1024).toFixed(2)} MB)`);
