import { build } from 'esbuild';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Only a development build needs Node/npm. The application serves these checked-in
// browser modules locally; it never loads graph code from a runtime CDN.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'static', 'vendor');
await mkdir(vendor, { recursive: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: [{ in: 'node_modules/@falkordb/canvas/dist/index.js', out: 'falkordb-canvas' }],
  outdir: 'static/vendor',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  legalComments: 'linked',
  chunkNames: 'chunks/[name]-[hash]',
  metafile: true,
  banner: { js: '/* FalkorDB Canvas: local build. See FALKORDB-CANVAS-NOTICES.txt for licenses. */' },
});

const packageFolders = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const parts = input.replaceAll('\\', '/').split('/');
  const marker = parts.lastIndexOf('node_modules');
  if (marker < 0) continue;
  const end = marker + (parts[marker + 1].startsWith('@') ? 3 : 2);
  packageFolders.add(parts.slice(0, end).join('/'));
}

const notices = [
  'Relay — locally bundled FalkorDB Canvas',
  '',
  'Primary component: @falkordb/canvas 0.3.3',
  'Official source: https://github.com/FalkorDB/falkordb-ui/tree/main/web-components/canvas',
  'Documentation: https://docs.falkordb.com/browser/canvas',
  'Registry source: https://registry.npmjs.org/@falkordb/canvas/-/canvas-0.3.3.tgz',
  '',
  'Build: npm ci && npm run build (esbuild 0.28.2).',
  'Dependencies are pinned transitively by package-lock.json.',
  'The 2D component is loaded locally. The optional 3D renderer is a separate lazy chunk.',
  'The application requires no npm runtime or CDN connection.',
  '',
  'This file contains the license notices from every package included in the browser bundle.',
  '',
];

const packages = [];
for (const folder of [...packageFolders].sort()) {
  const directory = path.resolve(root, folder);
  const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const contents = await readdir(directory);
  const names = contents.filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
  const standaloneLicense = names.length > 0;
  // bezier-js publishes its MIT declaration in README.md and its source header,
  // but neither its npm archive nor published source revision has a LICENSE file.
  // Preserve the upstream declaration verbatim instead of inventing a copyright.
  if (!names.length && metadata.name === 'bezier-js' && metadata.version === '6.1.4') {
    names.push('README.md');
  }
  if (!names.length) throw new Error(`Missing license notice for bundled package ${metadata.name}.`);
  notices.push('='.repeat(78), `${metadata.name} ${metadata.version}`, `Declared license: ${metadata.license ?? 'see text'}`, '');
  if (!standaloneLicense) notices.push(
    'Upstream publishes its license declaration in this README rather than a standalone LICENSE file.',
    'Author: Pomax. Published source revision: a41f3e08e9724c9973eca0eb5c1304120e72fc70.',
    'Source: https://github.com/Pomax/bezierjs/tree/a41f3e08e9724c9973eca0eb5c1304120e72fc70', '',
  );
  for (const name of names.sort()) {
    notices.push(`--- ${name} ---`, (await readFile(path.join(directory, name), 'utf8')).trim(), '');
  }
  packages.push({ name: metadata.name, version: metadata.version, license: metadata.license, files: names });
}

await writeFile(path.join(vendor, 'FALKORDB-CANVAS-NOTICES.txt'), notices.join('\n'));
await writeFile(path.join(vendor, 'falkordb-canvas-build.json'), JSON.stringify({
  component: '@falkordb/canvas',
  version: '0.3.3',
  bundler: 'esbuild@0.28.2',
  packages,
  outputs: Object.entries(result.metafile.outputs).map(([file, output]) => ({ file, bytes: output.bytes, imports: output.imports })),
}, null, 2) + '\n');

const outputs = Object.entries(result.metafile.outputs);
console.log(`Built ${outputs.length} local assets with ${packages.length} package license notices.`);
for (const [file, output] of outputs) console.log(`${file}: ${output.bytes.toLocaleString()} bytes`);
