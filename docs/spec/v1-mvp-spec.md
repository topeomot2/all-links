---
status: draft
---

# v1 MVP spec — All-Links

- **Date:** 2026-07-29
- **Ticket:** [S1 — Assemble the v1 spec](https://github.com/topeomot2/all-links/issues/17)
- **Map:** [Wayfinder map: v1 spec for a cheap serverless link-in-bio](https://github.com/topeomot2/all-links/issues/1)
- **Vocabulary:** `CONTEXT.md` — Account, Page, Link, Username, Claim, Hold, Reserved name, Rename, Theme, Subscription, Suspension
- **Sources:** ADR-0001 … ADR-0012 in `docs/adr/`

This is a **synthesis**, not a new decision. It folds the ten ADRs and the map's locked scope into one document a builder can work from without reading the decision history. Every "why" is one link away; nothing here overrides an ADR.

**Read [§11 Unresolved on assembly](#11-unresolved-on-assembly) before writing code.** Reading the ADRs together exposes contradictions and gaps that none of them could see alone. They are small, but two of them change the data model.

---

## 1. Product

A "link in bio" page: one address a creator hands out instead of one link per platform.

**Public artifact** — `ourapp.com/<username>`: display name, avatar, bio line, and an ordered list of labeled Links, in one of a few preset Themes.

**Creator loop** — sign up → claim username → pay → add/edit/reorder/delete Links, edit profile → one shareable URL.

**Thesis:** cheaper and simpler than Linktree; compete on price. Solo, bootstrapped founder in Canada selling to the US and Europe, who does **no tax compliance work**. Cost and operational simplicity are hard constraints, not preferences.

### In scope for v1

| | |
|---|---|
| Address | Path-based, `ourapp.com/<username>`. One Page per Account. |
| Auth | Passwordless email OTP (Cognito). |
| Billing | 5-day trial, **card up front**; $20/yr default or $2.99/mo. No free tier. |
| Analytics | Per-Link click totals + per-Page view totals. Lifetime, monotonic, approximate. |
| Theming | 4–6 preset themes, selected by id. No editor. |
| Avatar | Optional; ≤24 KB WebP, inlined in the document. Monogram fallback. |
| Moderation | `mailto:` report intake, manual suspend, `/terms` + `/privacy`. |

### Out of scope (ruled out, not deferred)

Custom domains (`links.jane.com`) · deep analytics (referrers, geo, time-series) · theme editor · subdomain addressing · permanent free tier · Google social login · redirect table for renamed usernames · appeals process.

---

## 2. Pricing and billing — ADR-0002

| Plan | Price | Fee (5% + $0.50) | Net | Drag |
|---|---|---|---|---|
| **Annual** (default, pre-selected) | **$20/yr** (~$1.67/mo) | $1.50 | $18.50/yr | 7.5% |
| Monthly | **$2.99/mo** | $0.65 | $2.34/mo | 21.7% |

Monthly is $2.99 rather than $2.00 **specifically so the fixed per-transaction fee is absorbed** rather than eating 18–30% of the sticker. Annual is what the funnel pushes.

**Merchant of record: Stripe Managed Payments.** Stripe computes, collects and remits tax; the founder never registers for VAT/GST anywhere. **Fallback — Lemon Squeezy**, taken without reopening the decision if SMP's preview can't do a 5-day trial, can't do these SKUs, or blocks go-live (see [§10](#10-pre-build-checklist)). Both are 5% + $0.50, and the integration is identical on both: *redirect to hosted checkout, listen on a webhook, store subscription status*.

**Card up front.** Signup routes straight to hosted checkout with a 5-day trial. The subscription is created immediately in `trialing`, the Page is **fully live during the trial**, and it auto-charges on day 5. Consequence: **every Account has a subscription object from the moment it is usable** — no card-free state, no day-5 prompt, no trial-expiry job.

### Subscription status → Page visibility

| Status | `active` | Public Page |
|---|---|---|
| `trialing` | `true` | Live |
| `active` | `true` | Live |
| `past_due` | `true` | **Live** — dunning gets its full recovery window |
| `canceled` | `false` | 404 + neutral "page not active" placeholder |
| `canceled` + 30 days | `false` | Username released back to the pool |

The webhook writes **both** the Account's Subscription block **and** the Page's mirrored `active` flag. Missing the second write leaves lapsed Pages visible — see [§4](#4-data-model-adr-0003-amended-by-0007-0009-0010).

The webhook **must never write `suspendedAt`** (ADR-0010). That is the one attribute billing does not own.

---

## 3. Platform — ADR-0001

**AWS serverless**, in one region, TypeScript throughout.

- **Compute:** Lambda (Node/TS).
- **Data:** DynamoDB, **on-demand** — no floor fee, scales to zero, cheap atomic counters.
- **Edge:** CloudFront. **Auth:** Cognito. **Email:** SES.

Chosen over Cloudflare on a **cost tie**, decided by the founder's AWS fluency → velocity. Aurora Serverless v2 was disqualified on its minimum-capacity floor.

**Accepted:** egress billed past CloudFront's 1 TB/mo free tier (~$0.085/GB) — mitigated by aggressive caching and a **mandatory AWS Budgets alarm**; Lambda cold starts; NoSQL single-table modeling.

---

## 4. Data model — ADR-0003, amended by 0007 / 0009 / 0010

**One DynamoDB table.** One item collection per Account under `PK = ACCOUNT#<accountId>`, where `accountId` **is the Cognito `sub`** (ADR-0005).

| Item | Keys | Attributes |
|---|---|---|
| **Account** (private) | `PK=ACCOUNT#<id>`, `SK=ACCOUNT` | `email`, Subscription block (`status`, `plan`, `trialEnd`, `currentPeriodEnd`, `morCustomerId`, `morSubscriptionId`), `lastRenamedAt` (0007), `heldUsername` (0010). **No `GSI1PK`.** |
| **Page** (public) | `PK=ACCOUNT#<id>`, `SK=PAGE`, `GSI1PK=USERNAME#<name>`, `GSI1SK=0` | `username`, `displayName`, `bio`, `avatarWebp` (0009), `themeId`, `pageViewCount` (atomic `ADD`), `active`, `suspendedAt` (0010) |
| **Link** (public) | `PK=ACCOUNT#<id>`, `SK=LINK#<ulid>`, `GSI1PK=USERNAME#<name>`, `GSI1SK=1#<rank>` | `label`, `url`, `rank` (fractional index), `clickCount` (atomic `ADD`) |
| **Username** (uniqueness) | `PK=USERNAME#<name>`, `SK=USERNAME#<name>` | `ownerAccountId`, `claimedAt` (0007) |
| **OTP throttle** (0010) | see [§11.4](#114-the-fifth-item-type-is-unspecified) — **shape not specified by any ADR** | counter + TTL, keyed by email hash |

**GSI1** (`GSI1PK` / `GSI1SK`) projects **public attributes only**. The Account item has no `GSI1PK`, so email and Subscription are **structurally unreachable** on the public read path — not merely un-projected.

### Why it is shaped this way

- **Account and Page are two items**, not one, so the public index can never touch private data.
- **Links are separate items**, not an array, so a click is an atomic `ADD` on an isolated item rather than a contended whole-object rewrite.
- **Ordering is a fractional `rank`**, so a reorder is one write and Link identity (the ULID sort key) is stable — click counts survive reordering.

### Access patterns

| Operation | Cost |
|---|---|
| Public render | **1 GSI1 query** — `GSI1PK=USERNAME#<name>` → Page (`GSI1SK=0`) then Links in rank order |
| Dashboard load | 1 query — `PK=ACCOUNT#<id>` (returns Page, Links, counts, subscription) |
| Link CRUD / reorder | single-item write |
| Click / view | atomic `ADD` |
| Claim / rename | `TransactWriteItems` |

### Visibility gate

```
public visibility  ==  active && !suspendedAt
```

Both attributes arrive in the GSI1 query that already happens, so the check costs **no extra read**. `active` is a pure function of Subscription status; `suspendedAt` is moderation state and orthogonal to it. **Any code path gating public visibility must check both** — checking `active` alone serves suspended Pages.

---

## 5. Architecture — ADR-0004, 0006, amended by 0008 / 0009

### Serving model

**CloudFront in front of a Lambda Function URL** that renders HTML on demand from DynamoDB. **No pre-generated artifacts** — DynamoDB is the single source of truth. No publish pipeline, no objects to reconcile, no rebuild on template change, and a rename migrates nothing.

```
GET /jane
  CloudFront HIT   → HTML from the edge
  CloudFront MISS  → renderer Lambda → 1 GSI1 query → HTML → cached
```

### Freshness — the load-bearing cost decision

```
Cache-Control: public, s-maxage=60, max-age=0
```

**No routine invalidation.** Every write path — edit, reorder, theme change, rename, billing webhook — writes DynamoDB and stops. It never calls CloudFront. The public Page catches up within 60 seconds.

This is not a shortcut. Invalidating per edit costs **~$250/mo at 10k Accounts editing 5×/month** ($0.005/path past 1,000 free), which is fatal at $1.67/mo per Account. Serving a cache miss, by contrast, is ~$0.30/M. Three properties follow: zero invalidation cost at any scale; no CloudFront call to retry, queue or fail on a mutation; and the system **self-heals** — a missed `active` write corrects within a minute instead of leaving a lapsed Page live indefinitely.

**Exactly one thing invalidates: a suspension** ([§8](#8-abuse-takedown-rate-limiting-adr-0010)). Volume sits far inside the free 1,000 paths/month.

### Routing — one distribution

| Path | Origin | Caching |
|---|---|---|
| `/api/*` | api Lambda (Function URL + OAC) | `no-store` |
| `/app/` (SPA shell) | S3 | `no-store` |
| `/app/assets/*` (hashed) | S3 | `immutable`, 1 year |
| `/px` | counter Lambda (FURL + OAC) | `no-store`, forward `u` query string |
| `/r/*` | counter Lambda (FURL + OAC) | `no-store` |
| `/i/*` (unfurl image — ADR-0011) | **renderer Lambda** (FURL + OAC) | `s-maxage=60` |
| `/*` **(default)** | **renderer Lambda** (FURL + OAC) | `s-maxage=60`, **no cookies forwarded** |

> The `/a/*` avatar behavior and its S3 bucket that ADR-0004 originally specified were **removed by ADR-0009**; `/i/*` (ADR-0011) is **not** its return — it is a renderer route reading the same Page item, fetched by unfurlers once per share, not by browsers per view. `/`, `/terms`, `/privacy`, `/robots.txt` and `/og-card.png` need **no behavior at all** — **ADR-0012** serves them from a static route table in `core`, checked by the renderer before the username lookup, at `s-maxage=300`. See [§11.2](#112-nothing-serves-terms-privacy-or-the-marketing-site), now resolved. `www.ourapp.com` is a **separate** distribution (S3 website-redirect → apex), deliberately not an alias here — an alias would put `Host` in this behavior's cache key.

The default behavior forwards **no cookies**, so dashboard sessions can never fragment the public cache. This is why the dashboard uses a `Bearer` token and not a session cookie. One distribution, one certificate, one deploy.

### Repo layout

```
packages/
  renderer/    Lambda — GSI1 query → self-contained HTML      (default behavior)
  api/         Lambda — /api/* CRUD + billing webhooks
  counter/     Lambda — /px views + /r/* click redirects
  dashboard/   React + Vite SPA → static assets               (/app/*)
  core/        shared TS — data access, domain types, themes,
                 username regex + reserved-name Set, avatar validation,
                 STATIC_ROUTES (ADR-0012; the reserved Set derives from it)
infra/         AWS CDK app — one distribution, table, user pool, alarms
```

npm workspaces. No Turborepo/Nx at this size.

**No meta-framework.** ADR-0004 had already fixed routing, caching and the render model, so Next/Astro/Remix would only be an adapter arguing with them — its router inside CloudFront's, its bundle in a hot path that ships no client runtime.

### Renderer

**Preact `render-to-string`**, no client runtime. The deciding factor was **auto-escaping**: display name, bio and Link labels are user-supplied and interpolated into a public document, and JSX escapes by default where template literals make XSS a discipline that must hold on every interpolation forever.

`href` values are a **separate** concern — attribute escaping does not stop a `javascript:` URL. URLs are validated to `http(s)` **on write** in the api Lambda, **and again** on redirect in the counter Lambda. A redirector is worth defending twice.

### API front door

**Lambda Function URLs for all three Lambdas, reachable only through CloudFront via Origin Access Control** (SigV4-signed origin requests, `AuthType: AWS_IAM`).

- **$0** — API Gateway HTTP API is $1.00/M for capabilities CloudFront plus a five-line JWT check already provide.
- **Not publicly addressable** — a bare `AuthType: NONE` Function URL stays reachable at its `*.lambda-url.*.on.aws` hostname, letting anyone bypass the cache, and any future WAF or rate limit. OAC closes that.

The Cognito JWT is verified **in-process** with `aws-jwt-verify` (cached JWKS). **Hono** routes inside the api Lambda.

### Dashboard

React + Vite SPA, content-hashed assets in S3, served at `/app/*` through the same distribution. Authenticates directly against Cognito, calls `/api/*` with a `Bearer` JWT — **no session cookie**. No dashboard Lambda: no cold start on navigation, ~$0 to serve.

Drag-to-reorder writes the fractional `rank`. The dashboard reads Page state **through the API**, not the cached public URL — so editing feels instant and only the public URL lags by 60 s.

The shell is `no-store` and assets are immutable, so **a dashboard deploy needs no invalidation** either.

### IaC and deploy

**AWS CDK (TypeScript)** — same language as the Lambdas and `core`, one toolchain. L2 constructs (`Distribution`, `CachePolicy`, `FunctionUrlOrigin` + OAC, `UserPool`, `Table`) express ADR-0004's primitives directly, with no vendor layer between the founder and the AWS resources they were chosen for. `NodejsFunction` bundles handlers with esbuild.

Rejected: **SST** (its value is deploying meta-frameworks, which we declined), **SAM** (~150 lines of raw CFN YAML for a five-behavior distribution), **Terraform** (a second language plus a state backend, no shared types).

- **GitHub Actions**, deploying via an **OIDC-assumed role** — no long-lived AWS keys in CI.
- **Two stacks, `dev` and `prod`**, from one CDK app.
- The **AWS Budgets alarm** ADR-0001 requires is defined in `infra`.

### Local dev

A thin local Node HTTP server **imports the three handlers directly** — no Docker, no Lambda emulator. Vite proxies `/api`, `/px`, `/r` and `/*` to it. Reload in milliseconds.

Data comes from a **real on-demand DynamoDB table in the dev stack**, not DynamoDB Local — on-demand is ~$0 at dev volume and it removes emulator-fidelity risk on exactly what the model leans on: GSI1 query behavior, atomic counters, conditional writes.

**Edge behavior — caching, TTLs, OAC — is exercised only in the deployed dev stack** via `cdk watch` (hotswap, ~5–10 s). The local loop deliberately does not simulate the edge; a 60-second TTL is not something an emulator tells the truth about.

**Consequence: dev work requires AWS credentials.** There is no fully offline mode.

---

## 6. Flows

### 6.1 Signup — ADR-0005, 0007, 0002

```
landing → email → Cognito OTP
  ↓  post-confirmation Lambda: Account item (active=false, no subscription)
claim username          ← availability known HERE, before any payment
  ↓  writes the Username item only
hosted checkout (card, 5-day trial)
  ↓  billing webhook: trialing
Page created, active=true → live at ourapp.com/<username>
  ↓
editor, empty state prompting the first Link
```

**Username is claimed before checkout** because the handle *is* what the creator is buying; discovering it is taken after paying is a refund path. No profile fields sit between the claim and the card.

**The Page is created by whichever of {claim, billing webhook} completes second**, in a transaction guarded by a `ConditionCheck` that the Username item still names this Account:

```
TransactWriteItems
  ConditionCheck  Username.ownerAccountId == me
  Put             Page   GSI1PK=USERNAME#<name>, displayName=<name>, active=true
  Update          Account subscription
```

Stating the rule by **ordering** rather than by event also covers the rare recovery case where the webhook's `ConditionCheck` loses the race: the Account is paid but nameless, and the next successful claim creates the Page. **This path is rare, real, and must be tested rather than assumed away.**

**Post-auth routing must resolve four states:** active → dashboard; inactive with no username → claim; inactive holding a username → resume checkout; inactive whose hold was reclaimed → claim, with a notice.

### 6.2 Username rules — ADR-0007

```
^(?=.{3,30}$)[a-z0-9]+(?:[_-][a-z0-9]+)*$
```

3–30 chars, `a-z 0-9 - _`. **Lowercase-canonical** — typed uppercase is silently lowercased, not rejected. Alphanumeric runs joined by *single* separators, so a separator can never lead, trail or double. No percent-encoding is ever possible in a Page URL. Uniqueness is on the literal name; separator-collapsing uniqueness was rejected (a second uniqueness key, and "why is this taken?" becomes unanswerable).

**Reserved names** — a frozen `Set` in `core`, checked before the claim transaction, in three buckets:

1. **Routing and marketing namespace** — `api`, `app`, `login`, `signup`, `pricing`, `about`, `terms`, `privacy`, `help`, `blog`, `docs`, `status`, `contact`, `admin`, …
2. **Authority and impersonation** — `support`, `billing`, `security`, `staff`, `team`, `official`, `moderator`, `abuse`, `legal`, `noreply`, `www`, `mail`
3. **The brand** and near-variants

`a`, `px` and `r` need no entry — the 3-character minimum excludes them structurally. **No profanity list**: false positives are endemic (the Scunthorpe problem), the list needs perpetual maintenance, and takedown is already the lever.

> **`core` owns the reserved Set and the regex.** ~~Adding a root route means adding its reservation in the same PR.~~ **ADR-0012** derives the Set instead — `RESERVED = BASE_RESERVED ∪ keys(STATIC_ROUTES)` — so adding a root route reserves its name in the same expression. The rule is retired, not delegated.

### 6.3 Holds and reclaim — ADR-0007, amended by 0010

A claim writes **only** the Username item:

```
CLAIM   Put Username { ownerAccountId, claimedAt }
          attribute_not_exists(PK)
          OR (holder inactive AND holder not suspended AND claimedAt < now - 7d)
        Delete previously-held Username        ← ADR-0010, same transaction
        Update Account.heldUsername
```

**An unpaid hold lasts 7 days**, harvested **lazily, on contention only** — no sweeper, no TTL, no scheduled job. An uncontended hold costs nothing and stays. ADR-0002's *canceled + 30 days → released* rides the **same condition**, so one mechanism implements both windows. They differ deliberately: a signup that never paid earns less protection than a customer who did.

**Delete-on-reclaim** (ADR-0010) makes "one held handle per Account" structural, closing bulk claiming without a counter. Because a claim touches one Username item and no Page, **two Pages sharing a `GSI1PK` is structurally impossible** rather than prevented by remembering to clean up.

**The availability check applies the same 7-day staleness rule** as the claim — otherwise the UI reports a stale hold as taken while the transaction would have accepted it, which is worse than either answer given consistently. *Reserved* and *taken* get distinct error copy.

> The reclaim condition reads attributes on a **different item** than the one being written. See [§11.1](#111-the-reclaim-condition-is-not-expressible-as-written).

### 6.4 Rename — ADR-0007

Same regex, same denylist, same claim transaction. The old name is **released immediately**; old URLs 404 with no redirect table. **Once per 30 days**, via `lastRenamedAt` on the Account — a rename rewrites `GSI1PK` across the Page and every Link, and this limit is what makes ADR-0003's "renames are rare" assumption true.

### 6.5 Public render — ADR-0004, 0009

One **self-contained HTML document**. Theme CSS inlined, no external stylesheet, no framework runtime, renders with **JavaScript disabled**.

- **Avatar** — `<img src="data:image/webp;base64,…">` with `object-fit: cover`, carrying `width`/`height` from the stored `avatarW`/`avatarH` (ADR-0011) so the layout cannot shift. The client scales to *fit* a 256 px box and CSS crops to fill, so **there is no crop UI to build**.
- **No avatar** — a **themed CSS monogram**: a circle in the Theme's accent color bearing the first character of the display name (falling back to the username). Zero bytes, zero requests, no `<img>`. The minimum profile is username-only, so a large share of Pages launch with no avatar; they must look deliberate on day one, and **the layout must not jump when an avatar arrives later**.
- **Links** point at `/r/<username>/<linkId>`, not the destination ([§7](#7-analytics-adr-0008)).
- **A 1×1 pixel** `<img src="/px?u=<username>">` is emitted for view counting.

**Requests per page view: 2** (document + pixel) — see [§11.3](#113-requests-per-page-view-is-stated-three-different-ways).

### 6.6 Negative path — ADR-0004

Both "no such Username" and "not visible" return **404**, cached at the same `s-maxage=60`, with **different bodies**:

| Case | Body |
|---|---|
| Username unclaimed | "`/jane` is available — claim it", with a signup CTA |
| Page inactive (lapsed) | Neutral "this page isn't active" — **never names billing** |
| Username reserved | Neutral, no CTA — **ADR-0012**: fires on a `core` reserved-Set hit after the static route table misses |
| Page suspended | Reuses the neutral inactive body |

The unclaimed body turns stray traffic into an acquisition funnel; the lapsed body avoids publicly outing a creator as unpaid. Matching the live TTL means a freshly claimed Username goes live within 60 seconds.

> **ADR-0012** sends `/login` and `/signup` to **302 `/app/`**, and `/pricing` to **302 `/#pricing`**, rather than any 404 body — a name a visitor typed on purpose deserves a destination. `about`, `blog`, `docs` and `help` get the reserved body.

### 6.7 Unfurl metadata and indexing — ADR-0011

The unfurl is a large fraction of the product's surface and the only part of it that renders inside someone else's app. ADR-0009 removed `/a/*`, the last public image URL, so `og:image` needed a source.

**`og:image` is `/i/<username>.webp`** — a route on the **renderer** Lambda (not a fourth deploy unit: it already runs the GSI1 query and owns the `active && !suspendedAt` gate). Returns `avatarWebp` as `image/webp` at `s-maxage=60`; **302s to `/og-card.png`** for no avatar, lapsed or suspended, so an unfurler never renders a broken card. A one-character prefix cannot collide with a username (≥3 chars — §6.2).

This is not ADR-0009 reversed: every mechanism ADR-0009 removed (key rotation, orphan cleanup, an opaque key, the bucket, `sharp`) followed from an *immutable object and the upload path*, none of which a read endpoint reintroduces — and ADR-0008's dominant per-request fee is a **per-view** cost, while an unfurl fetch is **per-share**.

**Tags emitted:**

| Tag | Value |
|---|---|
| `<title>`, `og:title`, `twitter:title` | `displayName` + ` (@username)` **only when they differ** — §6.1 defaults `displayName` to the username, so unconditional would read "jane (@jane)" |
| `og:description`, `twitter:description` | `bio`; empty → `All of @<username>'s links, in one place.` |
| `og:image`, `twitter:image` | `/i/<username>.webp`, else `/og-card.png` |
| `og:image:width/height/type` | from `avatarW`/`avatarH` |
| `og:url` + `<link rel="canonical">` | `https://<domain>/<username>` |
| `og:type` + `profile:username` | `profile` |
| `og:site_name` | product name |
| `twitter:card` | **always `summary`** |

`summary` is forced — a ≤256² avatar is under `summary_large_image`'s 300×157 minimum — and made useful by keeping `/og-card.png` **square**, so the card type never varies and the renderer carries no branch. Values are user-supplied and land in attribute position; Preact escapes attributes as well as children (§5 Renderer).

**Format risk, accepted.** X, LinkedIn and Discord accept WebP; **Meta's crawler may not**, and WhatsApp is a primary sharing path in Europe. Serving the stored WebP costs $0 and risks a text-only unfurl on Meta. **Pre-decided escalation** (ADR-0010's WAF idiom) — trigger: Meta's sharing debugger shows no image for a Page with an avatar; fix: the client encode also emits a JPEG, stored **outside the GSI1 projection** and read only by `/i/*`, leaving the hot path untouched. Storing JPEG instead was rejected: it taxes every view (~+8 KB base64 per document, worsening §11.5) to fix a per-share problem. Because the brand card is a static PNG, **the risk touches only Pages that have an avatar**.

**Indexing.** Pages are `index,follow`. `noindex` on the unclaimed placeholder, the lapsed 404, the suspended notice and `/app/*`. Outbound anchors carry **`rel="nofollow ugc noopener"`** and `robots.txt` **disallows `/r/`, `/px/`, `/api/`, `/app/`** — which does two jobs: it removes the PageRank incentive that makes a link-in-bio host worth abusing (§8 has no tooling beyond one inbox), and it turns §7's click hygiene from a *heuristic* into a structural exclusion for compliant crawlers, since indexable Pages would otherwise invite every crawler to increment `clickCount`.

**Not in v1:** a sitemap (build-later — it is also the most attractive artifact we could hand an SEO spammer), and a per-Page "hide from search" toggle (ruled out of scope).

**Settled by ADR-0012 / [S2](https://github.com/topeomot2/all-links/issues/21):** `/robots.txt` and `/og-card.png` are **renderer routes** in `core`'s static route table, not files on the SPA origin — see [§5](#5-architecture) and [§11.2](#112-nothing-serves-terms-privacy-or-the-marketing-site). **Also amends §8's takedown:** suspension must invalidate `/i/<username>` alongside `/<username>`.

---

## 7. Analytics — ADR-0008

Two numbers per Page: per-Link click totals, per-Page view totals. Both are **lifetime monotonic totals** with no time dimension and no reset.

The ticket framed this as a cost decision. Priced out, **cost is not the binding constraint** — an event runs ~$1–2/M all-in and the **CloudFront request fee (~$1/M) dominates the DynamoDB write ($0.625/M)**, so batching optimises the smaller number while SQS ($0.40/M) costs roughly what the write it removes cost. All batching options were rejected on **operational surface**, not price.

### Clicks — a server-side redirect

```html
<a href="/r/jane/01HX4K...">My shop</a>
```

```
GET /r/<username>/<linkId>
  → Query GSI1 where GSI1PK = USERNAME#<username>
      → Page (accountId, active, suspendedAt) + Link items — one read, everything needed
  → UpdateItem  PK=ACCOUNT#<accountId>, SK=LINK#<linkId>  ADD clickCount 1
  → re-validate link.url is http(s)
  → 302  Location: <link.url>   (Cache-Control: no-store)
```

The count is **authoritative**: works with JS disabled, cannot be suppressed by an ad blocker, cannot be lost. Resolution **reuses the renderer's own query** — `accountId` is the Cognito `sub` and must never appear in a public URL, so the path carries the *username*, and one GSI1 query yields the owning account, the destination, and the visibility flags together. Lapsed and suspended Pages stop redirecting for free rather than via a second read.

**302, never 301.** A cached permanent redirect would count a visitor once and never again, and would keep sending traffic to a destination the creator has since edited.

### Views — a 1×1 pixel

```
GET /px?u=<username>
  → Query GSI1  GSI1PK=USERNAME#<username>, GSI1SK=0, Limit 1
  → UpdateItem  PK=ACCOUNT#<accountId>, SK=PAGE  ADD pageViewCount 1
  → 204
```

A pixel over `sendBeacon`: it needs no client runtime on a document deliberately kept runtime-free, and it **filters bots structurally** — crawlers and link unfurlers fetch the HTML but not inline images, so the largest source of false views excludes itself with no code.

### Write path

Direct, synchronous, **best-effort**. No queue, no batch, no aggregation — counts are live and there is one source of truth. **If DynamoDB errors or throttles, the Lambda logs it and still redirects / still returns 204.** Analytics must never be able to break a click.

### Filtering

Free heuristics only: a **User-Agent denylist** for self-identifying crawlers, and a **same-origin `Referer`** requirement on `/px`. **No WAF, no per-IP dedupe, no visitor IPs recorded at all** — which keeps a public endpoint clear of personal data for the European market. Counts are **openly approximate and never a billing input**.

### Misses

Any lookup failure on `/r/*` — link deleted, Page inactive or suspended, username renamed or absent — resolves to one rule: **302 to `/<username>`**. The common miss is benign and self-correcting (the 60 s TTL means a visitor can click a link edited seconds ago); bouncing them to the Page shows current links instead of a dead end, and a genuinely gone Page lands on the existing placeholders rather than a third piece of copy.

### Accepted costs

- **The destination URL is hidden** behind `ourapp.com/r/…` on hover. Standard for the category, but a genuine transparency cost.
- **Every outbound link now depends on the counter Lambda.** If it is down, links do not merely go uncounted — they do not work. This is the price of an authoritative count, and it is why the *database* write is best-effort.
- **~100 ms warm, 200–500 ms cold** on the click path. `/px` and `/r/*` share one Lambda partly so their combined traffic keeps it warm.
- Counts are lost when a Link is deleted and recreated; a rename orphans in-flight cached `/r/<oldname>/…` links.
- **Per-partition write ceiling ~1000/s** across an Account's whole collection. Only a viral Page approaches it. A buffer retrofits **behind the same `/px` and `/r/*` URLs with no change to the public HTML** — the contract is the URL, not the mechanism.

The dashboard reads both counts from the `Query PK=ACCOUNT#<id>` it already runs. **There is no analytics read path to build.**

---

## 8. Abuse, takedown & rate limiting — ADR-0010

**Working in our favour and already paid for: card up front.** Every Page costs $20/yr and a real payment card — the single most effective spam filter available to a UGC product, and free. Everything below is calibrated to a world where mass automated abuse has to buy its way in.

### Takedown

**A Suspension is a state of its own, not a state of `active`.** Reusing `active` would mean the billing webhook silently un-suspends a Page on its next `active=true` event. `suspendedAt` (ISO timestamp; absent means not suspended) is written only by moderation.

**Suspending does three things, in this order:**

1. Set `suspendedAt` on the Page and **invalidate `/<username>` *and* `/i/<username>`** (ADR-0011) — the only invalidation in the system, making the takedown immediate rather than up to 60 s late. Both paths, or the pulled avatar keeps serving inside unfurls that already exist.
2. **Cancel the Subscription** with the merchant of record. Charging an account whose page has been pulled invites a dispute and is indefensible on its own terms.
3. **Tombstone the Username** — the lazy harvest gains one clause: *never harvest a Username whose Page is suspended*. Without it, ADR-0002's 30-day release would hand the handle back to the same actor with a fresh email. Handles stay burnt until **manually** released, which is also the remedy in the impersonation case where the rightful owner wants the name.

**Reports arrive by email.** Every public Page carries a footer line linking `mailto:abuse@ourapp.com?subject=Report: <username>`. This is the only intake channel — it adds no endpoint, no form, no unauthenticated write path and no runtime to a document kept deliberately runtime-free. The subject line carries the username, so triage is a mail filter. **The founder judges reports personally: no SLA, no queue tooling, no appeals beyond replying to the mail.**

**Phishing and shared domain reputation.** Path-based addressing means one domain's reputation is shared by every creator, and a blocklisting takes out signup and billing alongside the pages. Two things bound it. Structurally, `/r/*` is **not** an open redirector — the destination must be a Link a paying creator saved, resolved from DynamoDB, so no URL can be laundered through the domain without an account. On top, link create/update performs a **synchronous Google Safe Browsing Lookup** and refuses the save on a hit. It **fails open** on error or timeout, runs only on the authenticated dashboard path, never touches the public read path, and needs no review queue.

### Rate limiting

**Per-endpoint answers on a shared free floor — not one mechanism.** The endpoints protect different things, and a single shared limiter would put a DynamoDB write in front of every `/px` and `/r/*` request — roughly doubling per-event cost — to defend counts already declared approximate.

**The floor, on every function:**

- **Reserved concurrency**, sized to plausible peak. Free, and the real cost ceiling: an attack cannot outrun a concurrency cap into an unbounded bill.
- **AWS Budgets alarm** as the backstop.

This is a **cost ceiling, not a fairness mechanism** — under attack, legitimate traffic throttles alongside the attack and a viral Page sheds requests. Accepted deliberately: at $20/yr a 503 on a spike is recoverable and an unbounded bill is not.

**One endpoint gets a per-actor limit: OTP-send** — **5/hour, 20/day** per email hash, an atomic `ADD` against a TTL'd counter item in the existing table. What it protects is **SES sender reputation, not cost**: email is $0.10/1000, so bombing an inbox is cents, but complaints from the victim degrade deliverability, and on a passwordless product **deliverability *is* login**. It lives in a **Cognito Lambda trigger**, since the SPA talks to Cognito directly and none of our Lambdas sit in that path. *(Build-time check, [§10](#10-pre-build-checklist).)*

**Username enumeration is not a threat and gets no limit** — the public site already answers taken-vs-free as 200/404 from the edge, so an availability endpoint reveals strictly less than CloudFront does. Recorded so it stops being re-deferred.

**Bulk claiming was real** and is closed **structurally by delete-on-reclaim** ([§6.3](#63-holds-and-reclaim-adr-0007-amended-by-0010)), not by a limit.

**`/px` and `/r/*` get floor only.** No per-IP counters, no visitor IPs of any kind, hashed or not.

**Escalation is decided now, not during the incident.** *Trigger:* the Budgets alarm, or a CloudWatch alarm on counter invocations past a daily threshold (free within the first ten alarms). *Response:* deploy **AWS WAF rate-based rules** on `/px`, `/r/*` and the api Function URL, accepting the ~$6/mo rejected *at launch*. WAF was never rejected on merit, only on floor cost at zero revenue — this flips the moment there is traffic to defend. Further escalation, if a domain blocklisting lands: split public pages onto a separate domain from dashboard and billing.

### Policy surface

The suspend lever enforces a policy, so the policy must exist. v1 ships **`/terms`** (with the acceptable-use policy naming what gets a Page suspended) and **`/privacy`** (which is where the "no visitor IPs" stance is stated as a commitment). Both names are on the reserved denylist.

> **Load-bearing assumption, stated plainly:** abuse handling is one founder's inbox. There is no tooling, no rota, and no capacity story. This is the first thing that breaks if the product grows.

---

## 9. Cost model at a glance

| Line | Per million | Note |
|---|---|---|
| CloudFront request | $0.75 – $1.00 | **dominates** — the number to optimise |
| DynamoDB on-demand write (`ADD`) | $0.625 | |
| Lambda request | $0.20 | |
| DynamoDB eventually-consistent read (<4 KB) | $0.0625 | but see [§11.5](#115-the-avatar-blob-multiplies-the-cost-of-every-analytics-read) |
| CloudFront egress | ~$0.085/GB past 1 TB/mo free | pages ~30–40 KB |
| Cognito Essentials | $0.015/MAU, **10k free, no floor** | |
| CloudFront invalidation | $0.005/path past 1,000/mo free | suspensions only |

**Floors:** none, by construction. Every service scales to zero. This is why Clerk/Supabase ($25/mo), Aurora Serverless v2, and WAF-at-launch (~$6/mo) were all rejected despite being better products in isolation.

At 10k Accounts averaging 1k views/month, the entire analytics bill is ~$10–20/mo against ~$16.7k/mo of revenue.

---

## 10. Pre-build checklist

Work the map deliberately kept out of decision tickets. **None of these are decisions** — but the first two gate the build.

| # | Item | Gates |
|---|---|---|
| 1 | **Register the base domain**; ACM certificate, DNS, TLS. `ourapp.com` is a placeholder in every ADR. | Everything |
| 2 | **Verify Stripe Managed Payments** — preview eligibility for this account, support for a 5-day trial, support for the $2.99/mo and $20/yr SKUs, and go-live. **A failure on any of these fires the Lemon Squeezy fallback without reopening ADR-0002.** | §2, §6.1 |
| 3 | **Confirm which Cognito trigger fires on each send under *managed* `EMAIL_OTP`.** If none does, fall back to proxying `InitiateAuth` through the api Lambda. The mechanism is decided either way — only the mounting point is unverified. | §8 |
| 4 | **SES production access** + SPF/DKIM/DMARC on the sending domain. Passwordless puts email on the critical login path. | §6.1 |
| 5 | **An inbox for `abuse@ourapp.com`** — SES receiving or a forwarding alias. The only report intake channel. | §8 |
| 6 | **Google Safe Browsing API key** and quota check. | §8 |
| 7 | **Author `/terms`** (with the AUP the suspend lever enforces), **`/privacy`** (stating the no-visitor-IPs commitment) **and the `/` landing page** — pitch, pricing, CTA to `/app/`. All three are components in the renderer (ADR-0012); **legal review of Terms and Privacy before launch.** | §8, §5 |
| 8 | **Register a DMCA designated agent** with the US Copyright Office — a $6 filing, and the precondition for safe harbour on a UGC product selling into the US. | §8 |
| 9 | **Size reserved concurrency per Lambda**, and set the CloudWatch/Budgets thresholds that trip the WAF escalation. Sizing, not deciding. | §8 |
| 10 | **Design the 4–6 preset Themes** (accent color, type, layout, monogram treatment) as CSS in `core`. | §6.5 |
| 11 | **Write the suspend runbook script** — DynamoDB write + MoR cancel + CloudFront invalidation (**both paths** — §6.7) in one command, so a 2am takedown is one command rather than three consoles. | §8 |
| 12 | **Design `/og-card.png`** — a square brand card, the `og:image` for every Page without an avatar. A design asset, not a decision. | §6.7 |
| 13 | **Check a live Page in Meta's sharing debugger** once a domain exists. A missing image is the named trigger for §6.7's pre-decided JPEG-companion escalation. | §6.7 |
| 14 | **`www` certificate SAN, the S3 website-redirect bucket and its own distribution** in CDK (ADR-0012). Deliberately not an alias on the main distribution — that would put `Host` in the public cache key. | §5 |
| 15 | **Keep the landing page's `$20/yr` / `$2.99/mo` in step with the Stripe catalogue.** ADR-0012 names this as a two-sources-of-truth watch item on the product's headline number, with no mechanism enforcing it. | §2, §5 |

**Test explicitly** (called out in the ADRs as rare-but-real): the **paid-but-nameless recovery path**, where the billing webhook's `ConditionCheck` loses the race and the next successful claim creates the Page.

---

## 11. Unresolved on assembly

Read individually, every ADR is consistent. Read **together**, six things contradict or dangle. Each is stated with what the ADRs actually say, and a recommendation — **none of these are decided here**; §11.1 and §11.5 need a call before or during the build. **§11.2 is now resolved by ADR-0012** and is kept below for the record.

### 11.1 The reclaim condition is not expressible as written

ADR-0007 writes the claim condition as:

```
attribute_not_exists(PK) OR (holder inactive AND claimedAt < now - 7d)
```

`claimedAt` is on the Username item, but **`holder inactive` is not** — `active` lives on the *Page*, and ADR-0010 adds `not suspended` from the same Page item. A DynamoDB conditional `Put` can only condition on attributes of the item it writes, so this condition cannot be expressed as a single-item write. ADR-0010 asserts "the harvest already reads that item, so this is a condition, not a mechanism" — which is true of the *read*, not of the *conditional write*.

**Recommended:** express the claim as a `TransactWriteItems` with a `ConditionCheck` on the **holder's Page item** (`active = false AND attribute_not_exists(suspendedAt)`) alongside the `Put` of the new Username, the `Delete` of the previously-held one, and the `Update` of `Account.heldUsername`. Costs one more transacted item on the rare contended path and keeps a single source of truth. *(Rejected alternative: mirroring `active`/`suspendedAt` onto the Username item — a third place the visibility state must stay in sync, which is exactly what ADR-0003's single mirrored flag was designed to avoid.)*

Note this makes the contended claim a **four-item transaction**, and the harvest path must handle the case where the holder has **no Page at all** (claimed but never paid — the common case), where the `ConditionCheck` has no item to check.

### 11.2 Nothing serves `/terms`, `/privacy`, or the marketing site — **RESOLVED by ADR-0012**

> **Resolved.** v1 ships **three pages** — `/` (pricing inline), `/terms`, `/privacy` — served by the renderer from a **static route table in `core`**, checked before the username lookup, at **`s-maxage=300`**. `/robots.txt` and `/og-card.png` join them. **Zero new behaviors, zero new origins.** The recommendation below was taken, and the trade it framed as even turned out not to be: **CloudFront cannot route `/` away from the default behavior** (a leading slash is implied, so a bare `/` is the empty pattern, and the default `*` cannot be changed), so the static-origin alternative needed a rewrite function on top and split the mechanism around the most important page anyway. ADR-0012 also settles the seven reserved-but-unrouted names (`/login`, `/signup` → 302 `/app/`; `/pricing` → 302 `/#pricing`; `about`/`blog`/`docs`/`help` → a reserved-404 that does not offer to sell the name), **derives the denylist from the route table** so ADR-0007's standing rule is retired, and routes `www` via a separate redirect distribution. See `docs/adr/0012-root-marketing-and-legal-routes.md`.

*Original text:*

ADR-0010 says `/terms` and `/privacy` are "static objects served at the root" and adds them to the reserved denylist. **The denylist only stops a creator claiming those usernames — it does not route the path.** ADR-0004's default behavior is the renderer Lambda as catch-all, so today `/terms` renders a 404 "this name is available" placeholder.

The same gap covers the **marketing site**. ADR-0007's flow begins at "landing", ADR-0002's funnel implies a pricing page, and the denylist reserves `pricing`, `about`, `blog`, `docs`, `help`, `login`, `signup` — but **no ADR ever decided what serves `/` or any of them.** The root is the product's front door and it currently falls through to "`/` is available — claim it".

**Recommended:** the renderer Lambda serves a small set of static routes from `core` before falling through to the username lookup — `/`, `/terms`, `/privacy` at minimum. It already emits self-contained HTML with inlined CSS, it is already the catch-all, and this costs zero new behaviors, zero new origins and zero new deploy steps. Cache them at the same `s-maxage=60`. *(Alternative: an S3 origin with its own behaviors per path — more moving parts, and every new marketing page becomes a CDK change.)* Either way, **decide before launch**: a live product whose homepage offers to sell you the username "" is not shippable.

### 11.3 "Requests per page view" is stated three different ways

ADR-0004 budgeted **two** (document + avatar). ADR-0008 said **three** (document + avatar + pixel). ADR-0009 removed the avatar request and said **one** — correcting ADR-0004's pair without folding in ADR-0008's pixel, which had landed on a separate branch.

**The merged truth is two: document + pixel.** No decision needed; §6.5 states it. Flagged because the "one request per view" line in ADR-0009 is load-bearing in its own cost table and will mislead anyone reading that ADR alone.

### 11.4 The fifth item type is unspecified

ADR-0003 defines a four-item-type model. ADR-0010 introduces a fifth — "a TTL'd counter item in the existing table, keyed by a hash of the email address" — without keys, attribute names, or a TTL attribute, and ADR-0003 was never amended.

Low risk, but it is the one item in the table with no specified shape. **Recommended:** `PK=OTP#<sha256(email)>`, `SK=WINDOW#<hour|day>`, attributes `count` (atomic `ADD`) and `expiresAt` (DynamoDB TTL). Two items rather than one sliding window keeps both limits as plain conditional increments. No `GSI1PK`, so it stays off the public index like the Account item.

### 11.5 The avatar blob multiplies the cost of every analytics read

ADR-0008 priced the GSI1 read behind `/px` and `/r/*` at **$0.0625/M**, on the basis of an eventually-consistent read under 4 KB. ADR-0009 then put a **≤24 KB WebP blob (≈32 KB as base64) into the GSI1 public projection** — deliberately, so the render stays one query.

DynamoDB bills read capacity on the **size of the item read from the index, not the size of the projection returned**, so a `ProjectionExpression` on `/px` saves nothing. A Page item with a full-size avatar is ~33 KB → ~4.5 RRU instead of 0.5 — **roughly 9× the read cost on the two highest-volume endpoints in the system**, or about **+$0.50 per million events**.

Against ADR-0008's ~$1–2/M all-in that is a **25–50% increase in per-event cost**, not a catastrophe — and it applies only to Pages that actually have a large avatar. But it is a real interaction neither ADR could see: A7 was decided against A4's cost model, and A4's cost model predates the blob.

**Recommended:** accept it for v1 and write it down, rather than adding a second index at launch. If it matters, the fix is a lean **GSI2** (`GSI1PK`-equivalent key, `INCLUDE` projection of `accountId`, `active`, `suspendedAt`, `url`, `rank` — no `avatarWebp`) used only by the counter Lambda; it costs extra write capacity on mutations, which are rare, and restores the analytics read to ~0.5 RRU. **Do not** solve it by moving the avatar off GSI1 — that breaks ADR-0003's one-query render, which is the more valuable property.

### 11.6 Stale cross-references in merged ADRs

Cosmetic; listed so a reader of the individual files is not misled.

- **ADR-0006** says avatar upload "lands in the api Lambda writing to the `/a/*` S3 bucket" — superseded by ADR-0009. The api Lambda is right; the bucket no longer exists.
- **ADR-0004**'s accepted-tradeoff list names the denylist as tracking "`api`, `app`, `a`, `px`, `r`" — `a` is gone with `/a/*`, and `terms`/`privacy` joined via ADR-0010.
- **ADR-0007** enumerates the live behaviors as `/api/*`, `/app/*`, `/a/*`, `/px` — predates `/r/*` and `/i/*`, and the removal of `/a/*`. Its *conclusion* is unaffected, and ADR-0011 leans on it: only `api` and `app` can collide, since the rest are under three characters.
- **ADR-0005**'s signup ordering omits the username claim, which ADR-0007 inserted between Account creation and checkout. §6.1 states the merged order.

### Not a contradiction, but not covered anywhere

Two things no ticket owned, surfaced here rather than silently assumed. Both were ticketed off the back of this section; the first is now closed:

- ~~**Open Graph / social meta tags.**~~ **Resolved by [S3](https://github.com/topeomot2/all-links/issues/22) → ADR-0011; see [§6.7](#67-unfurl-metadata-and-indexing--adr-0011).** `og:image` gets a real URL back as a renderer route at `/i/<username>.webp`, with a static square brand card as the fallback; indexing, `rel="nofollow ugc"` and `robots.txt` are settled there too.
- **Account deletion and data export.** Selling into Europe with no erasure path is a GDPR exposure, and `/privacy` will have to say something. Either scope a delete endpoint into v1 or rule it out explicitly and handle erasure manually — but it should be a decision, not an omission.

---

## 12. ADR index

| ADR | Decision | Ticket |
|---|---|---|
| [0001](../adr/0001-aws-serverless-platform.md) | AWS serverless platform | [D1](https://github.com/topeomot2/all-links/issues/4) |
| [0002](../adr/0002-payments-and-billing.md) | Payments, pricing, billing | [D2](https://github.com/topeomot2/all-links/issues/5) |
| [0003](../adr/0003-dynamodb-single-table-data-model.md) | DynamoDB single-table model | [A1](https://github.com/topeomot2/all-links/issues/6) |
| [0004](../adr/0004-public-page-serving-architecture.md) | Public-page serving | [A2](https://github.com/topeomot2/all-links/issues/7) |
| [0005](../adr/0005-authentication.md) | Authentication | [A3](https://github.com/topeomot2/all-links/issues/8) |
| [0006](../adr/0006-app-framework-and-iac.md) | App framework, API front door, IaC | [A5](https://github.com/topeomot2/all-links/issues/10) |
| [0007](../adr/0007-onboarding-and-username-claim.md) | Onboarding & username claim | [A6](https://github.com/topeomot2/all-links/issues/11) |
| [0008](../adr/0008-analytics-counting.md) | Analytics counting | [A4](https://github.com/topeomot2/all-links/issues/9) |
| [0009](../adr/0009-avatar-handling-and-upload-constraints.md) | Avatar handling | [A7](https://github.com/topeomot2/all-links/issues/15) |
| [0010](../adr/0010-abuse-takedown-and-rate-limiting.md) | Abuse, takedown & rate limiting | [A8](https://github.com/topeomot2/all-links/issues/16) |
| [0011](../adr/0011-social-unfurl-metadata-and-indexing.md) | Social unfurl metadata & indexing | [S3](https://github.com/topeomot2/all-links/issues/22) |

**Amendment chain** (why the merged tree differs from any single branch):

```
0006 ──amends──▶ 0004  (/app/* row: shell no-store, hashed assets immutable)
0008 ──amends──▶ 0004  (adds /r/* behavior)
0009 ──amends──▶ 0004  (removes /a/*; two requests → one)
     ──amends──▶ 0003  (avatarKey → avatarWebp)
0010 ──amends──▶ 0003  (Page gains suspendedAt; visibility = active && !suspendedAt)
     ──amends──▶ 0004  (names the sole invalidation trigger)
     ──amends──▶ 0007  (delete-on-reclaim; harvest skips suspended; +terms/privacy)
0011 ──amends──▶ 0003  (Page gains avatarW/avatarH; bio capped at 160)
     ──amends──▶ 0004  (adds /i/* behavior — six behaviors)
     ──amends──▶ 0010  (suspension invalidates /i/<username> too)
```

ADR-0006, 0007, 0008, 0009 and 0010 each landed on a separate branch, so **no single branch shows the merged result**. This spec reads against all five merged together; the two collisions were both in ADR-0004's amendment table and were resolved by taking every amendment.
