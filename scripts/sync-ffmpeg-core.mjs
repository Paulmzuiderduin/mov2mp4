import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const sourceDir = resolve(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'umd');
const targetDir = resolve(root, 'public', 'ffmpeg');

const files = ['ffmpeg-core.js', 'ffmpeg-core.wasm'];

await mkdir(targetDir, { recursive: true });

await Promise.all(
  files.map((name) => copyFile(resolve(sourceDir, name), resolve(targetDir, name)))
);

console.log(`Synced ffmpeg core assets to ${targetDir}`);

