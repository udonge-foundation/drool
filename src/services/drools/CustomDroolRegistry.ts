import os from 'os';
import path from 'path';

import { DroolStorageService } from '@/services/drools/DroolStorageService';

const PERSONAL_DROOL_DIR = path.join(os.homedir(), '.industry/drools');

let singletonService: DroolStorageService | null = null;

/**
 * Get singleton DroolStorageService instance.
 * For backward compatibility, this is used where DroolLoader was previously used.
 */
export function getDroolLoaderSingleton(): DroolStorageService {
  if (!singletonService) {
    singletonService = new DroolStorageService();
  }
  return singletonService;
}

export function getCustomDroolPaths(): {
  project: string;
  personal: string;
} {
  return {
    project: path.resolve(process.cwd(), '.industry/drools'),
    personal: PERSONAL_DROOL_DIR,
  };
}
