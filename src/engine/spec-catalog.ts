import { opendirSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  'storage',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.idea',
  '.vscode',
  '.gradle',
  'tmp',
  '.tmp',
]);

const specNames = new Set(['openapi.yml', 'openapi.yaml', 'openapi.json']);
const SKIPPABLE_DIR_ERROR_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ELOOP']);
const MAX_SKIPPED_DIRS_SAMPLE = 25;

export interface WorkspaceSpecCatalog {
  specPaths: string[];
  skippedDirs: string[];
  skippedDirCount: number;
}

function isSkippableDirError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && SKIPPABLE_DIR_ERROR_CODES.has(code);
}

/**
 * Scan workspace for conventional OpenAPI entry filenames without loading or resolving contents.
 * Unreadable or transient directories (EACCES/EPERM/ENOENT/ENOTDIR/ELOOP) are skipped and reported
 * rather than aborting the entire catalog scan.
 */
export function scanWorkspaceSpecs(root: string): WorkspaceSpecCatalog {
  const directories = [''];
  const paths: string[] = [];
  const skippedDirs: string[] = [];
  let skippedDirCount = 0;
  let visited = 0;

  while (directories.length) {
    const relative = directories.pop()!;
    let dir;
    try {
      dir = opendirSync(join(root, relative));
    } catch (error) {
      if (relative !== '' && isSkippableDirError(error)) {
        skippedDirCount++;
        if (skippedDirs.length < MAX_SKIPPED_DIRS_SAMPLE) skippedDirs.push(relative);
        continue;
      }
      throw error;
    }

    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (++visited > 250_000) {
          throw new Error('CATALOG_LIMIT: Select a narrower workspace root or pass spec_path directly.');
        }
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory() && !DEFAULT_IGNORED_DIRS.has(entry.name)) directories.push(path);
        if (entry.isFile() && specNames.has(entry.name)) paths.push(path);
      }
    } catch (error) {
      if (relative !== '' && isSkippableDirError(error)) {
        skippedDirCount++;
        if (skippedDirs.length < MAX_SKIPPED_DIRS_SAMPLE) skippedDirs.push(relative);
      } else {
        throw error;
      }
    } finally {
      dir.closeSync();
    }
  }

  return {
    specPaths: paths.sort(),
    skippedDirs: skippedDirs.sort(),
    skippedDirCount,
  };
}

/** List conventional entry filenames without loading or resolving their contents. */
export function listWorkspaceSpecs(root: string): string[] {
  return scanWorkspaceSpecs(root).specPaths;
}
