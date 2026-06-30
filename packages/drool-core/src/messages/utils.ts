import { RiskLevel } from '@industry/drool-sdk-ext/protocol/tools';
import { logError } from '@industry/logging';

export function riskLevelToNumber(
  riskLevel: RiskLevel | null | undefined
): number {
  switch (riskLevel) {
    case undefined:
    case null:
      return 0;
    case RiskLevel.LOW:
      return 1;
    case RiskLevel.MEDIUM:
      return 2;
    case RiskLevel.HIGH:
      return 3;
    default: {
      logError(
        'Unhandled risk level. Please check the risk level value. Failing to default',
        { riskLevel }
      );
      return 3;
    }
  }
}
