/**
 * The dashboard's session: a short access token in memory and a long refresh
 * token in `localStorage` (ADR-0005's ~60 days). Never a cookie — the public
 * default behavior forwards none, and a dashboard session must not be able to
 * fragment the public cache (ADR-0004).
 */
import type { Cognito, Tokens } from './cognito.js';

const REFRESH_KEY = 'all-links.refreshToken';
/** Refresh this long before expiry, so a request never races the clock. */
const SKEW_SECONDS = 60;

export interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Seconds since the epoch at which a JWT expires, or 0 if unreadable. */
export function tokenExpiry(jwt: string): number {
  try {
    const payload = jwt.split('.')[1] ?? '';
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp : 0;
  } catch {
    return 0;
  }
}

export function createSession(
  cognito: Cognito,
  storage: Storage,
  now: () => number = () => Date.now() / 1000,
) {
  let accessToken: string | undefined;

  const safe = <T>(fn: () => T, fallback: T): T => {
    // Private windows and blocked site data make storage throw.
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  return {
    hasSession(): boolean {
      return Boolean(accessToken ?? safe(() => storage.getItem(REFRESH_KEY), null));
    },

    store(tokens: Tokens): void {
      accessToken = tokens.accessToken;
      if (tokens.refreshToken) {
        const refresh = tokens.refreshToken;
        safe(() => storage.setItem(REFRESH_KEY, refresh), undefined);
      }
    },

    /** A valid access token, refreshed if needed; `undefined` once signed out. */
    async accessToken(): Promise<string | undefined> {
      if (accessToken && tokenExpiry(accessToken) - SKEW_SECONDS > now()) return accessToken;

      const refresh = safe(() => storage.getItem(REFRESH_KEY), null);
      if (!refresh) return undefined;

      try {
        const tokens = await cognito.refresh(refresh);
        accessToken = tokens.accessToken;
        return accessToken;
      } catch {
        // Expired or revoked: the only way back is a fresh OTP.
        this.clear();
        return undefined;
      }
    },

    async signOut(): Promise<void> {
      const refresh = safe(() => storage.getItem(REFRESH_KEY), null);
      this.clear();
      if (refresh) await cognito.revoke(refresh).catch(() => undefined);
    },

    clear(): void {
      accessToken = undefined;
      safe(() => storage.removeItem(REFRESH_KEY), undefined);
    },
  };
}

export type Session = ReturnType<typeof createSession>;
