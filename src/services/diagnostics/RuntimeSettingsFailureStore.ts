import { DiagnosticFailureType } from '@/services/diagnostics/enums';
import type { DiagnosticFailure } from '@/services/diagnostics/types';

let runtimeSettingsStartupFailure: DiagnosticFailure | null = null;

export function setRuntimeSettingsStartupFailure(
  path: string,
  message: string
): void {
  runtimeSettingsStartupFailure = {
    type: DiagnosticFailureType.RuntimeSettings,
    scope: 'runtime',
    path,
    message,
  };
}

export function clearRuntimeSettingsStartupFailure(): void {
  runtimeSettingsStartupFailure = null;
}

export function getRuntimeSettingsStartupFailure(): DiagnosticFailure | null {
  return runtimeSettingsStartupFailure;
}
