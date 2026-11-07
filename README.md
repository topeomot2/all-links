# All-Links

A cheap, serverless "link in bio" product: each Account has one public Page at
`linkix.io/<username>` listing a creator's Links.

- **Vocabulary:** [`CONTEXT.md`](CONTEXT.md) — read this before naming anything.
- **What we're building:** [`docs/spec/v1-mvp-spec.md`](docs/spec/v1-mvp-spec.md).
- **Why it's built this way:** [`docs/adr/`](docs/adr/).

## Layout

```
packages/
  core/        domain types, key construction, the public read path,
                 username rules + reserved names, Themes
  renderer/    Lambda — HTML for every public path      (CloudFront default behavior)
  api/         Lambda — /api/* (Hono, in-process Cognito JWT check),
                 plus the Cognito post-confirmation trigger
  counter/     Lambda — /px views, /r/* click redirects (T5)
  dashboard/   React + Vite SPA — email OTP sign-in     (/app/*)
infra/         AWS CDK app — table, user pool, Lambdas, one distribution, budget
tools/         local dev server, deployment verification
```

npm workspaces, no Turborepo/Nx (ADR-0006). `core` is consumed as TypeScript
source — there is no build step between packages.

## Requirements

Node 22 (Vite wants 22.12+), npm 10+, and AWS credentials for anything that
touches a stack. There is **no fully offline mode**: data comes from a real
on-demand DynamoDB table in the dev stack, not DynamoDB Local, because the
model leans on GSI1 query behavior, atomic counters and conditional writes —
exactly what an emulator is least trustworthy about (ADR-0006).

## Everyday commands

```bash
npm install
npm test           # vitest — core, renderer, and the synthesized CDK templates
npm run typecheck  # tsc over every package
npm run synth      # both stacks; needs no AWS credentials
```

## The two dev loops

**Local, for handler logic.** A thin Node server imports the three handlers
directly — no Docker, no Lambda emulator. Reload is milliseconds.

```bash
npm run dev:server                    # handlers on :3000
npm run dev                           # dashboard on :5173, proxying to :3000
```

Vite serves `/app/*` itself and proxies everything else to the handler server —
the same split the distribution makes at the edge. Export `TABLE_NAME` (the dev
stack's table) and have AWS credentials in the shell — the renderer reads every
Page from it, so without them a Page request is a 500.

The api also needs the dev stack's pool — export `USER_POOL_ID` and
`USER_POOL_CLIENT_ID` from its outputs. The dashboard reads the same values at
boot from `/app/config.json`, which the stack writes when deployed; locally,
create the gitignored `packages/dashboard/public/config.json`:

```json
{ "region": "us-east-1", "userPoolId": "<UserPoolId>", "userPoolClientId": "<UserPoolClientId>" }
```

Sign-in then runs against the real dev pool, and the post-confirmation trigger
writes the Account to the real dev table. Until SES is wired (P3), Cognito
sends the codes itself, capped at 50 emails a day per account.

Nothing seeds a Page yet (that is T12's billing flow), so to see a real render
put a Page item and a few Links in the dev table by hand — `PK=ACCOUNT#<id>`,
`SK=PAGE`, `GSI1PK=USERNAME#<name>`, `GSI1SK=0`, with `active: true`.

**Deployed, for edge behavior.** Caching, TTLs and OAC are only ever real in
the deployed dev stack. `cdk watch` hotswaps Lambda code in ~5–10 s:

```bash
npm run watch:dev
```

The local loop deliberately does not simulate CloudFront: a 60-second edge TTL
is not something an emulator tells the truth about.

## Deploying

See [`infra/README.md`](infra/README.md) — first deploy, the GitHub Actions
OIDC role, and `tools/verify-deployment.sh`.

## Known advisories

`npm audit` reports one high-severity finding in `brace-expansion`, reached
through the `minimatch` that **aws-cdk-lib bundles**. It cannot be overridden
from here and is not on any runtime path — it is used by CDK's globbing at
synth time. It clears when aws-cdk-lib ships an updated bundle.
