import { ErrorResponse, RequestOptions } from '@industry/common/api/shared';
import { ACTIVE_ORGANIZATION_HEADER } from '@industry/drool-sdk-ext/protocol/drool';
import { MetaError } from '@industry/logging/errors';
import * as runtimeAuth from '@industry/runtime/auth';
import { ApiError, ApiResponse } from '@industry/utils/api';

import type { RuntimeAuthConfig } from '@industry/runtime/auth';

/**
 * Industry API client for daemon service
 * Provides type-safe HTTP requests to Industry backend services
 */
export class IndustryApiClient {
  private readonly runtimeAuthConfig: RuntimeAuthConfig;

  constructor(runtimeAuthConfig: RuntimeAuthConfig) {
    this.runtimeAuthConfig = runtimeAuthConfig;
  }

  getRuntimeAuthConfig(): RuntimeAuthConfig {
    return this.runtimeAuthConfig;
  }

  /**
   * Makes an authenticated HTTP request with full type safety
   * @param endpoint - API endpoint path (e.g., '/api/daemon/status')
   * @param options - Request options including method, headers, and typed body
   * @returns Promise resolving to typed ApiResponse
   */
  async request<TResponse, TRequest = unknown>(
    endpoint: string,
    options: RequestOptions<TRequest> = {}
  ): Promise<ApiResponse<TResponse>> {
    const { method, headers = {}, body } = options;

    const token = await runtimeAuth.getAuthToken(this.runtimeAuthConfig);
    if (!token) {
      throw new MetaError('Daemon not authenticated');
    }

    const defaultHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
    const activeOrganizationId =
      (await runtimeAuth.getActiveOrganizationId?.(this.runtimeAuthConfig)) ??
      null;
    if (activeOrganizationId) {
      defaultHeaders[ACTIVE_ORGANIZATION_HEADER] = activeOrganizationId;
    }

    const region = await runtimeAuth.getRegion(this.runtimeAuthConfig);
    const baseUrl = runtimeAuth.resolveCliApiBaseUrl(
      this.runtimeAuthConfig,
      region
    );
    const url = `${baseUrl}${endpoint}`;

    // Serialize body if provided
    const requestBody = body !== undefined ? JSON.stringify(body) : undefined;

    try {
      const response = await fetch(url, {
        method,
        headers: {
          ...defaultHeaders,
          ...headers,
        },
        ...(requestBody && { body: requestBody }),
      });

      if (!response.ok) {
        const errorResponse =
          await ApiResponse.fromResponse<ErrorResponse>(response);

        const errorMessage = errorResponse.data.detail;

        throw new ApiError(errorMessage, errorResponse);
      }

      // Parse success response
      const apiResponse = await ApiResponse.fromResponse<TResponse>(response);

      return apiResponse;
    } catch (error) {
      throw new MetaError('Network error', { cause: error });
    }
  }

  /**
   * Convenience method for GET requests
   */
  async get<TResponse>(
    endpoint: string,
    headers?: HeadersInit
  ): Promise<ApiResponse<TResponse>> {
    return this.request<TResponse>(endpoint, {
      method: 'GET',
      headers,
    });
  }

  /**
   * Convenience method for POST requests with typed body
   */
  async post<TResponse, TRequest = unknown>(
    endpoint: string,
    body: TRequest,
    headers?: HeadersInit
  ): Promise<ApiResponse<TResponse>> {
    return this.request<TResponse, TRequest>(endpoint, {
      method: 'POST',
      body,
      headers,
    });
  }

  /**
   * Convenience method for PUT requests with typed body
   */
  async put<TResponse, TRequest = unknown>(
    endpoint: string,
    body: TRequest,
    headers?: HeadersInit
  ): Promise<ApiResponse<TResponse>> {
    return this.request<TResponse, TRequest>(endpoint, {
      method: 'PUT',
      body,
      headers,
    });
  }

  /**
   * Convenience method for PATCH requests with typed body
   */
  async patch<TResponse, TRequest = unknown>(
    endpoint: string,
    body: TRequest,
    headers?: HeadersInit
  ): Promise<ApiResponse<TResponse>> {
    return this.request<TResponse, TRequest>(endpoint, {
      method: 'PATCH',
      body,
      headers,
    });
  }

  /**
   * Convenience method for DELETE requests
   */
  async delete<TResponse>(
    endpoint: string,
    headers?: HeadersInit
  ): Promise<ApiResponse<TResponse>> {
    return this.request<TResponse>(endpoint, {
      method: 'DELETE',
      headers,
    });
  }
}

// Global memoized API client instance
let apiClientInstance: IndustryApiClient | undefined;

export function initializeApiClient(
  runtimeAuthConfig: RuntimeAuthConfig
): IndustryApiClient {
  apiClientInstance = new IndustryApiClient(runtimeAuthConfig);
  return apiClientInstance;
}

/**
 * Get the global API client instance.
 * Returns undefined if not initialized (caller should handle gracefully).
 */
export function getApiClient(): IndustryApiClient | undefined {
  return apiClientInstance;
}
