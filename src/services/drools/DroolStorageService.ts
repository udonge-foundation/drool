import * as path from 'path';

import { type CustomDrool, type DroolMetadata } from '@industry/common/settings';
import {
  SettingsLevel,
  type DroolLocation,
} from '@industry/drool-sdk-ext/protocol/settings';
import { logInfo } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { SettingsManager } from '@industry/runtime/settings';

import { getAvailableModelsForExec } from '@/models/availability';
import { DroolParser } from '@/services/drools/DroolParser';
import { DroolValidator } from '@/services/drools/DroolValidator';
import { DroolConfig } from '@/services/drools/types';
import { sanitizeDroolName } from '@/utils/drools/paths';

/**
 * Service for drool CRUD operations.
 * Uses SettingsManager for all persistence operations.
 */
export class DroolStorageService {
  /**
   * Get all drools from resolved settings
   */
  private async getAllDrools(): Promise<CustomDrool[]> {
    const manager = SettingsManager.getInstance();
    const settings = await manager.getResolvedSettings();
    return settings.drools?.customDrools ?? [];
  }

  /**
   * Create a new drool
   */
  async createDrool(
    name: string,
    systemPrompt: string,
    metadata: Partial<DroolMetadata>,
    location: DroolLocation
  ): Promise<CustomDrool> {
    const sanitizedName = sanitizeDroolName(name);
    const manager = SettingsManager.getInstance();
    const level =
      location === 'personal' ? SettingsLevel.User : SettingsLevel.Project;

    // Get current drools at this level
    const settings = await manager.getLevelSettings(level);
    const currentDrools = settings.drools?.customDrools ?? [];

    // Check if exists
    if (currentDrools.some((d) => d.metadata.name === sanitizedName)) {
      throw new MetaError('Drool already exists', {
        name: sanitizedName,
        location,
      });
    }

    const targetPath =
      location === 'personal'
        ? manager.getUserPath()
        : manager.getProjectPath();

    if (!targetPath) {
      throw new MetaError('Cannot determine target path for drool', {
        location,
      });
    }

    const filePath = path.join(targetPath, 'drools', `${sanitizedName}.md`);

    const newDrool: CustomDrool = {
      metadata: {
        ...metadata,
        name: sanitizedName, // Must come after spread to prevent override
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      systemPrompt,
      location,
      filePath,
      lastModified: Date.now(),
      validationResult: { valid: true, errors: [], warnings: [] },
    };

    await manager.updateLevelSettings(level, {
      drools: { customDrools: [...currentDrools, newDrool] },
    });

    logInfo('Created drool', { name: sanitizedName, path: filePath });
    return newDrool;
  }

  /**
   * Read a drool by name
   */
  async readDrool(
    name: string,
    location?: DroolLocation
  ): Promise<CustomDrool | null> {
    const sanitizedName = sanitizeDroolName(name);
    const drools = await this.getAllDrools();

    if (location) {
      return (
        drools.find(
          (d) => d.metadata.name === sanitizedName && d.location === location
        ) ?? null
      );
    }

    // Project takes precedence over personal
    return (
      drools.find(
        (d) => d.metadata.name === sanitizedName && d.location === 'project'
      ) ??
      drools.find((d) => d.metadata.name === sanitizedName) ??
      null
    );
  }

  /**
   * Update an existing drool
   */
  async updateDrool(
    name: string,
    updates: {
      systemPrompt?: string;
      metadata?: Partial<DroolMetadata>;
    },
    location: DroolLocation
  ): Promise<CustomDrool> {
    const sanitizedName = sanitizeDroolName(name);
    const manager = SettingsManager.getInstance();
    const level =
      location === 'personal' ? SettingsLevel.User : SettingsLevel.Project;

    const settings = await manager.getLevelSettings(level);
    const currentDrools = settings.drools?.customDrools ?? [];
    const existingIndex = currentDrools.findIndex(
      (d) => d.metadata.name === sanitizedName
    );

    if (existingIndex === -1) {
      throw new MetaError('Drool not found', {
        name: sanitizedName,
        location,
      });
    }

    const existing = currentDrools[existingIndex];
    const updatedDrool: CustomDrool = {
      ...existing,
      systemPrompt: updates.systemPrompt ?? existing.systemPrompt,
      metadata: {
        ...existing.metadata,
        ...updates.metadata,
        name: existing.metadata.name, // Preserve original name, prevent rename
        updatedAt: new Date().toISOString(),
      },
      lastModified: Date.now(),
    };

    const newDrools = [...currentDrools];
    newDrools[existingIndex] = updatedDrool;

    await manager.updateLevelSettings(level, {
      drools: { customDrools: newDrools },
    });

    logInfo('Updated drool', { name: sanitizedName });
    return updatedDrool;
  }

  /**
   * Delete a drool
   */
  async deleteDrool(name: string, location: DroolLocation): Promise<void> {
    const sanitizedName = sanitizeDroolName(name);
    const manager = SettingsManager.getInstance();
    const level =
      location === 'personal' ? SettingsLevel.User : SettingsLevel.Project;

    const settings = await manager.getLevelSettings(level);
    const currentDrools = settings.drools?.customDrools ?? [];
    const droolIndex = currentDrools.findIndex(
      (d) => d.metadata.name === sanitizedName
    );

    if (droolIndex === -1) {
      throw new MetaError('Drool not found', {
        name: sanitizedName,
        location,
      });
    }

    // Remove drool from array - persistDrools will delete the file
    const newDrools = currentDrools.filter(
      (d) => d.metadata.name !== sanitizedName
    );
    await manager.updateLevelSettings(level, {
      drools: { customDrools: newDrools },
    });

    logInfo('Deleted drool', { name: sanitizedName });
  }

  /**
   * List all drools
   */
  async listDrools(): Promise<CustomDrool[]> {
    return this.getAllDrools();
  }

  /**
   * Alias for listDrools() - for backward compatibility with DroolLoader API
   */
  async loadAllDrools(): Promise<CustomDrool[]> {
    return this.getAllDrools();
  }

  /**
   * List drools from a specific location
   */
  async listDroolsFromLocation(
    location: DroolLocation
  ): Promise<CustomDrool[]> {
    const drools = await this.getAllDrools();
    return drools.filter((d) => d.location === location);
  }

  /**
   * Check if any drools exist
   */
  async hasDrools(): Promise<boolean> {
    const drools = await this.getAllDrools();
    return drools.length > 0;
  }

  /**
   * Get available drool names for tool enum
   */
  async getAvailableDroolNames(): Promise<string[]> {
    const drools = await this.getAllDrools();
    return drools.map((d) => d.metadata.name);
  }

  /**
   * Export a drool to a string (for sharing)
   */
  async exportDrool(name: string, location?: DroolLocation): Promise<string> {
    const drool = await this.readDrool(name, location);
    if (!drool) {
      throw new MetaError('Drool not found', { name });
    }

    return DroolParser.stringify(drool.systemPrompt, drool.metadata);
  }

  /**
   * Import a drool from a string
   */
  async importDrool(
    content: string,
    location: DroolLocation,
    overwrite = false
  ): Promise<DroolConfig> {
    const availableModels = await getAvailableModelsForExec();
    const parsed = DroolParser.parse(content, availableModels);

    if (!parsed.metadata.name) {
      throw new MetaError('Invalid drool content: missing name in metadata');
    }

    const metadata = parsed.metadata;
    const sanitizedName = sanitizeDroolName(metadata.name);

    // Check if drool exists
    const existing = await this.readDrool(sanitizedName, location);

    if (!overwrite && existing) {
      throw new MetaError('Drool already exists', {
        name: sanitizedName,
        location,
      });
    }

    // Validate metadata (not full config since filePath is not known yet)
    const metadataValidation = DroolValidator.validateMetadata(
      parsed.metadata,
      availableModels
    );
    if (!metadataValidation.valid) {
      throw new MetaError('Invalid drool configuration', {
        errorMessage: JSON.stringify(metadataValidation.errors),
      });
    }

    // Validate system prompt
    const promptValidation = DroolValidator.validateSystemPrompt(
      parsed.systemPrompt.trim()
    );
    if (!promptValidation.valid) {
      throw new MetaError('Invalid drool configuration', {
        errorMessage: JSON.stringify(promptValidation.errors),
      });
    }

    // Create or update the drool
    if (existing) {
      const updated = await this.updateDrool(
        sanitizedName,
        { systemPrompt: parsed.systemPrompt.trim(), metadata },
        location
      );
      return {
        metadata: updated.metadata,
        systemPrompt: updated.systemPrompt,
        location: updated.location,
        filePath: updated.filePath,
      };
    }

    const created = await this.createDrool(
      sanitizedName,
      parsed.systemPrompt.trim(),
      metadata,
      location
    );
    return {
      metadata: created.metadata,
      systemPrompt: created.systemPrompt,
      location: created.location,
      filePath: created.filePath,
    };
  }
}
