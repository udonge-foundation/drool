const UNPAIRED_SURROGATE_REGEX =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// Slicing by UTF-16 code units can leave an unpaired surrogate, which cannot be
// encoded as valid UTF-8. Firestore (and JSON.stringify -> UTF-8) reject those.
export function sanitizeStringToWellFormed(value: string): string {
  const maybeToWellFormed = Reflect.get(String.prototype, 'toWellFormed');

  if (typeof maybeToWellFormed === 'function') {
    return String(maybeToWellFormed.call(value));
  }

  return value.replace(UNPAIRED_SURROGATE_REGEX, '\uFFFD');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeDeepToWellFormedUnknown(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeStringToWellFormed(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDeepToWellFormedUnknown(item));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitizeDeepToWellFormedUnknown(item),
      ])
    );
  }

  return value;
}

export function sanitizeDeepToWellFormed<T>(value: T): T {
  return sanitizeDeepToWellFormedUnknown(value) as T;
}
