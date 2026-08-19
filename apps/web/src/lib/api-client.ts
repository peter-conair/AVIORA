export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3021/api/v1';

export const TENANT_STORAGE_KEY = 'aviora.tenantId';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** True when the error means "out of the caller's authorized scope". */
export function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 403 || err.code === 'FORBIDDEN');
}

export function getTenantId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TENANT_STORAGE_KEY);
}

export function setTenantId(tenantId: string | null): void {
  if (typeof window === 'undefined') return;
  if (tenantId) {
    window.localStorage.setItem(TENANT_STORAGE_KEY, tenantId);
  } else {
    window.localStorage.removeItem(TENANT_STORAGE_KEY);
  }
}

function isPublicPage(): boolean {
  if (typeof window === 'undefined') return true;
  const path = window.location.pathname;
  return path.includes('/sign-in') || path.includes('/invite/');
}

function redirectToSignIn(): void {
  if (typeof window === 'undefined') return;
  const first = window.location.pathname.split('/')[1];
  const locale = first === 'en' || first === 'th' ? first : 'th';
  window.location.assign(`/${locale}/sign-in`);
}

interface FetchOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
}

/** The locale segment of the current URL (/th/..., /en/...) — '' on the server. */
function currentLocale(): string {
  if (typeof window === 'undefined') return '';
  const segment = window.location.pathname.split('/')[1] ?? '';
  return segment === 'th' || segment === 'en' ? segment : '';
}

async function rawRequest(path: string, options: FetchOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const tenantId = getTenantId();
  if (tenantId) headers['X-Tenant-ID'] = tenantId;
  // Server-side content (knowledge, AI answers) is localised by the API, so the
  // active UI locale has to travel with every request.
  const locale = currentLocale();
  if (locale) headers['Accept-Language'] = locale;

  return fetch(`${API_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    credentials: 'include',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const data = (await res.json()) as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    return new ApiError(
      res.status,
      data.error?.code ?? 'UNKNOWN',
      data.error?.message ?? res.statusText,
      data.error?.details,
    );
  } catch {
    return new ApiError(res.status, 'UNKNOWN', res.statusText || 'Request failed');
  }
}

async function parseBody<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** Paths that must never trigger a token-refresh retry. */
const NO_REFRESH_PATHS = ['/auth/login', '/auth/refresh', '/auth/logout'];

export async function apiFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  let res = await rawRequest(path, options);

  if (res.status === 401 && !NO_REFRESH_PATHS.includes(path)) {
    if (isPublicPage()) {
      throw await toApiError(res);
    }
    // Attempt exactly one refresh, then retry once.
    const refreshRes = await rawRequest('/auth/refresh', { method: 'POST' });
    if (refreshRes.ok) {
      res = await rawRequest(path, options);
      if (res.status === 401) {
        redirectToSignIn();
        throw await toApiError(res);
      }
    } else {
      redirectToSignIn();
      throw await toApiError(res);
    }
  }

  if (!res.ok) {
    throw await toApiError(res);
  }

  return parseBody<T>(res);
}

export const api = {
  get: <T>(path: string): Promise<T> => apiFetch<T>(path),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    apiFetch<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown): Promise<T> =>
    apiFetch<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string): Promise<T> => apiFetch<T>(path, { method: 'DELETE' }),
};
