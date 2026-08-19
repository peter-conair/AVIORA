/**
 * API error codes for the standard envelope:
 *   { "error": { "code", "message", "details", "request_id" } }
 * (docs/10-api-design.md)
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  TENANT_NOT_RESOLVED: 'TENANT_NOT_RESOLVED',
  TENANT_MISMATCH: 'TENANT_MISMATCH',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  ENTITLEMENT_REQUIRED: 'ENTITLEMENT_REQUIRED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    request_id: string;
  };
}
