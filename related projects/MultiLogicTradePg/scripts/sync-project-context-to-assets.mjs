/**
 * Copies living project context docs into Angular assets for the in-app Help panel.
 * Run before ng serve / ng build (also hooked from web/package.json).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const assetsDir = path.join(root, 'web', 'src', 'assets', 'project-context');

const files = [
  'docs/PROJECT_CONTEXT.md',
  'docs/LOCAL_SETUP.md',
  'docs/USER_INSTRUCTIONS.md',
];

fs.mkdirSync(assetsDir, { recursive: true });

for (const rel of files) {
  const src = path.join(root, rel);
  const dest = path.join(assetsDir, path.basename(rel));
  if (!fs.existsSync(src)) {
    console.warn(`sync-project-context: skip missing ${rel}`);
    continue;
  }
  fs.copyFileSync(src, dest);
  console.log(`sync-project-context: ${rel} → web/src/assets/project-context/${path.basename(rel)}`);
}

console.log('sync-project-context: OK');
