/**
 * Re-export from @industry/utils. The canonical implementation lives in
 * @industry/utils to break the cyclic dependency between @industry/services
 * and @industry/drool-core.
 */
// eslint-disable-next-line no-barrel-files/no-barrel-files
export { fetch } from '@industry/utils/api/fetch';
