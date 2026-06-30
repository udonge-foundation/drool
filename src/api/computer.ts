import os from 'os';

import {
  Computer,
  ComputerListResponse,
  ComputerListResponseSchema,
  ComputerProviderType,
  ComputerSchema,
} from '@industry/common/api/v0/computers';
import { fetch } from '@industry/drool-core/api/fetch';
import { isFetchError, MetaError } from '@industry/logging/errors';

/**
 * Fetch computer details by ID from the backend API.
 * Returns null if computer is not found (404).
 */
export async function getComputerById(
  computerId: string
): Promise<Computer | null> {
  try {
    const response = await fetch(
      `/api/v0/computers/${encodeURIComponent(computerId)}`
    );
    const data = await response.json();
    const result = ComputerSchema.safeParse(data);
    if (!result.success) {
      throw new MetaError('Invalid computer response:', {
        data,
        serializedErrors: result.error.issues,
      });
    }
    return result.data;
  } catch (error) {
    if (isFetchError(error) && error.response.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Fetch computer details by name from the backend API.
 * Returns null if computer is not found (404).
 */
export async function getComputerByName(
  name: string
): Promise<Computer | null> {
  try {
    const response = await fetch(
      `/api/v0/computers/name/${encodeURIComponent(name)}`
    );
    const data = await response.json();
    const result = ComputerSchema.safeParse(data);
    if (!result.success) {
      throw new MetaError('Invalid computer response:', {
        data,
      });
    }
    return result.data;
  } catch (error) {
    if (isFetchError(error) && error.response.status === 404) {
      return null;
    }
    throw error;
  }
}

interface RegisterByomComputerParams {
  name: string;
  hostId?: string;
}

/** Register a BYOM computer. Returns the created computer with relayClientUrl. */
export async function registerByomComputer({
  name,
  hostId,
}: RegisterByomComputerParams): Promise<Computer> {
  const response = await fetch('/api/v0/computers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      provider: ComputerProviderType.Byom,
      ...(hostId ? { hostId } : {}),
      remoteUser: os.userInfo().username,
    }),
  });
  const data = await response.json();
  const result = ComputerSchema.safeParse(data);
  if (!result.success) {
    throw new MetaError('Invalid computer response from register', { data });
  }
  return result.data;
}

/** List all computers for the authenticated user's org. */
export async function listComputers(): Promise<ComputerListResponse> {
  const response = await fetch('/api/v0/computers');
  const data = await response.json();
  const result = ComputerListResponseSchema.safeParse(data);
  if (!result.success) {
    throw new MetaError('Invalid computer list response', { data });
  }
  return result.data;
}

/** Update a computer's remoteUser field. */
export async function updateComputerRemoteUser(
  computerId: string,
  remoteUser: string
): Promise<void> {
  await fetch(`/api/v0/computers/${encodeURIComponent(computerId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remoteUser }),
  });
}

interface RepairComputerHostIdParams {
  computerId: string;
  hostId: string;
}

/** Repair a missing backend computer hostId. The backend owns binding attribution. */
export async function repairComputerHostId({
  computerId,
  hostId,
}: RepairComputerHostIdParams): Promise<void> {
  await fetch(`/api/v0/computers/${encodeURIComponent(computerId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostId }),
  });
}

/** Delete a computer by ID. */
export async function deleteComputer(computerId: string): Promise<void> {
  await fetch(`/api/v0/computers/${encodeURIComponent(computerId)}`, {
    method: 'DELETE',
  });
}
