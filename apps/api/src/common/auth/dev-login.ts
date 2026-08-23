/**
 * Whether the password-free developer door is open.
 *
 * TWO conditions, and both are environment rather than anything a running
 * system can be talked into changing. `NODE_ENV` alone would arm a full
 * authentication bypass in every checkout by default; the explicit flag alone
 * would leave a production image one stray env var away from the same. Needing
 * both means a production build cannot be opened at all, and a local one opens
 * only when somebody said so out loud.
 *
 * Read at import time by AppModule to decide whether the routes exist, and
 * again inside each handler — a route that grants a session without a password
 * is worth checking twice.
 */
export function devLoginEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.AVIORA_DEV_LOGIN === 'true';
}
