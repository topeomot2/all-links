import type { ComponentChildren } from 'preact';

/**
 * The shell every document the renderer emits shares.
 *
 * Self-contained by construction (ADR-0004): the only place CSS can enter is
 * the `css` prop, which is inlined, and there is no slot for a script at all.
 */
export interface DocumentProps {
  title: string;
  css: string;
  /** Omitted on a Page — Pages are `index,follow` (ADR-0011). */
  robots?: string;
  children: ComponentChildren;
}

export function Document({ title, css, robots, children }: DocumentProps) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        {robots ? <meta name="robots" content={robots} /> : null}
        <style>{css}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}

/** Shared by every document, above whatever the Theme or the placeholder adds. */
export const BASE_CSS = `
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
`;
