import { zipSync, strToU8 } from 'fflate';

import type { BugReportFile } from './types';

export function buildBugReportZip(files: BugReportFile[]): Uint8Array {
  const zipData: Record<string, Uint8Array> = {};
  for (const file of files) {
    zipData[file.name] = strToU8(file.content);
  }
  return zipSync(zipData, { level: 9 });
}
