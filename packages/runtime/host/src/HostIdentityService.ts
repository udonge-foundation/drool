import { randomUUID } from 'crypto';

import { HostConfigStore } from './HostConfigStore';

import type {
  HostIdentityAuthContext,
  HostIdentityServiceOptions,
  SaveComputerRegistrationParams,
} from './types';
import type {
  ComputerRegistration,
  HostConfig,
  LegacyComputerConfig,
  ResolvedHostIdentity,
} from '@industry/drool-sdk-ext/protocol/host';

export class HostIdentityService {
  private readonly store: HostConfigStore;

  private readonly now: () => number;

  private readonly generateHostId: () => string;

  constructor(options: HostIdentityServiceOptions) {
    this.store = new HostConfigStore(options.industryDir);
    this.now = options.now ?? Date.now;
    this.generateHostId = options.generateHostId ?? randomUUID;
  }

  async getHostIdentity(
    authContext?: HostIdentityAuthContext | null
  ): Promise<ResolvedHostIdentity> {
    const config = await this.ensureHostConfig(authContext);
    const computerRegistration = this.getValidComputerRegistration(
      config,
      authContext
    );

    return {
      hostId: config.hostId,
      ...(authContext && computerRegistration
        ? {
            computerRegistration: {
              computerId: computerRegistration.computerId,
              firestoreOrgId: computerRegistration.firestoreOrgId,
              userId: computerRegistration.userId,
            },
          }
        : {}),
    };
  }

  async getComputerRegistration(
    authContext: HostIdentityAuthContext
  ): Promise<ComputerRegistration | null> {
    const config = await this.ensureHostConfig(authContext);
    return this.getValidComputerRegistration(config, authContext);
  }

  async getComputerConfig(
    authContext: HostIdentityAuthContext
  ): Promise<LegacyComputerConfig | null> {
    const config = await this.ensureHostConfig(authContext);
    const registration = this.getValidComputerRegistration(config, authContext);
    if (registration) {
      return {
        computerId: registration.computerId,
        registeredAt: registration.registeredAt,
      };
    }

    if (config.computerRegistration) {
      return null;
    }

    return this.store.loadLegacyComputerConfig();
  }

  async saveComputerRegistration({
    computerId,
    authContext,
  }: SaveComputerRegistrationParams): Promise<LegacyComputerConfig> {
    const registeredAt = this.now();
    const legacyConfig = { computerId, registeredAt };
    const config = await this.ensureHostConfig(authContext);

    await this.store.saveHostConfig({
      ...config,
      computerRegistration: {
        computerId,
        firestoreOrgId: authContext.firestoreOrgId,
        userId: authContext.userId,
        registeredAt,
      },
    });

    await this.store.saveLegacyComputerConfig(legacyConfig);
    return legacyConfig;
  }

  async removeComputerRegistration(
    authContext: HostIdentityAuthContext
  ): Promise<void> {
    const config = await this.ensureHostConfig(authContext);
    if (!this.getValidComputerRegistration(config, authContext)) {
      return;
    }

    await this.store.saveHostConfig({
      schemaVersion: config.schemaVersion,
      hostId: config.hostId,
      createdAt: config.createdAt,
    });
    await this.store.removeLegacyComputerConfig();
  }

  async ensureHostConfig(
    authContext?: HostIdentityAuthContext | null
  ): Promise<HostConfig> {
    const existing = await this.store.loadHostConfig();
    if (existing) {
      return this.migrateLegacyRegistration(existing, authContext);
    }

    return this.store.withHostConfigLock(async () => {
      const lockedExisting = await this.store.loadHostConfig();
      if (lockedExisting) {
        return this.migrateLegacyRegistration(lockedExisting, authContext);
      }

      await this.store.quarantineHostConfig(`invalid-${this.now()}`);

      const config: HostConfig = {
        schemaVersion: 1,
        hostId: this.generateHostId(),
        createdAt: this.now(),
      };

      await this.store.saveHostConfig(config);
      return this.migrateLegacyRegistration(config, authContext);
    });
  }

  private async migrateLegacyRegistration(
    config: HostConfig,
    authContext?: HostIdentityAuthContext | null
  ): Promise<HostConfig> {
    if (config.computerRegistration || !authContext) {
      return config;
    }

    const legacyConfig = await this.store.loadLegacyComputerConfig();
    if (!legacyConfig) {
      return config;
    }

    const migrated = {
      ...config,
      computerRegistration: {
        computerId: legacyConfig.computerId,
        firestoreOrgId: authContext.firestoreOrgId,
        userId: authContext.userId,
        registeredAt: legacyConfig.registeredAt,
      },
    } satisfies HostConfig;

    await this.store.saveHostConfig(migrated);
    return migrated;
  }

  private getValidComputerRegistration(
    config: HostConfig,
    authContext?: HostIdentityAuthContext | null
  ): ComputerRegistration | null {
    const registration = config.computerRegistration;
    if (!registration) return null;
    if (!authContext) return null;

    const matchesAuth =
      registration.userId === authContext.userId &&
      registration.firestoreOrgId === authContext.firestoreOrgId;

    return matchesAuth ? registration : null;
  }
}
