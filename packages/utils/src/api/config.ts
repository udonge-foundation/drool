import { MetaError } from '@industry/logging/errors';

import { IndustryApiConfig } from './types';

let globalConfig: IndustryApiConfig | null = null;

function validateConfig(config: IndustryApiConfig): void {
  if (config.baseUrl !== undefined) {
    if (typeof config.baseUrl !== 'string') {
      throw new MetaError(
        'IndustryApiConfig.baseUrl must be a string or undefined',
        {
          url: config.baseUrl,
          type: typeof config.baseUrl,
        }
      );
    }

    if (config.baseUrl === '') {
      throw new MetaError(
        'IndustryApiConfig.baseUrl cannot be empty string. Use undefined for relative URLs.'
      );
    }

    if (config.baseUrl.endsWith('/')) {
      throw new MetaError(
        'IndustryApiConfig.baseUrl must not have trailing slash',
        {
          url: config.baseUrl,
          normalizedUrl: config.baseUrl.slice(0, -1),
        }
      );
    }

    if (
      !config.baseUrl.startsWith('http://') &&
      !config.baseUrl.startsWith('https://')
    ) {
      throw new MetaError(
        'IndustryApiConfig.baseUrl must start with http:// or https://',
        { url: config.baseUrl }
      );
    }
  }
}

export function configureIndustryApi(config: IndustryApiConfig): void {
  validateConfig(config);
  globalConfig = config;
}

export function getIndustryApiConfig(): IndustryApiConfig | null {
  return globalConfig;
}
