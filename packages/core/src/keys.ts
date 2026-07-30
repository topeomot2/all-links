/**
 * Single-table key construction (ADR-0003).
 *
 * Every key in the table is built here and nowhere else, so the shape of the
 * table is one file rather than a convention spread across four Lambdas.
 */

/** Item-collection partition for everything an Account owns. */
const accountPk = (accountId: string): string => `ACCOUNT#${accountId}`;

/**
 * GSI1 partition for a Username. Usernames are lowercase-canonical
 * (ADR-0007), so the key builder canonicalises rather than trusting callers —
 * a `USERNAME#Jane` key would silently defeat uniqueness.
 */
const usernamePk = (username: string): string => `USERNAME#${username.toLowerCase()}`;

/** Account item — private. Deliberately carries no `GSI1PK`. */
export interface AccountKey {
  PK: string;
  SK: 'ACCOUNT';
}

export function accountKey(accountId: string): AccountKey {
  return { PK: accountPk(accountId), SK: 'ACCOUNT' };
}

/** Page item — public, sorts first within its Username on GSI1. */
export interface PageKey {
  PK: string;
  SK: 'PAGE';
  GSI1PK: string;
  GSI1SK: '0';
}

export function pageKey(accountId: string, username: string): PageKey {
  return {
    PK: accountPk(accountId),
    SK: 'PAGE',
    GSI1PK: usernamePk(username),
    GSI1SK: '0',
  };
}

/** Link item — public, sorts after the Page in fractional `rank` order. */
export interface LinkKey {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
}

export function linkKey(
  accountId: string,
  linkId: string,
  username: string,
  rank: string,
): LinkKey {
  return {
    PK: accountPk(accountId),
    SK: `LINK#${linkId}`,
    GSI1PK: usernamePk(username),
    GSI1SK: `1#${rank}`,
  };
}

/** Username item — uniqueness, and (once tombstoned) a runtime denylist entry. */
export interface UsernameKey {
  PK: string;
  SK: string;
}

export function usernameKey(username: string): UsernameKey {
  const pk = usernamePk(username);
  return { PK: pk, SK: pk };
}

/** The two OTP-send windows throttled per email hash (ADR-0010, spec §11.4). */
export type OtpWindow = 'hour' | 'day';

/** OTP throttle item — private, TTL'd. Deliberately carries no `GSI1PK`. */
export interface OtpThrottleKey {
  PK: string;
  SK: string;
}

export function otpThrottleKey(emailHash: string, window: OtpWindow): OtpThrottleKey {
  return { PK: `OTP#${emailHash}`, SK: `WINDOW#${window}` };
}

/**
 * Partition key for the one query the public read path runs:
 * `Query GSI1 where GSI1PK = USERNAME#<name>` → Page, then Links in rank order.
 */
export function usernameIndexKey(username: string): { GSI1PK: string } {
  return { GSI1PK: usernamePk(username) };
}
