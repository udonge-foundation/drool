/* eslint-disable import/no-relative-packages --
 * ink 6.8.0 gates its build/* files behind a strict `exports` map, so a
 * bare specifier (`ink/build/instances.js`) is rejected by bun's resolver
 * at SEA build time. The deep relative path bypasses the exports map and
 * is the established workaround (see "fix(cli): load Ink instances through
 * local shim"). Do NOT let eslint --fix rewrite this to `ink/build/instances.js`
 * -- it will break the CLI build.
 */
import inkInternalInstancesModule from '../../node_modules/ink/build/instances.js';

/**
 * @typedef {{ fullStaticOutput?: string }} InkInstanceLike
 */

/** @type {WeakMap<object, InkInstanceLike>} */
const inkInternalInstances = inkInternalInstancesModule;

export function getInkInternalInstances() {
  return inkInternalInstances;
}
