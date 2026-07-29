---
status: accepted
---

# ADR-0006 — App framework, API front door, and IaC

- **Date:** 2026-07-29
- **Decision ticket:** [A5 — App framework + IaC/deployment tooling](https://github.com/topeomot2/all-links/issues/10)
- **Builds on:** ADR-0001 (AWS serverless), ADR-0003 (single-table data model), ADR-0004 (serving architecture), ADR-0005 (auth)
- **Amends:** ADR-0004 (the `/app/*` row of the routing table — see below)
- **Vocabulary:** see `CONTEXT.md` (Account, Page, Link, Username, Theme, Subscription)

## Context

The ticket framed this as "Next.js full-stack vs static frontend + separate Lambda API". But ADR-0004 had already decided most of it: the public Page is rendered by a **Lambda emitting a self-contained HTML document with no framework runtime, working with JavaScript disabled**, behind **one hand-specified CloudFront distribution with five path behaviors and distinct cache policies**.

That inverts the usual calculus. A meta-framework's value is that it *provides* routing, caching, and a server runtime — here those are already fixed by ADR-0004, so a framework would be an adapter layer arguing with them (its own router and cache inside CloudFront's, its own bundle in the hot path). The genuinely open questions were therefore the **dashboard**, the **API front door** (explicitly deferred by ADR-0001), the **IaC**, and the **local dev loop**.

Two standing constraints shaped every answer: a solo founder chosen for AWS fluency (ADR-0001's deciding tiebreaker), and a revenue ceiling of ~$1.67/mo per Account that rules out fixed floor costs.

## Decision

### No meta-framework — three small Lambdas plus a client

```
packages/
  renderer/    Lambda — GSI1 query → self-contained HTML   (default behavior)
  api/         Lambda — /api/* CRUD + billing webhooks
  counter/     Lambda — /px view & click counting          (mechanism: A4)
  dashboard/   React + Vite SPA → static assets            (/app/*)
  core/        shared TS — data access, domain types, theme definitions
infra/         AWS CDK app — one distribution, five behaviors
```

No Next.js, Remix, or Astro. Each Lambda is a plain TypeScript handler; `core` holds the single-table access code (ADR-0003) and the domain types both the renderer and the API depend on, so the public and private paths cannot drift apart.

### Renderer: Preact `render-to-string`

The renderer builds HTML with **JSX rendered server-side via `preact-render-to-string`**, shipping **no client runtime** — satisfying ADR-0004's self-contained, JS-off document.

The deciding factor was **escaping**. Display name, bio, and Link labels are user-supplied and interpolated straight into a public document; JSX auto-escapes by default, whereas hand-rolled template literals make XSS safety a discipline that has to hold on every interpolation forever. The ~10 KB dependency is immaterial against ADR-0004's already-accepted 200–500 ms cold start, and JSX matches the dashboard's mental model.

Link `href` values remain a **separate** concern from text escaping: URLs are validated to `http(s)` on write in the API, since attribute escaping alone does not stop a `javascript:` URL.

### Dashboard: static SPA on S3

The dashboard is a **React + Vite SPA**, built to content-hashed assets in S3 and served through the same CloudFront distribution at `/app/*`. It authenticates with the Cognito JWT from ADR-0005 and calls `/api/*` with a `Bearer` token — **no session cookie**, which keeps ADR-0004's no-cookie default cache policy honest.

There is **no dashboard Lambda**: no cold start on dashboard navigation, and ~$0 to serve. Drag-to-reorder — writing ADR-0003's fractional `rank` — is a natural client-side interaction, and the dashboard reads Page state through the API rather than the cached public URL, preserving ADR-0004's "editing feels instant, only the public URL lags by 60 s".

**This amends ADR-0004's routing table.** `/app/*` was listed as `no-store`, which only made sense for a server-rendered dashboard. It becomes:

| Path | Caching |
|---|---|
| `/app/` (HTML shell) | `no-store` |
| `/app/assets/*` (hashed) | `immutable`, 1 year |

The shell stays uncached so a deploy is live immediately; hashed assets are immutable, so a deploy needs **no invalidation** — consistent with ADR-0004's zero-invalidation stance.

### API front door: Lambda Function URLs + OAC

ADR-0001 deferred "Lambda Function URLs vs API Gateway HTTP API". **Function URLs**, for all three Lambdas, reached **only** through CloudFront via **Origin Access Control** (SigV4-signed origin requests, `AuthType: AWS_IAM`).

- **$0 front door.** API Gateway HTTP API costs $1.00/million requests and inserts a second managed hop for capabilities CloudFront plus a five-line JWT check already provide.
- **Not publicly reachable.** A bare `AuthType: NONE` Function URL stays addressable at its `*.lambda-url.*.on.aws` hostname, letting anyone bypass CloudFront caching and any future WAF or rate limiting. OAC closes that.
- **Consistent with ADR-0004**, which already made the renderer a Function URL.

The Cognito JWT is verified **in-process** with `aws-jwt-verify` (cached JWKS), rather than by an API Gateway JWT authorizer. Inside the api Lambda, **Hono** provides typed routing over the Function URL event — small, dependency-light, and no framework runtime reaches the client.

### IaC: AWS CDK (TypeScript)

**AWS CDK in TypeScript** — the same language as the Lambdas and `core`, one toolchain, one `npm run` surface.

CDK's L2 constructs express exactly the primitives ADR-0004 specified — `Distribution` with per-path behaviors, distinct `CachePolicy` objects, `FunctionUrlOrigin` with OAC, `UserPool`, `Table` — with no vendor abstraction between the founder and the AWS resources that ADR-0001 picked them for. `NodejsFunction` bundles each handler with esbuild out of the box.

Rejected: **SST v3** (its headline value is deploying meta-frameworks, which this ADR just declined; its Pulumi-based engine and SST-owned components add a layer over familiar primitives); **SAM** (CloudFront and Cognito fall back to raw CloudFormation YAML — ~150 lines for a five-behavior distribution); **Terraform/OpenTofu** (a second language and a separate state backend to operate, with no shared types with the app code).

Supporting conventions:

- **npm workspaces** monorepo — no Turborepo/Nx at this size.
- **GitHub Actions** deploying via an **OIDC-assumed role** — no long-lived AWS keys in CI.
- **Two stacks, `dev` and `prod`**, from the same CDK app.
- The **AWS Budgets alarm** promised by ADR-0001 as egress mitigation is defined here, in `infra`.

### Local dev loop

A thin **local Node HTTP server imports the three handlers directly** — no Docker, no Lambda emulator — and Vite proxies `/api`, `/px`, and `/*` to it. Reload is milliseconds.

Data comes from a **real on-demand DynamoDB table in the dev stack**, not DynamoDB Local. On-demand costs ~$0 at dev volume, and it removes emulator-fidelity risk on precisely the features ADR-0003 leans on: GSI1 query behavior, atomic counters, and conditional writes for Username uniqueness.

**CloudFront behavior — caching, TTLs, OAC — is only ever exercised in the deployed dev stack**, via `cdk watch` (hotswap, ~5–10 s). The local loop deliberately does not simulate the edge; ADR-0004's 60-second TTL semantics are not something an emulator would tell the truth about.

## Consequences

**Accepted tradeoffs**
- **No file-system routing, no framework conventions.** Routes are declared in CDK (behaviors) and Hono (API paths). More explicit, less magic, nothing generated for us.
- **Two client-side stacks** — Preact SSR in the renderer, React in the dashboard. Same JSX model, different runtimes; `core` is shared, components are not.
- **The local loop does not reproduce the edge.** Cache-freshness and OAC bugs surface only on `cdk watch` against the dev stack.
- **A real dev DynamoDB table means dev work requires AWS credentials** — no fully offline development.
- **CDK owns the CloudFront distribution**, so distribution changes carry CloudFormation's slow (~10–20 min) update cycle. Lambda code changes do not — `cdk watch` hotswaps them.

**Constraints this imposes downstream**
- **A4 (analytics counting):** the counter is its own Lambda on `/px` behind OAC; its client hook ships inside the renderer's self-contained document, so any beacon script must be inline, not an external asset.
- **A6 (onboarding & username claim):** the reserved-name denylist (ADR-0004) is enforced in `core` and shared by the API and renderer.
- **Avatar upload** (still unspecified) lands in the api Lambda writing to the `/a/*` S3 bucket; size/format limits are that ticket's business.
- **Final spec assembly** can now name a concrete repo layout, toolchain, and deploy pipeline.
