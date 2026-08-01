/**
 * Domain types for the five item types in the single table (ADR-0003, as
 * amended by ADR-0009 / 0010 / 0011 / 0012). Vocabulary is `CONTEXT.md`'s.
 */
import type { AccountKey, LinkKey, OtpThrottleKey, PageKey, UsernameKey } from './keys.js';

/** Subscription lifecycle as reported by the merchant of record (ADR-0002). */
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled';

export type Plan = 'annual' | 'monthly';

/** The billing block on the Account item. Never leaves the private read path. */
export interface Subscription {
  status: SubscriptionStatus;
  plan: Plan;
  /** ISO-8601. */
  trialEnd?: string;
  /** ISO-8601. */
  currentPeriodEnd?: string;
  morCustomerId?: string;
  morSubscriptionId?: string;
}

/**
 * The authenticated, billable entity. `accountId` is the Cognito `sub`
 * (ADR-0005), which is why it must never appear in a public URL.
 *
 * Structurally private: an Account item has no `GSI1PK`, so it cannot be
 * reached from the public index at all.
 */
export interface AccountItem extends AccountKey {
  accountId: string;
  email: string;
  subscription?: Subscription;
  /** ISO-8601 — enforces the once-per-30-days rename limit (ADR-0007). */
  lastRenamedAt?: string;
  /** The one Username this Account holds; delete-on-reclaim keeps it single. */
  heldUsername?: string;
}

/** The public artifact at `linkix.io/<username>`. */
export interface PageItem extends PageKey {
  accountId: string;
  username: string;
  displayName: string;
  /** ≤160 characters, capped at the API to match `og:description` (ADR-0011). */
  bio?: string;
  /** ≤24 KB WebP, base64, inlined by the renderer as a `data:` URI (ADR-0009). */
  avatarWebp?: string;
  /** Intrinsic avatar dimensions, so the layout cannot shift (ADR-0011). */
  avatarW?: number;
  avatarH?: number;
  themeId: string;
  /** Atomic `ADD`; lifetime, monotonic, approximate (ADR-0008). */
  pageViewCount?: number;
  /** Mirrored Subscription visibility, written by the billing webhook. */
  active: boolean;
  /**
   * ISO-8601; absent means not suspended. Moderation state only — the billing
   * webhook must never write it (ADR-0010).
   */
  suspendedAt?: string;
}

/** An ordered, labeled destination on a Page. */
export interface LinkItem extends LinkKey {
  linkId: string;
  label: string;
  url: string;
  /** Fractional index — a reorder is one write (ADR-0003). */
  rank: string;
  /** Atomic `ADD`. */
  clickCount?: number;
}

/**
 * A Username record. Degenerates from an account record into a denylist entry
 * when tombstoned: `ownerAccountId` is removed and `tombstonedAt` survives the
 * Account's erasure (ADR-0012).
 */
export interface UsernameItem extends UsernameKey {
  username: string;
  ownerAccountId?: string;
  /** ISO-8601 — the 7-day hold window is measured from here (ADR-0007). */
  claimedAt?: string;
  /** ISO-8601 — set by a Suspension; the Username stays unclaimable (ADR-0012). */
  tombstonedAt?: string;
}

/** OTP-send throttle: 5/hour, 20/day per email hash (ADR-0010, spec §11.4). */
export interface OtpThrottleItem extends OtpThrottleKey {
  /** Atomic `ADD`. */
  count: number;
  /** Unix seconds — the DynamoDB TTL attribute. */
  expiresAt: number;
}

export type Item = AccountItem | PageItem | LinkItem | UsernameItem | OtpThrottleItem;

/**
 * The non-key attributes GSI1 projects — public attributes only. `infra`
 * builds the index's `INCLUDE` projection from exactly this list, so private
 * attributes (`email`, `subscription`, `heldUsername`) are unreachable from
 * the public index by construction rather than by review.
 */
export const GSI1_PROJECTED_ATTRIBUTES = [
  // Page. `accountId` is projected explicitly even though `PK` carries it:
  // `/px` and `/r/*` resolve the owning Account from this one query (spec §7),
  // and reading an attribute beats parsing a key at three call sites.
  'accountId',
  'username',
  'displayName',
  'bio',
  'avatarWebp',
  'avatarW',
  'avatarH',
  'themeId',
  'pageViewCount',
  'active',
  'suspendedAt',
  // Link
  'linkId',
  'label',
  'url',
  'rank',
  'clickCount',
] as const satisfies readonly string[];
