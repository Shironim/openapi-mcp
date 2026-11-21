import { opendirSync } from 'node:fs';
import { join } from 'node:path';

const ignored = new Set(['.git', 'node_modules']);
const specNames = new Set(['openapi.yml', 'openapi.yaml', 'openapi.json']);

/** List conventional entry filenames without loading or resolving their contents. */
export function listWorkspaceSpecs(root: string): string[] {
  const directories = [''];
  const paths: string[] = [];
  let visited = 0;
  while (directories.length) {
    const relative = directories.pop()!;
    const dir = opendirSync(join(root, relative));
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (++visited > 250_000) throw new Error('CATALOG_LIMIT: Select a narrower workspace root or pass spec_path directly.');
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory() && !ignored.has(entry.name)) directories.push(path);
        if (entry.isFile() && specNames.has(entry.name)) paths.push(path);
      }
    } finally {
      dir.closeSync();
    }
  }
  return paths.sort();
}
