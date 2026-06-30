/**
 * Sanitizes JSON Schema for LLM tool parameters by stripping keywords
 * that many LLM providers (Kimi/Fireworks, etc.) reject.
 *
 * Unlike the Gemini-specific converter, this preserves standard JSON Schema
 * structure and only removes problematic keywords:
 * - `default` - rejected by Kimi/Fireworks
 * - `not` - rejected by Kimi/Fireworks
 * - `$ref`, `$defs`, `definitions` - unresolvable by most LLM APIs
 * - `examples` - rejected by multiple providers
 * - `if`, `then`, `else` - conditional schemas not supported
 * - `dependentRequired`, `dependentSchemas` - not supported
 * - `unevaluatedProperties`, `unevaluatedItems` - not supported
 * - `contentEncoding`, `contentMediaType`, `contentSchema` - not supported
 *
 * Note: `$schema`, `$id`, `$comment` are NOT stripped here because they are
 * harmless for OpenAI/Fireworks and stripping them would change request bodies
 * for all built-in tools. They are already stripped by the Gemini-specific converter.
 */

const UNSUPPORTED_KEYWORDS = new Set([
  'default',
  'not',
  '$ref',
  '$defs',
  'definitions',
  'examples',
  'if',
  'then',
  'else',
  'dependentRequired',
  'dependentSchemas',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
]);

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNeverUnionBranch(schema: unknown): boolean {
  if (!isSchemaObject(schema) || !('not' in schema)) return false;

  return (
    schema.not === true ||
    (isSchemaObject(schema.not) && Object.keys(schema.not).length === 0)
  );
}

interface MergeSingleUnionBranchOptions {
  result: Record<string, unknown>;
  source: Record<string, unknown>;
  unionKey: 'anyOf' | 'oneOf';
  branch: unknown;
}

function mergeSingleUnionBranch({
  result,
  source,
  unionKey,
  branch,
}: MergeSingleUnionBranchOptions): boolean {
  if (branch === true) return true;
  if (!isSchemaObject(branch)) return false;

  if (
    Object.keys(branch).some(
      (key) =>
        key !== unionKey && key in source && !UNSUPPORTED_KEYWORDS.has(key)
    )
  ) {
    return false;
  }

  for (const [key, value] of Object.entries(branch)) {
    if (!(key in result)) {
      result[key] = value;
    }
  }
  return true;
}

export function sanitizeJsonSchemaForLLM(schema: unknown): unknown {
  if (schema === null || schema === undefined || typeof schema === 'boolean') {
    return schema;
  }

  if (typeof schema !== 'object') {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(sanitizeJsonSchemaForLLM);
  }

  const schemaObj = schema as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schemaObj)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) {
      continue;
    }

    if (
      key === 'properties' &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      const props: Record<string, unknown> = {};
      for (const [propKey, propValue] of Object.entries(
        value as Record<string, unknown>
      )) {
        props[propKey] = sanitizeJsonSchemaForLLM(propValue);
      }
      result[key] = props;
    } else if (key === 'items') {
      // Normalize tuple-style `items` (array of schemas) into an `anyOf`
      // union schema. OpenAI rejects tuple items outright with
      // "[...] is not of type 'object', 'boolean'".
      if (Array.isArray(value)) {
        const sanitizedTuple = value.map(sanitizeJsonSchemaForLLM);
        if (sanitizedTuple.length === 1) {
          result[key] = sanitizedTuple[0];
        } else if (sanitizedTuple.length > 1) {
          result[key] = { anyOf: sanitizedTuple };
        } else {
          // Empty tuple — fall back to a permissive item schema.
          result[key] = {};
        }
      } else {
        result[key] = sanitizeJsonSchemaForLLM(value);
      }
    } else if ((key === 'anyOf' || key === 'oneOf') && Array.isArray(value)) {
      const possibleBranches = value.filter(
        (branch) => !isNeverUnionBranch(branch)
      );
      const branches = possibleBranches.map(sanitizeJsonSchemaForLLM);
      const removedNeverBranch = possibleBranches.length !== value.length;

      if (
        !removedNeverBranch ||
        branches.length !== 1 ||
        !mergeSingleUnionBranch({
          result,
          source: schemaObj,
          unionKey: key,
          branch: branches[0],
        })
      ) {
        result[key] = branches;
      }
    } else if (key === 'allOf' && Array.isArray(value)) {
      result[key] = value.map(sanitizeJsonSchemaForLLM);
    } else if (
      key === 'additionalProperties' &&
      typeof value === 'object' &&
      value !== null
    ) {
      result[key] = sanitizeJsonSchemaForLLM(value);
    } else {
      result[key] = value;
    }
  }

  // Infer type when missing but can be determined from structure
  if (!('type' in result)) {
    if (result.properties) {
      result.type = 'object';
    } else if (result.items) {
      result.type = 'array';
    } else if (result.enum) {
      result.type = 'string';
    }
  }

  // Backfill missing `items` when this is an array schema. OpenAI rejects
  // array schemas without `items` with "array schema missing items".
  if (result.type === 'array' && !('items' in result)) {
    result.items = {};
  }

  return result;
}
