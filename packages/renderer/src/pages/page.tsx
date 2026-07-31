import type { LinkItem, PageItem } from '@all-links/core';
import { themeById } from '@all-links/core';

import { Document } from './document.js';

export interface PageDocumentProps {
  page: PageItem;
  links: LinkItem[];
  /** The apex domain the abuse mailbox lives on (ADR-0010). */
  siteDomain: string;
}

/**
 * The public Page (spec §6.5).
 *
 * Every value here is user-supplied and reaches the document through JSX, so
 * it is escaped by construction rather than by remembering to escape it
 * (ADR-0006). `href`s are not user-supplied at all: a Link points at the click
 * redirector, never at its destination, so a `javascript:` URL has nowhere to
 * land on this surface.
 */
export function PageDocument({ page, links, siteDomain }: PageDocumentProps) {
  const name = displayNameOf(page);

  return (
    <Document title={pageTitle(page)} theme={themeById(page.themeId)} css={PAGE_CSS}>
      <main>
        <Avatar page={page} />
        <h1>{name}</h1>
        {page.bio ? <p class="bio">{page.bio}</p> : null}

        {links.length > 0 ? (
          <ul class="links">
            {links.map((link) => (
              <li key={link.linkId}>
                <a href={`/r/${page.username}/${link.linkId}`} rel="nofollow ugc noopener">
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </main>

      <footer>
        <a
          class="report"
          href={`mailto:abuse@${siteDomain}?subject=${encodeURIComponent(`Report: ${page.username}`)}`}
          rel="nofollow noopener"
        >
          Report this page
        </a>
      </footer>

      {/*
        The view pixel (spec §7). It is the second and last request a page view
        makes — and it filters bots for free, because crawlers and unfurlers
        fetch the document but not its inline images.
      */}
      <img
        class="px"
        src={`/px?u=${encodeURIComponent(page.username)}`}
        width={1}
        height={1}
        alt=""
        aria-hidden="true"
      />
    </Document>
  );
}

/**
 * An avatar-less Page is the common case — the minimum profile is
 * username-only — so it gets a themed monogram rather than a gap: a circle in
 * the Theme accent bearing the first character of the display name. Zero
 * bytes, zero requests, no `<img>`.
 *
 * Both branches occupy the same box, so the layout does not jump when an
 * avatar arrives later.
 */
function Avatar({ page }: { page: PageItem }) {
  if (page.avatarWebp) {
    return (
      <img
        class="avatar"
        src={`data:image/webp;base64,${page.avatarWebp}`}
        width={page.avatarW}
        height={page.avatarH}
        alt=""
        aria-hidden="true"
      />
    );
  }

  return (
    <div class="avatar monogram" aria-hidden="true">
      {monogram(page)}
    </div>
  );
}

/**
 * The first *character* — spread, not `charAt(0)`, so an emoji or an astral
 * script yields a whole glyph instead of half a surrogate pair.
 */
function monogram(page: PageItem): string {
  return [...displayNameOf(page)][0]?.toUpperCase() ?? '';
}

/**
 * `displayName` is required on a Page, but the item came off the wire as an
 * untyped attribute bag and the minimum profile is username-only — so an empty
 * one falls back rather than rendering a blank heading and a blank monogram.
 */
function displayNameOf(page: PageItem): string {
  return page.displayName?.trim() || page.username;
}

/**
 * ADR-0011 fixes the title as the display name, plus ` (@username)` **only
 * when the two differ** — so a Page that never set one is not titled
 * `jane (@jane)`. T6 reuses this for `og:title` and `twitter:title`, which
 * carry the same value.
 */
export function pageTitle(page: PageItem): string {
  const name = displayNameOf(page);

  return name === page.username ? name : `${name} (@${page.username})`;
}

const PAGE_CSS = `
.avatar{
width:6rem;
height:6rem;
border-radius:50%;
object-fit:cover;
display:block;
margin:0 auto 1.25rem;
background:var(--surface);
}
.monogram{
display:grid;
place-items:center;
background:var(--accent);
color:var(--on-accent);
font-size:2.5rem;
font-weight:600;
line-height:1;
user-select:none;
}
.bio{margin:0 auto 2rem;max-width:30rem;color:var(--muted)}
.links{list-style:none;margin:2rem 0 0;padding:0;display:grid;gap:0.75rem}
.links a{
display:block;
padding:0.9rem 1.25rem;
border-radius:0.75rem;
background:var(--surface);
color:var(--text);
text-decoration:none;
font-weight:500;
border:1px solid color-mix(in srgb,var(--accent) 25%,transparent);
}
.links a:hover,.links a:focus-visible{border-color:var(--accent)}
footer{margin-top:3rem;font-size:0.8125rem}
.report{color:var(--muted)}
.px{position:absolute;width:1px;height:1px;border:0}
`;
