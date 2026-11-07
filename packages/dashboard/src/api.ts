import { AUTH_HEADER, type MeResponse } from '@all-links/core/api-contract';

import type { Session } from './session.js';

export class SignedOutError extends Error {
  constructor() {
    super('signed out');
    this.name = 'SignedOutError';
  }
}

/**
 * Page state is read through the api, never from the cached public URL, so an
 * edit shows here at once while the public Page lags by up to 60 s (ADR-0006).
 */
export function createApi(session: Session, fetchImpl: typeof fetch = fetch.bind(globalThis)) {
  async function get<T>(path: string): Promise<T> {
    const token = await session.accessToken();
    if (!token) throw new SignedOutError();

    const res = await fetchImpl(path, {
      headers: { [AUTH_HEADER]: `Bearer ${token}` },
      // A header, never a cookie (ADR-0004) — so send none.
      credentials: 'omit',
      cache: 'no-store',
    });
    if (res.status === 401) {
      session.clear();
      throw new SignedOutError();
    }
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);

    return (await res.json()) as T;
  }

  return {
    me: () => get<MeResponse>('/api/me'),
  };
}

export type Api = ReturnType<typeof createApi>;

/**
 * Where a signed-in Account belongs (spec §6.1), decided on `active` — the
 * Page's mirrored Subscription state — not on whether a Page exists:
 *
 * - active → the dashboard (a suspended Page still lands here, to be told so)
 * - inactive, holding a Username or a lapsed Page → resume checkout; within
 *   the 30-day lapse window reactivation is one payment (ADR-0002)
 * - inactive with neither → the claim
 *
 * The reclaimed-hold notice needs the claim's own state and arrives with T9;
 * until then a reclaimed hold reads as "no Username" and lands on the claim.
 */
export type NextStep = 'dashboard' | 'claim' | 'checkout';

export function nextStep(me: MeResponse): NextStep {
  if (me.page?.active) return 'dashboard';
  if (me.page || me.account.heldUsername) return 'checkout';
  return 'claim';
}

/** The Username checkout would be for — a held one, or a lapsed Page's. */
export function checkoutUsername(me: MeResponse): string | undefined {
  return me.account.heldUsername ?? me.page?.username;
}
