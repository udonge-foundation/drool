import Ajv, { AnySchema } from 'ajv';
import addFormats from 'ajv-formats';
import { z } from 'zod';

import { logException } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { InputJSONSchema } from '../types';

const ajv = new Ajv({
  removeAdditional: true,
  allErrors: true,
  // Automatically assign default values defined in the JSON schema
  useDefaults: true,
});

// Add support for formats including 'uri', 'date', 'email', etc.
addFormats(ajv);

function constructSchemaGuidance(
  toolId: string,
  schema: InputJSONSchema,
  compiledSchema: AnySchema
): string {
  const requiredFields =
    typeof compiledSchema !== 'boolean' &&
    'required' in compiledSchema &&
    Array.isArray(compiledSchema.required)
      ? (compiledSchema.required as string[])
      : [];

  const parametersGuide = Object.entries(
    schema.properties as { [key: string]: { description?: string } }
  )
    .map(([field, prop]) => {
      const isRequired = requiredFields.includes(field);
      return `- ${field}${isRequired ? ' (required)' : ' (optional)'}: ${
        prop.description || ''
      }`;
    })
    .join('\n');

  return `Tool "${toolId}" requires the following parameters:\n${parametersGuide}\n\nPlease retry with valid parameters.`;
}

function formatHumanError(
  error: string,
  inputSchema: InputJSONSchema,
  compiledSchema: AnySchema
): string {
  const formattedError = error.replace(/data\//g, '');

  // Extract required fields from compiled schema
  const requiredFields =
    typeof compiledSchema !== 'boolean' &&
    'required' in compiledSchema &&
    Array.isArray(compiledSchema.required)
      ? (compiledSchema.required as string[])
      : [];

  // Format properties in a clean way
  let schemaInfo = '';
  if (inputSchema.properties) {
    schemaInfo = Object.entries(
      inputSchema.properties as Record<string, { type?: string }>
    )
      .map(([propName, propDetails]) => {
        const isRequired = requiredFields.includes(propName);
        const type = propDetails.type || 'any';
        return `  ${propName}${!isRequired ? ' (optional)' : ''}: ${type}`;
      })
      .join('\n');
  }

  return `Schema validation failed: ${formattedError}\n\nExpected parameters:\n${schemaInfo}`;
}

interface ValidateToolParametersParams {
  parameters: Record<string, unknown>;
  toolId: string;
  inputSchema?: InputJSONSchema;
  inputZodSchema?: z.ZodTypeAny;
}

export function validateToolParameters({
  parameters,
  toolId,
  inputSchema,
  inputZodSchema,
}: ValidateToolParametersParams): {
  isValid: boolean;
  llmError?: string;
  humanError?: string;
  validatedParameters?: Record<string, unknown>;
} {
  // Use Zod validation if inputZodSchema is provided
  if (inputZodSchema) {
    try {
      const parsed = inputZodSchema.safeParse(parameters);

      if (parsed.success) {
        return {
          isValid: true,
          validatedParameters: parsed.data,
        };
      }

      // Map Zod issues to error messages
      const issues = parsed.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? `/${issue.path.join('/')}` : '';
        return `${path} ${issue.message}`;
      });

      const zodMsg = issues.join('\n');
      let llmError = zodMsg;

      // Append schema guidance if inputSchema is available
      if (inputSchema) {
        const validate = ajv.compile(inputSchema);
        const schemaGuidance = constructSchemaGuidance(
          toolId,
          inputSchema,
          validate.schema
        );
        llmError = `${zodMsg}\n\n${schemaGuidance}`;
      }

      const humanError = inputSchema
        ? formatHumanError(zodMsg, inputSchema, ajv.compile(inputSchema).schema)
        : `Schema validation failed: ${zodMsg}`;

      return {
        isValid: false,
        llmError,
        humanError,
      };
    } catch (error) {
      // Schema compilation/parsing failed - allow execution to proceed
      // and let the server validate the parameters (consistent with AJV path)
      logException(error, 'Error validating tool parameters with Zod');

      // Allow execution to proceed - the server will validate the parameters
      return {
        isValid: true,
        validatedParameters: parameters,
      };
    }
  }

  // Fallback to AJV validation (existing path)
  if (!inputSchema) {
    throw new MetaError(
      'Either inputZodSchema or inputSchema must be provided'
    );
  }

  try {
    const validate = ajv.compile(inputSchema);
    const isValid = validate(parameters);

    if (isValid) {
      return { isValid: true };
    }

    const errorMessage = ajv.errorsText(validate.errors, {
      separator: '\n',
      dataVar: '', // This removes the "data/" prefix
    });
    const schemaGuidance = constructSchemaGuidance(
      toolId,
      inputSchema,
      validate.schema
    );

    return {
      isValid: false,
      llmError: `${errorMessage}\n\n${schemaGuidance}`,
      humanError: formatHumanError(errorMessage, inputSchema, validate.schema),
    };
  } catch (error) {
    // Schema compilation failed - this can happen with complex schemas using $ref
    // (e.g., MCP tools with local definitions like "$ref": "#/definitions/inputs")
    // In this case, skip client-side validation and let the MCP server validate

    // Only log as exception for unexpected errors, not $ref resolution issues
    const isRefError =
      error instanceof Error &&
      error.message.includes("can't resolve reference");
    if (!isRefError) {
      logException(error, 'Error validating tool parameters');
    }

    // Allow execution to proceed - the server will validate the parameters
    return {
      isValid: true,
      validatedParameters: parameters,
    };
  }
}
