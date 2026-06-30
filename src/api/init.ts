/**
 * Early API initialization module.
 * Import this BEFORE any module that uses SettingsManager or droolApi.
 *
 * This module:
 * 1. Initializes environment (required for API config)
 * 2. Configures Industry API globally
 */
import { configureIndustryApi } from '@industry/drool-core/api/config';

import { getIndustryApiConfig } from '@/api/config';
import { initializeEnvironment } from '@/environment';

// Initialize environment first (required for getIndustryApiConfig)
initializeEnvironment();

// Configure API globally - must happen before any SettingsManager usage
configureIndustryApi(getIndustryApiConfig());
