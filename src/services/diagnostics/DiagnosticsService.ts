import { logException } from '@industry/logging';
import { SettingsManager } from '@industry/runtime/settings';

import { collectDiagnostics } from '@/services/diagnostics/DiagnosticsCollector';
import type { DiagnosticsState } from '@/services/diagnostics/types';

class DiagnosticsService {
  private state: DiagnosticsState = {
    failures: [],
    hasFailures: false,
    lastChecked: null,
  };

  private subscribers = new Set<() => void>();

  private settingsListenerAttached = false;

  getState(): DiagnosticsState {
    return this.state;
  }

  subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async refresh(): Promise<void> {
    try {
      const failures = await collectDiagnostics();
      this.setState({
        failures,
        hasFailures: failures.length > 0,
        lastChecked: Date.now(),
      });
    } catch (error) {
      logException(error, '[DiagnosticsService] Failed to refresh');
    }
  }

  attachSettingsListener(): void {
    if (this.settingsListenerAttached) return;
    this.settingsListenerAttached = true;

    SettingsManager.getInstance().on('settings-changed', () => {
      void this.refresh().catch(() => {});
    });
  }

  private setState(state: DiagnosticsState): void {
    this.state = state;
    for (const callback of this.subscribers) {
      try {
        callback();
      } catch (error) {
        logException(error, '[DiagnosticsService] Subscriber callback failed');
      }
    }
  }
}

let instance: DiagnosticsService | null = null;

export function getDiagnosticsService(): DiagnosticsService {
  if (!instance) {
    instance = new DiagnosticsService();
  }
  return instance;
}
