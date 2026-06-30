import { logWarn } from '@industry/logging';

/**
 * API response wrapper with metadata
 * Provides structured access to response data, status, headers, and request tracking
 */
export class ApiResponse<TData = unknown> {
  readonly url: string;

  readonly status: number;

  readonly statusText: string;

  readonly ok: boolean;

  readonly headers: Headers;

  readonly vercelId?: string;

  readonly body: string;

  readonly data: TData;

  constructor(
    url: string,
    status: number,
    statusText: string,
    headers: Headers,
    vercelId: string | undefined,
    body: string,
    data: TData
  ) {
    this.url = url;
    this.status = status;
    this.statusText = statusText;
    this.ok = status >= 200 && status < 300;
    this.headers = headers;
    this.vercelId = vercelId;
    this.body = body;
    this.data = data;
  }

  getHeader(name: string): string | null {
    return this.headers.get(name);
  }

  hasHeader(name: string): boolean {
    return this.headers.has(name);
  }

  toJSON() {
    const headersObj: Record<string, string> = {};
    this.headers.forEach((value, key) => {
      headersObj[key] = value;
    });

    return {
      url: this.url,
      status: this.status,
      statusText: this.statusText,
      ok: this.ok,
      headers: headersObj,
      vercelId: this.vercelId,
      body: this.body,
      data: this.data,
    };
  }

  static async fromResponse<T = unknown>(
    response: Response
  ): Promise<ApiResponse<T>> {
    const body = await response.text();
    let data: T;

    try {
      data = body ? (JSON.parse(body) as T) : ({} as T);
    } catch (err) {
      logWarn('Failed to parse API response body as JSON', { cause: err });
      data = body as T;
    }

    return new ApiResponse<T>(
      response.url,
      response.status,
      response.statusText,
      response.headers,
      response.headers.get('x-vercel-id') || undefined,
      body,
      data
    );
  }
}
