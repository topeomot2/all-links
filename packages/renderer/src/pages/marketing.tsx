import type { Theme } from '@all-links/core';
import { DASHBOARD_PATH } from '@all-links/core';
import type { ComponentChildren } from 'preact';

import { SITE_NAME } from '../config.js';
import { Document } from './document.js';

/**
 * The shell the three marketing pages share (ADR-0013).
 *
 * They are `index,follow` with their own unfurl pointing at the brand card,
 * which is the whole difference from a placeholder: these are pages we want
 * found and shared, and a Page's own tags are T6's.
 */
export interface MarketingDocumentProps {
  title: string;
  /** `og:description` — the sentence an unfurl of this page shows. */
  description: string;
  /** This document's one canonical URL. */
  canonical: string;
  /** Absolute URL of the brand card (ADR-0011). */
  cardUrl: string;
  /** Rules layered over the shared marketing stylesheet. */
  css?: string;
  children: ComponentChildren;
}

export function MarketingDocument({
  title,
  description,
  canonical,
  cardUrl,
  css = '',
  children,
}: MarketingDocumentProps) {
  return (
    <Document
      title={`${title} · ${SITE_NAME}`}
      theme={MARKETING_THEME}
      css={MARKETING_CSS + css}
      robots="index,follow"
      canonical={canonical}
      unfurl={{ title, description, image: cardUrl, type: 'website' }}
    >
      <header class="chrome">
        <a class="brand" href="/">
          {SITE_NAME}
        </a>
        <a class="chrome-cta" href={DASHBOARD_PATH}>
          Sign in
        </a>
      </header>

      {children}

      <footer class="chrome-footer">
        <a href="/terms">Terms</a>
        <a href="/privacy">Privacy</a>
      </footer>
    </Document>
  );
}

/**
 * Marketing's own tokens. **Marketing is not a Theme** (ADR-0013) — it is not
 * in `THEMES`, has no id a Page can select, and T4's preset redesign does not
 * reach it. Only the token *shape* is shared, so the shell inlines one
 * stylesheet the same way for every document the renderer emits.
 */
const MARKETING_THEME: Theme = {
  id: 'marketing',
  accent: '#4f46e5',
  onAccent: '#ffffff',
  background: '#0b0d12',
  surface: '#161a23',
  text: '#f3f4f6',
  muted: '#9ca3af',
};

/**
 * Wider than a Page and left-aligned: prose and a pricing table do not read in
 * a 34rem centred column.
 */
const MARKETING_CSS = `
body{padding:1.5rem 1.25rem 3rem}
main{max-width:44rem;text-align:left;margin:0 auto}
.chrome,.chrome-footer{
width:100%;
max-width:44rem;
margin:0 auto;
display:flex;
align-items:center;
gap:1.25rem;
}
.chrome{justify-content:space-between;padding-bottom:2.5rem}
.brand{color:var(--text);text-decoration:none;font-weight:700;letter-spacing:-0.02em}
.chrome-cta{color:var(--muted);text-decoration:none;font-size:0.9375rem}
.chrome-cta:hover{color:var(--text)}
.chrome-footer{margin-top:4rem;padding-top:1.5rem;font-size:0.875rem;
border-top:1px solid color-mix(in srgb,var(--muted) 25%,transparent)}
.chrome-footer a{color:var(--muted)}
h2{font-size:1.25rem;letter-spacing:-0.01em;margin:2.5rem 0 0.75rem}
p{margin:0 0 1rem;color:var(--muted)}
a{color:var(--text)}
.cta{
display:inline-block;
padding:0.85rem 1.6rem;
border-radius:0.75rem;
background:var(--accent);
color:var(--on-accent);
text-decoration:none;
font-weight:600;
}
`;
