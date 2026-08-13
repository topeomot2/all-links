import type { Theme } from '@all-links/core';
import { themeVariables } from '@all-links/core';
import type { ComponentChildren } from 'preact';

import { SITE_NAME } from '../config.js';

/**
 * The shell every document the renderer emits shares.
 *
 * Self-contained by construction (ADR-0004): the only place CSS can enter is
 * the `css` prop, which is inlined, and there is no slot for a script at all.
 * Callers hand over a Theme and their own rules — assembling the stylesheet is
 * this component's job, so no caller can inline a Theme differently.
 */
export interface DocumentProps {
  title: string;
  theme: Theme;
  /** Rules layered over `BASE_CSS`, which is always present. */
  css: string;
  /** Omitted on a Page — Pages are `index,follow` (ADR-0011). */
  robots?: string;
  /**
   * The one URL this document wants to be known by (ADR-0011). Omitted on the
   * placeholders: they are `noindex`, and a 404 has no canonical form to point
   * at. T6 hangs the rest of the unfurl tags off the same value.
   */
  canonical?: string;
  /** Omitted where there is nothing worth sharing — every 404 body. */
  unfurl?: Unfurl;
  children: ComponentChildren;
}

/**
 * The preview card another app renders when this URL is pasted into it
 * (`CONTEXT.md` — Unfurl), in the shape ADR-0011 fixes.
 *
 * `twitter:card` is not a field: it is **always `summary`**, because the
 * brand card is square and an avatar is ≤256 px — below `summary_large_image`'s
 * minimum — so the card type never varies and no caller gets to vary it.
 */
export interface Unfurl {
  title: string;
  description: string;
  /** Absolute URL — a `data:` URI is not fetchable by an unfurler (ADR-0009). */
  image: string;
  /** `website` for a marketing page; `profile` for a Page (T6). */
  type: 'website' | 'profile';
}

export function Document({
  title,
  theme,
  css,
  robots,
  canonical,
  unfurl,
  children,
}: DocumentProps) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        {robots ? <meta name="robots" content={robots} /> : null}
        {canonical ? (
          <>
            <link rel="canonical" href={canonical} />
            <meta property="og:url" content={canonical} />
          </>
        ) : null}
        {unfurl ? <UnfurlTags unfurl={unfurl} /> : null}
        <Stylesheet css={`:root{${themeVariables(theme)}}${BASE_CSS}${css}`} />
      </head>
      <body>{children}</body>
    </html>
  );
}

/**
 * The inlined stylesheet, written raw.
 *
 * `<style>` is a raw-text element: a browser's CSS parser never decodes HTML
 * entities inside it. So JSX's escaping — right everywhere else in this
 * document — is wrong *here*: `"Segoe UI"` reaches the parser as
 * `&quot;Segoe UI&quot;`, which is not a valid font name, and CSS drops the
 * whole `font` shorthand it appears in. The rule silently does nothing.
 *
 * Raw is safe because nothing user-supplied can reach this string. Every
 * caller passes module constants, and the tokens come from a fixed Theme
 * table — which is exactly why `Document` assembles the stylesheet itself
 * rather than taking one from a caller.
 */
function Stylesheet({ css }: { css: string }) {
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

function UnfurlTags({ unfurl }: { unfurl: Unfurl }) {
  return (
    <>
      <meta property="og:type" content={unfurl.type} />
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:title" content={unfurl.title} />
      <meta property="og:description" content={unfurl.description} />
      <meta property="og:image" content={unfurl.image} />
      <meta name="twitter:card" content="summary" />
      <meta name="twitter:title" content={unfurl.title} />
      <meta name="twitter:description" content={unfurl.description} />
      <meta name="twitter:image" content={unfurl.image} />
    </>
  );
}

/**
 * Shared by every document. User-supplied text can be a single unbroken 30-
 * character run, so `overflow-wrap` is here rather than repeated per surface.
 */
const BASE_CSS = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
margin:0;
min-height:100vh;
padding:3rem 1.25rem;
display:flex;
flex-direction:column;
align-items:center;
font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
background:var(--background);
color:var(--text);
}
main{width:100%;max-width:34rem;text-align:center;flex:1}
h1{font-size:1.5rem;letter-spacing:-0.01em;margin:0 0 0.75rem}
h1,p,a{overflow-wrap:anywhere}
`;
