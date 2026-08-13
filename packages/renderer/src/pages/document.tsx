import type { Theme } from '@all-links/core';
import { themeVariables } from '@all-links/core';
import type { ComponentChildren } from 'preact';

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
  children: ComponentChildren;
}

export function Document({ title, theme, css, robots, canonical, children }: DocumentProps) {
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
        <style>{`:root{${themeVariables(theme)}}${BASE_CSS}${css}`}</style>
      </head>
      <body>{children}</body>
    </html>
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
