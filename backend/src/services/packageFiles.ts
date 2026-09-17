import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { DownloadTask } from '../types/index.js';

export function localPackagePath(task: DownloadTask): string | undefined {
  if (!task.filePath) return undefined;
  const base = path.resolve(config.dataDir, 'packages');
  const resolved = path.resolve(task.filePath);
  if (!resolved.startsWith(base + path.sep))
    throw new Error('Invalid package path');
  return resolved;
}

export function hasPackage(task: DownloadTask): boolean {
  const local = localPackagePath(task);
  return !!task.remote || (!!local && fs.existsSync(local));
}

export function packageSize(task: DownloadTask): number {
  if (task.remote) return task.remote.size;
  const local = localPackagePath(task);
  return local ? fs.statSync(local).size : 0;
}

export function packageFilename(task: DownloadTask): string {
  return (
    `${task.software.name}_${task.software.version}`
      .replace(/[^\x20-\x7E]|["\\/]/g, '_')
      .slice(0, 190) + '.ipa'
  );
}
