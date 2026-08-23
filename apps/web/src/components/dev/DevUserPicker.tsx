'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';

/** One account the API is willing to hand a session for, without a password. */
interface DevUser {
  id: string;
  email: string;
  displayName: string | null;
  platformRole: string | null;
  tenants: string[];
}

interface DevUsersResponse {
  users: DevUser[];
}

interface DevUserPickerProps {
  /** Runs after the session cookies are set, with the same routing the form uses. */
  onSignedIn: () => Promise<void> | void;
}

/**
 * Sign in as anybody, in development, by clicking their name.
 *
 * Deliberately silent when it cannot work. The API only serves `/dev/users`
 * when its own flag is on, so a failed first fetch means "not enabled here" —
 * and the honest response to that is to render nothing at all, rather than an
 * empty panel or an error a developer has to learn to ignore. The whole
 * component is also behind a `NODE_ENV` check at its call site, so a production
 * bundle never contains the request in the first place.
 */
export function DevUserPicker({ onSignedIn }: DevUserPickerProps) {
  const [available, setAvailable] = useState(true);
  const [users, setUsers] = useState<DevUser[] | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // A pause before searching: the list is a database query, and firing one
    // per keystroke makes the results race each other back.
    const timer = setTimeout(
      () => {
        const suffix = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
        api
          .get<DevUsersResponse>(`/dev/users${suffix}`)
          .then((res) => {
            if (!cancelled) setUsers(res.users);
          })
          .catch(() => {
            if (!cancelled) setAvailable(false);
          });
      },
      query ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  if (!available) return null;

  const signInAs = async (user: DevUser) => {
    setError(null);
    setBusy(user.id);
    try {
      await api.post('/dev/login', { userId: user.id });
      await onSignedIn();
    } catch {
      setError(`Could not sign in as ${user.email}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-xl border border-dashed border-amber-400 bg-amber-50/60 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-amber-900">Dev sign-in</h2>
        <span className="text-xs text-amber-700">no password — local only</span>
      </div>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter by email or name"
        aria-label="Filter dev users"
        className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500"
      />

      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}

      {users === null ? (
        <p className="mt-2 text-xs text-amber-700">Loading accounts…</p>
      ) : users.length === 0 ? (
        <p className="mt-2 text-xs text-amber-700">No account matches that.</p>
      ) : (
        <ul className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto">
          {users.map((user) => (
            <li key={user.id}>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void signInAs(user)}
                className="w-full rounded-lg border border-transparent px-2 py-1.5 text-left hover:border-amber-400 hover:bg-white disabled:opacity-50"
              >
                <span className="block text-sm font-medium text-slate-800">
                  {user.displayName ?? user.email}
                  {busy === user.id ? ' …' : ''}
                </span>
                <span className="block text-xs text-slate-500">
                  {user.email}
                  {user.platformRole ? ` · ${user.platformRole}` : ''}
                  {user.tenants.length ? ` · ${user.tenants.join(', ')}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
