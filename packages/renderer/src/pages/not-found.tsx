import { DEFAULT_THEME_ID, themeById } from '@all-links/core';
import type { VNode } from 'preact';

import { Document } from './document.js';

/**
 * Why there is no Page at this address (spec §6.6). Every one of these is a
 * 404 at the same freshness as a live Page, so a freshly claimed Username goes
 * live within 60 seconds.
 */
export type NotFoundReason =
  /** No Page under a claimable Username — an acquisition funnel, not a dead end. */
  | 'unclaimed'
  /**
   * The Page exists but the visibility gate closed it. Lapsed and suspended
   * share this body deliberately: the lapsed copy must never out a creator as
   * unpaid, and the suspended copy must not confirm a takedown.
   */
  | 'inactive'
  /** A Reserved name. Honest, and not for sale. */
  | 'reserved'
  /** A path that could never be a Username at all. */
  | 'unknown';

export interface NotFoundDocumentProps {
  reason: NotFoundReason;
  /** Only ever set when the path *was* a well-formed Username. */
  username?: string;
}

export function NotFoundDocument({ reason, username }: NotFoundDocumentProps) {
  // A placeholder is not a Page, so it gets the default Theme rather than a
  // creator's — there is no creator here to have chosen one.
  //
  // `noindex` on every placeholder (ADR-0011). The 404 already keeps them out
  // of most indexes; the tag also covers the suspended case, which ADR-0010
  // invalidates precisely so it stops being served.
  return (
    <Document
      title={TITLES[reason]}
      theme={themeById(DEFAULT_THEME_ID)}
      css={NOT_FOUND_CSS}
      robots="noindex"
    >
      <main>{BODIES[reason](username ?? '')}</main>
    </Document>
  );
}

const TITLES: Record<NotFoundReason, string> = {
  unclaimed: 'This name is available',
  inactive: 'This page isn’t active',
  reserved: 'This name is reserved',
  unknown: 'Not found',
};

const BODIES: Record<NotFoundReason, (username: string) => VNode> = {
  unclaimed: (username) => (
    <>
      <h1>
        <span class="handle">/{username}</span> is available
      </h1>
      <p>Nobody has claimed this name yet. One page, all your links, at this address.</p>
      <p>
        <a class="cta" href="/app/">
          Claim /{username}
        </a>
      </p>
    </>
  ),

  inactive: () => (
    <>
      <h1>This page isn’t active</h1>
      <p>There is nothing to show here right now.</p>
    </>
  ),

  reserved: (username) => (
    <>
      <h1>This name is reserved</h1>
      <p>
        <span class="handle">/{username}</span> is not available to claim.
      </p>
    </>
  ),

  unknown: () => (
    <>
      <h1>Not found</h1>
      <p>There is no page at this address.</p>
    </>
  ),
};

const NOT_FOUND_CSS = `
main{margin-top:4rem}
p{margin:0 0 1rem;color:var(--muted)}
.handle{color:var(--text);font-weight:600}
.cta{
display:inline-block;
margin-top:0.5rem;
padding:0.8rem 1.5rem;
border-radius:0.75rem;
background:var(--accent);
color:var(--on-accent);
text-decoration:none;
font-weight:600;
}
`;
