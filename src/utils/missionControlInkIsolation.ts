interface InkNodeLike {
  parentNode?: InkNodeLike;
}

interface InkRootNodeLike extends InkNodeLike {
  staticNode?: InkNodeLike;
  isStaticDirty?: boolean;
  onRender?: () => void;
  onImmediateRender?: () => void;
}

interface InkInstanceLike {
  fullStaticOutput?: string;
  rootNode?: InkRootNodeLike;
}

type InkInstancesMap = WeakMap<object, InkInstanceLike>;

// Mission Control uses the real alternate screen buffer, but Ink's internal
// Static cache is renderer-global. We temporarily clear that cache while the
// alternate screen owns the terminal so stale static transcript output can't be
// replayed into Mission Control during fullscreen resizes.
let inkInstancesPromise: Promise<InkInstancesMap | null> | null = null;

const savedStaticOutputByStdout = new WeakMap<object, string>();
const patchedInkInstances = new WeakSet<object>();

async function getInkInstances(): Promise<InkInstancesMap | null> {
  if (!inkInstancesPromise) {
    inkInstancesPromise = import('@/utils/inkInternalInstances')
      .then((module) => module.getInkInternalInstances())
      .catch(() => null);
  }

  return inkInstancesPromise;
}

function getStdoutKey(stdout: NodeJS.WriteStream): object {
  return stdout as unknown as object;
}

function isNodeAttachedToRoot(
  node: InkNodeLike,
  rootNode: InkRootNodeLike
): boolean {
  let currentNode: InkNodeLike | undefined = node;

  while (currentNode) {
    if (currentNode === rootNode) {
      return true;
    }

    currentNode = currentNode.parentNode;
  }

  return false;
}

function clearDetachedInkStaticNode(instance: InkInstanceLike): boolean {
  const rootNode = instance.rootNode;
  const staticNode = rootNode?.staticNode;
  if (!rootNode || !staticNode) {
    return false;
  }

  if (isNodeAttachedToRoot(staticNode, rootNode)) {
    return false;
  }

  rootNode.staticNode = undefined;
  rootNode.isStaticDirty = true;

  return true;
}

function wrapInkRenderCallback(
  instance: InkInstanceLike,
  callbackName: 'onRender' | 'onImmediateRender'
): void {
  const rootNode = instance.rootNode;
  const originalCallback = rootNode?.[callbackName];
  if (!rootNode || typeof originalCallback !== 'function') {
    return;
  }

  rootNode[callbackName] = () => {
    clearDetachedInkStaticNode(instance);

    originalCallback();
  };
}

function ensureInkInstancePatched(instance: InkInstanceLike): void {
  const instanceKey = instance as object;
  if (patchedInkInstances.has(instanceKey)) {
    return;
  }

  clearDetachedInkStaticNode(instance);
  wrapInkRenderCallback(instance, 'onRender');
  wrapInkRenderCallback(instance, 'onImmediateRender');
  patchedInkInstances.add(instanceKey);
}

async function getInkInstance(
  stdout: NodeJS.WriteStream
): Promise<InkInstanceLike | null> {
  const instances = await getInkInstances();
  if (!instances) {
    return null;
  }

  const instance = instances.get(getStdoutKey(stdout));
  if (instance) {
    ensureInkInstancePatched(instance);
  }

  return instance ?? null;
}

export function preloadMissionControlInkIsolation(): void {
  void getInkInstance(process.stdout);
}

export async function enterMissionControlInkIsolation(
  stdout: NodeJS.WriteStream
): Promise<void> {
  const instance = await getInkInstance(stdout);
  if (!instance) {
    return;
  }

  const key = getStdoutKey(stdout);

  if (!savedStaticOutputByStdout.has(key)) {
    savedStaticOutputByStdout.set(key, instance.fullStaticOutput ?? '');
  }

  instance.fullStaticOutput = '';
}

export async function exitMissionControlInkIsolation(
  stdout: NodeJS.WriteStream
): Promise<void> {
  const instance = await getInkInstance(stdout);
  if (!instance) {
    return;
  }

  const key = getStdoutKey(stdout);
  const savedStaticOutput = savedStaticOutputByStdout.get(key);
  if (savedStaticOutput === undefined) {
    return;
  }

  instance.fullStaticOutput = savedStaticOutput;

  savedStaticOutputByStdout.delete(key);
}
