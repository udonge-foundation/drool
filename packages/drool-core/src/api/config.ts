/**
 * Re-export from @industry/utils for backwards compatibility.
 * The canonical implementation now lives in @industry/utils to break
 * the cyclic dependency between @industry/services and @industry/drool-core.
 */
// eslint-disable-next-line no-barrel-files/no-barrel-files
export {
  configureIndustryApi,
  getIndustryApiConfig,
} from '@industry/utils/api/config';
