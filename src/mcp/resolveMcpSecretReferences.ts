import { MetaError } from '@industry/logging/errors';

const MCP_ENV_REFERENCE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Resolves `${NAME}` references in one MCP credential value at connection time.
 *
 * Use for credential-bearing MCP configuration fields that should remain
 * placeholder-based in persisted settings.
 */
export function resolveMcpSecretReference({
  serverName,
  value,
  environment = process.env,
}: {
  serverName: string;
  value: string;
  environment?: Readonly<Record<string, string | undefined>>;
}): string {
  return value.replace(
    MCP_ENV_REFERENCE_PATTERN,
    (_reference, variableName) => {
      const resolvedValue = environment[variableName];
      if (resolvedValue === undefined) {
        throw new MetaError(
          'MCP server credential references an unset environment variable',
          { name: serverName, envVar: variableName }
        );
      }
      return resolvedValue;
    }
  );
}

/**
 * Resolves `${NAME}` references in an MCP credential record at connection time.
 *
 * Use for configured headers or stdio environment overrides immediately before
 * initializing their transport.
 */
export function resolveMcpSecretReferences({
  serverName,
  values,
  environment = process.env,
}: {
  serverName: string;
  values: Record<string, string> | undefined;
  environment?: Readonly<Record<string, string | undefined>>;
}): Record<string, string> | undefined {
  if (!values) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      resolveMcpSecretReference({ serverName, value, environment }),
    ])
  );
}
