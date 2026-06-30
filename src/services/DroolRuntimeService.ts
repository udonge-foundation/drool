import { DroolMode, DroolSubMode } from '@industry/common/shared';

class DroolRuntimeService {
  // eslint-disable-next-line no-use-before-define
  private static instance: DroolRuntimeService | undefined;

  private droolMode: DroolMode = DroolMode.TerminalUI;

  private droolSubMode: DroolSubMode | null = null;

  static getInstance(): DroolRuntimeService {
    if (!DroolRuntimeService.instance) {
      DroolRuntimeService.instance = new DroolRuntimeService();
    }
    return DroolRuntimeService.instance;
  }

  setDroolMode(mode: DroolMode, subMode?: DroolSubMode | null): void {
    this.droolMode = mode;
    this.droolSubMode = subMode ?? null;
  }

  getDroolMode(): DroolMode {
    return this.droolMode;
  }

  getDroolSubMode(): DroolSubMode | null {
    return this.droolSubMode;
  }

  isNonInteractiveCLIMode(): boolean {
    return this.droolMode === DroolMode.NonInteractiveCLI;
  }

  isInteractiveCLIMode(): boolean {
    return this.droolMode === DroolMode.InteractiveCLI;
  }

  isJsonRpcMode(): boolean {
    return (
      this.droolMode === DroolMode.InteractiveCLI &&
      this.droolSubMode === DroolSubMode.JsonRpc
    );
  }

  isAcpMode(): boolean {
    return (
      this.droolMode === DroolMode.InteractiveCLI &&
      this.droolSubMode === DroolSubMode.ACP
    );
  }
}

export function getDroolRuntimeService(): DroolRuntimeService {
  return DroolRuntimeService.getInstance();
}
