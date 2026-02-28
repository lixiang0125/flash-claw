import { build } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const rootPath = path.join(projectRoot, 'src/web');
const outDir = path.join(projectRoot, 'dist');

console.log('Root:', rootPath);
console.log('Out:', outDir);

await build({
  root: rootPath,
  build: {
    outDir,
    emptyOutDir: true,
  },
});
