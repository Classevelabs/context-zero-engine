import { cp, rm } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'src', 'adapters', 'py');
const destination = resolve(root, 'dist', 'adapters', 'py');

await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true, force: true });
