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

/**
 * True when the refusal is "your membership plan does not include this", not
 * "you may not do this". Both arrive as 403, but they mean different things to
 * a member and deserve different wording.
 */
export function isEntitlementRequired(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'ENTITLEMENT_REQUIRED';
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
  /**
   * For a page that must render for a SIGNED-OUT reader — the legal documents
   * are public by contract (docs/29 §6). A 401 there is an answer ("nobody is
   * signed in"), not an interruption, so it is thrown rather than turned into a
   * redirect that would eject an anonymous visitor from a terms page. The
   * refresh attempt still happens first, so a signed-in member with a stale
   * access token is renewed exactly as everywhere else.
   */
  anonymousOk?: boolean;
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
        if (!options.anonymousOk) redirectToSignIn();
        throw await toApiError(res);
      }
    } else {
      if (!options.anonymousOk) redirectToSignIn();
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
  /**
   * A GET whose 401 means "nobody is signed in" and must be handled by the
   * caller instead of redirecting. Used by pages that a signed-out reader is
   * entitled to see.
   */
  getAnonymousOk: <T>(path: string): Promise<T> => apiFetch<T>(path, { anonymousOk: true }),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    apiFetch<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown): Promise<T> => apiFetch<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown): Promise<T> =>
    apiFetch<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string): Promise<T> => apiFetch<T>(path, { method: 'DELETE' }),
};

/** One field-level complaint from the API's validator. */
export interface ValidationIssue {
  /** Dotted path into the request body, e.g. `supportedLocales.1`. */
  path: string;
  message: string;
}

/**
 * The per-field reasons behind a VALIDATION_FAILED response.
 *
 * The API says exactly which field it refused and why ("defaultLocale must be
 * one of supportedLocales"), and throwing that away in favour of a generic
 * "something went wrong" turns a fixable mistake into a guessing game.
 */
export function validationIssues(err: unknown): ValidationIssue[] {
  if (!(err instanceof ApiError) || !Array.isArray(err.details)) return [];
  return (err.details as unknown[]).flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.message !== 'string') return [];
    return [{ path: typeof row.path === 'string' ? row.path : '', message: row.message }];
  });
}

/** The message for one field, when the API named that field. */
export function issueFor(issues: readonly ValidationIssue[], field: string): string | undefined {
  return issues.find((issue) => issue.path === field || issue.path.startsWith(`${field}.`))
    ?.message;
}
