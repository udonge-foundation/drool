/**
 * Converts JSON Schema to a format compatible with Google Gemini API (Vertex AI proto).
 *
 * Gemini's FunctionDeclaration proto uses a strict Schema definition that differs
 * from JSON Schema. This converter:
 * - Strips unsupported fields ($schema, additionalProperties, examples, uniqueItems, etc.)
 * - Converts const values to enum arrays
 * - Coerces all enum values to strings (Gemini requires TYPE_STRING for enum entries)
 * - Handles nullable types (array types and anyOf patterns)
 * - Converts allOf by merging schemas (Gemini only supports anyOf)
 * - Converts oneOf to anyOf (Gemini only supports anyOf)
 * - Ensures type arrays without null pick first type (Gemini expects scalar type)
 * - Defaults to "object" type when type is missing but properties are present
 * - Handles tuple items arrays by picking the first schema (Gemini expects single items)
 */
export function convertJsonSchemaToGeminiSchema(schema: unknown): object {
  // Handle null or boolean schema
  if (schema === null || typeof schema === 'boolean') {
    return schema === true ? {} : { type: 'null' };
  }

  // Create a new object to avoid mutating the original
  const result: Record<string, unknown> = {};

  // Need to check if schema is an object before accessing properties
  if (typeof schema !== 'object') {
    return result;
  }

  const schemaObj = schema as Record<string, unknown>;

  // Copy properties that are supported by Gemini
  if ('type' in schemaObj) {
    // Handle array of types (e.g., ["string", "null"])
    if (Array.isArray(schemaObj.type)) {
      const types = schemaObj.type as string[];
      if (types.includes('null')) {
        const nonNullType = types.find((t) => t !== 'null');
        result.type = nonNullType ?? 'string';
        result.nullable = true;
      } else {
        // Gemini expects a scalar type, not an array. Pick the first type.
        result.type = types[0] ?? 'string';
      }
    } else {
      result.type = schemaObj.type;
    }
  }

  // Handle title
  if ('title' in schemaObj && typeof schemaObj.title === 'string') {
    result.title = schemaObj.title;
  }

  // Handle description
  if ('description' in schemaObj && typeof schemaObj.description === 'string') {
    result.description = schemaObj.description;
  }

  // Handle required properties
  if ('required' in schemaObj && Array.isArray(schemaObj.required)) {
    result.required = schemaObj.required;
  }

  // Handle format (e.g., date-time)
  if ('format' in schemaObj && typeof schemaObj.format === 'string') {
    result.format = schemaObj.format;
  }

  // Handle minimum/maximum constraints
  if ('minimum' in schemaObj) result.minimum = schemaObj.minimum;
  if ('maximum' in schemaObj) result.maximum = schemaObj.maximum;
  // Drop unsupported exclusiveMinimum/exclusiveMaximum for Vertex tool schemas

  // Handle string constraints
  if ('minLength' in schemaObj) result.minLength = schemaObj.minLength;
  if ('maxLength' in schemaObj) result.maxLength = schemaObj.maxLength;
  if ('pattern' in schemaObj) result.pattern = schemaObj.pattern;

  // Handle array constraints (Gemini supports minItems/maxItems but not uniqueItems)
  if ('minItems' in schemaObj) result.minItems = schemaObj.minItems;
  if ('maxItems' in schemaObj) result.maxItems = schemaObj.maxItems;
  // uniqueItems is NOT supported by Gemini Schema proto - intentionally dropped

  // multipleOf is NOT supported by Gemini Schema proto - intentionally dropped

  // Convert const to enum (with string coercion)
  if ('const' in schemaObj) {
    result.enum = [String(schemaObj.const)];
  }

  // Copy enum with string coercion (Gemini requires all enum values to be strings)
  if ('enum' in schemaObj && Array.isArray(schemaObj.enum)) {
    result.enum = (schemaObj.enum as unknown[]).map((v) => String(v));
  }

  // Handle properties for objects
  if (
    'properties' in schemaObj &&
    typeof schemaObj.properties === 'object' &&
    schemaObj.properties !== null
  ) {
    result.properties = {};
    for (const [key, value] of Object.entries(
      schemaObj.properties as Record<string, unknown>
    )) {
      (result.properties as Record<string, unknown>)[key] =
        convertJsonSchemaToGeminiSchema(value);
    }
  }

  // Handle items for arrays (Gemini only supports a single Schema, not tuple arrays)
  if ('items' in schemaObj) {
    if (Array.isArray(schemaObj.items)) {
      // Tuple validation: Gemini doesn't support array items. Use first schema.
      const items = schemaObj.items as unknown[];
      if (items.length > 0) {
        result.items = convertJsonSchemaToGeminiSchema(items[0]);
      }
    } else {
      result.items = convertJsonSchemaToGeminiSchema(schemaObj.items);
    }
  }

  // Handle allOf by merging schemas (Gemini doesn't support allOf)
  if ('allOf' in schemaObj && Array.isArray(schemaObj.allOf)) {
    const allOfArray = schemaObj.allOf as unknown[];
    for (const subSchema of allOfArray) {
      const converted = convertJsonSchemaToGeminiSchema(subSchema);
      if (typeof converted === 'object' && converted !== null) {
        // Merge: later schemas override earlier ones for scalar fields,
        // but properties are deep-merged
        const convertedObj = converted as Record<string, unknown>;
        for (const [key, value] of Object.entries(convertedObj)) {
          if (
            key === 'properties' &&
            typeof value === 'object' &&
            value !== null
          ) {
            result.properties = {
              ...((result.properties as Record<string, unknown>) ?? {}),
              ...(value as Record<string, unknown>),
            };
          } else if (
            key === 'required' &&
            Array.isArray(value) &&
            Array.isArray(result.required)
          ) {
            result.required = [
              ...new Set([
                ...(result.required as string[]),
                ...(value as string[]),
              ]),
            ];
          } else {
            result[key] = value;
          }
        }
      }
    }
  }

  if ('anyOf' in schemaObj && Array.isArray(schemaObj.anyOf)) {
    // Special handling for anyOf with null type (nullable)
    const anyOfArray = schemaObj.anyOf as unknown[];
    const nullSchema = anyOfArray.find(
      (s) =>
        s &&
        typeof s === 'object' &&
        'type' in s &&
        (s as Record<string, unknown>).type === 'null'
    );
    const nonNullSchemas = anyOfArray.filter(
      (s) =>
        !(
          s &&
          typeof s === 'object' &&
          'type' in s &&
          (s as Record<string, unknown>).type === 'null'
        )
    );

    if (nullSchema && nonNullSchemas.length === 1) {
      // If there's only one non-null schema, convert it and make it nullable
      const converted = convertJsonSchemaToGeminiSchema(nonNullSchemas[0]);
      if (typeof converted === 'object' && converted !== null) {
        Object.assign(result, converted);
        result.nullable = true;
      }
    } else {
      result.anyOf = anyOfArray.map((item) =>
        convertJsonSchemaToGeminiSchema(item)
      );
    }
  }

  // Convert oneOf to anyOf (Gemini only supports anyOf, not oneOf).
  // This is semantically lossy (oneOf = exactly-one-of, anyOf = at-least-one-of),
  // but the alternatives (dropping the constraint entirely or failing with 400)
  // are worse. LLMs use schemas as generation guidance, not strict validators,
  // so the xor→or relaxation is acceptable in practice.
  // Applies the same nullable-collapsing logic as anyOf above.
  if ('oneOf' in schemaObj && Array.isArray(schemaObj.oneOf)) {
    const oneOfArray = schemaObj.oneOf as unknown[];
    if (!result.anyOf) {
      const nullSchema = oneOfArray.find(
        (s) =>
          s &&
          typeof s === 'object' &&
          'type' in s &&
          (s as Record<string, unknown>).type === 'null'
      );
      const nonNullSchemas = oneOfArray.filter(
        (s) =>
          !(
            s &&
            typeof s === 'object' &&
            'type' in s &&
            (s as Record<string, unknown>).type === 'null'
          )
      );

      if (nullSchema && nonNullSchemas.length === 1) {
        const converted = convertJsonSchemaToGeminiSchema(nonNullSchemas[0]);
        if (typeof converted === 'object' && converted !== null) {
          Object.assign(result, converted);
          result.nullable = true;
        }
      } else {
        result.anyOf = oneOfArray.map(convertJsonSchemaToGeminiSchema);
      }
    }
  }

  // Handle default value (supported by Gemini SDK Schema)
  if ('default' in schemaObj) {
    result.default = schemaObj.default;
  }

  // Gemini supports 'example' (singular) but NOT 'examples' (plural).
  // Preserve 'example' if present; convert 'examples' → 'example' (first element).
  if ('example' in schemaObj) {
    result.example = schemaObj.example;
  } else if (
    'examples' in schemaObj &&
    Array.isArray(schemaObj.examples) &&
    schemaObj.examples.length > 0
  ) {
    result.example = schemaObj.examples[0];
  }

  // Infer type when missing but properties are present (Gemini requires type)
  if (!('type' in result)) {
    if (result.properties) {
      result.type = 'object';
    } else if (result.items) {
      result.type = 'array';
    } else if (result.enum) {
      result.type = 'string';
    }
  }

  return result;
}
