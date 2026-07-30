/**
 * The walking-skeleton document (T1).
 *
 * It reads nothing: T2 replaces this with the GSI1 Page render and T3 puts the
 * static route table in front of it. It exists so one request can travel the
 * whole real path — browser → CloudFront → OAC → Function URL → HTML.
 */
export interface SkeletonProps {
  path: string;
  stage: string;
}

export function Skeleton({ path, stage }: SkeletonProps) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>All-Links</title>
        <meta name="robots" content="noindex" />
        <style>{CSS}</style>
      </head>
      <body>
        <main>
          <h1>All-Links</h1>
          <p class="lede">
            The renderer is live in <strong>{stage}</strong>, reached through CloudFront over a
            Function URL locked to Origin Access Control.
          </p>
          <p class="path">
            You asked for <code>{path}</code>
          </p>
          <p class="note">Pages are not served from DynamoDB yet — that is T2.</p>
        </main>
      </body>
    </html>
  );
}

const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 2rem;
  font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 34rem; }
h1 { font-size: 1.75rem; letter-spacing: -0.02em; margin: 0 0 1rem; }
p { margin: 0 0 0.75rem; }
.lede { opacity: 0.85; }
.path code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
  padding: 0.15em 0.4em;
  border-radius: 0.3em;
  background: color-mix(in srgb, currentColor 10%, transparent);
}
.note { opacity: 0.6; font-size: 0.9em; }
`;
