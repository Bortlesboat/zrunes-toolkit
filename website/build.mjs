import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
await mkdir(path('./dist/'), { recursive: true });
await build({
  absWorkingDir: path('./'),
  entryPoints: [path('./app.mjs')],
  outfile: path('./dist/app.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  legalComments: 'eof',
  inject: [path('./buffer.mjs')],
  alias: { 'node:crypto': path('./crypto.mjs') },
});
await Promise.all([
  ...['index.html', 'styles.css', 'favicon.svg'].map((file) => cp(path(`./${file}`), path(`./dist/${file}`))),
  cp(path('./fonts/'), path('./dist/fonts/'), { recursive: true }),
]);
const notices = await Promise.all([
  ['ZRunes Toolkit', '../LICENSE'],
  ['Protocol and evidence attribution', '../NOTICE.md'],
  ['@noble/hashes', './node_modules/@noble/hashes/LICENSE'],
  ['buffer', './node_modules/buffer/LICENSE'],
  ['base64-js', './node_modules/base64-js/LICENSE'],
  ['ieee754', './node_modules/ieee754/LICENSE'],
  ['Barlow Semi Condensed', './fonts/barlow-OFL.txt'],
  ['IBM Plex Sans', './fonts/ibm-plex-OFL.txt'],
].map(async ([name, file]) => `${name}\n${'='.repeat(name.length)}\n\n${await readFile(path(file), 'utf8')}`));
await writeFile(path('./dist/licenses.txt'), notices.join('\n\n'));
console.log('Built static demo in website/dist/');
