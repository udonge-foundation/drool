// eslint-disable-next-line industry/constants-file-organization -- PLT-76: migrated from file-level disable
import { getWorkosConfig } from './config';

// eslint-disable-next-line industry/constants-file-organization -- PLT-76: migrated from file-level disable
export function getWorkOSClientId(): string {
  return getWorkosConfig().clientId;
}
