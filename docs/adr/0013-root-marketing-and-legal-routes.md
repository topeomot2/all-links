---
status: accepted
---

# ADR-0013 — Root, marketing and legal routes

- **Date:** 2026-07-29
- **Decision ticket:** [S2 — Root, marketing and legal routes](https://github.com/topeomot2/all-links/issues/21)
- **Builds on:** ADR-0002 (pricing, the funnel), ADR-0004 (one distribution, renderer as catch-all, `s-maxage=60`, no routine invalidation), ADR-0006 (renderer Lambda, `core` as the shared package, CDK), ADR-0007 (reserved-name denylist, the flow beginning at "landing"), ADR-0008 (302-not-301), ADR-0010 (`/terms` + `/privacy` reserved), ADR-0011 (`robots.txt` contents, `og-card.png`, indexing rules)
- **Amends:** ADR-0004, ADR-0007, ADR-0011
- **Vocabulary:** see `CONTEXT.md` (Page, Username, Reserved name)

## Context

ADR-0004 made the renderer Lambda the **catch-all** for `/*`. Every ADR since has added *names* to the reserved denylist — ADR-0007 reserved `pricing`, `about`, `blog`, `docs`, `help`, `login`, `signup`; ADR-0010 added `terms` and `privacy`; ADR-0011 owed two files at the root — and **not one of them routed a path**.

The denylist stops a creator *claiming* the name `terms`. It does nothing about a request for `/terms`, which falls through to the username lookup, finds nothing, and renders ADR-0004's unclaimed-username placeholder.

So as inherited, the product's front door answers:

> **`linkix.io/`** — "this name is available — claim it."

A product competing on price, whose entire funnel is one signup, offers visitors the empty username. Assembly (S1, §11.2) surfaced this as one of three things no ticket owned, and called it plainly: *not shippable*.

### The root is not routable away from the renderer

The instinct is to hang marketing off the existing SPA bucket with a few CloudFront behaviors. **CloudFront cannot express it.** Two facts, both checked against AWS documentation rather than assumed:

1. **A bare `/` is not a usable path pattern.** CloudFront treats a leading slash as implied — the docs state `/*product.jpg` and `*product.jpg` are the same pattern — so `/` is the empty pattern. The default behavior's pattern is `*` and *cannot be changed*.
2. **The documented workaround makes it worse.** `DefaultRootObject: index.html` rewrites a request for `/` into a request for `/index.html`, which then falls through the behavior list to the same catch-all — and the renderer looks up the username `index.html`.

A third fact compounds it: under ADR-0006 the SPA bucket is reached by **OAC against S3's REST endpoint**, not the website endpoint, so S3 will not serve a directory index for `/` either.

This reframes the trade S1 presented as roughly even. The static-origin option is not "add some behaviors" — it is "add some behaviors **and** solve the root specially, with a CloudFront Function rewrite." And **the root is the page that matters most**, so the mechanism ends up split no matter what.

Meanwhile `/`, `/terms`, `/privacy`, `/robots.txt` and `/og-card.png` **already arrive at the renderer today**. Nothing needs routing. The renderer needs to answer.

## Decision

### Scope: three pages

v1 ships **`/`, `/terms`, `/privacy`**. Pricing is stated inline on the landing page, not on a route of its own.

No `about`, no `blog`, no `docs`, no `help`. A content pipeline is a recurring cost against a hard constraint — one solo founder and operational simplicity — and every one of those pages is a page nobody has written. They stay **reserved** (see below) so the names are there when they are wanted.

### Mechanism: a static route table in `core`

`core` gains `STATIC_ROUTES`, a map from exact path to a response descriptor. The renderer consults it **before any DynamoDB access** and returns directly on a hit; a miss falls through to the GSI1 username lookup exactly as ADR-0004 specifies.

| Path | Response | `Content-Type` |
|---|---|---|
| `/` | Landing page — pitch, pricing, CTA to `/app/` | `text/html` |
| `/terms` | Terms of Service | `text/html` |
| `/privacy` | Privacy Policy | `text/html` |
| `/robots.txt` | ADR-0011's contents | `text/plain` |
| `/og-card.png` | Brand card, base64 in the bundle, `isBase64Encoded: true` | `image/png` |
| `/login`, `/signup` | **302 → `/app/`** | — |
| `/pricing` | **302 → `/#pricing`** | — |

**Zero new CloudFront behaviors. Zero new origins. Zero new deploy units.** The distribution is untouched; the catch-all does what it already did.

Three properties follow:

- **Marketing pages never read DynamoDB.** The short-circuit is above the query, so `/` costs a Lambda invocation and nothing else.
- **The renderer already emits self-contained HTML with inlined CSS** (ADR-0004) using Preact `render-to-string` (ADR-0006). Marketing pages are the same machinery with different components — no second rendering path to keep working.
- **Redirects are `302`, not `301`**, reusing ADR-0008's reason: a permanent redirect is cached in browsers we do not control, and none of these targets is settled enough to burn in.

Marketing pages get their **own inline CSS**. Marketing is not a Theme, and hanging it on the Theme system would couple the landing page to a creator-facing enum.

### Freshness: `s-maxage=300`

```
Cache-Control: public, s-maxage=300, max-age=0
```

`Cache-Control` is a **response** header, so the renderer varies TTL per route on the same behavior. A different TTL for marketing needs **no new CloudFront behavior** — a fact worth stating, because it is the reason this decision costs nothing structurally.

Pages stay at `s-maxage=60`. **No invalidation is added**: ADR-0004's "exactly one thing invalidates" (a suspension, ADR-0010) survives intact.

Five minutes is chosen from both ends. It is short enough that **a copy fix never needs an invalidation** — which is what keeps ADR-0004's single trigger single. And it is long enough to cut the front door's cold-start exposure ~5×.

**That second reason, not cost, is the real one.** The cost difference between 60s and 300s is a rounding error (~$0.20/M requests). But `/` is the hottest single path in the system and the least forgiving audience arrives there — someone who clicked an ad and will decide in two seconds. Revalidating every 60 seconds per edge means that visitor pays for a cold Lambda far more often than they should.

A day-long TTL was rejected in both forms: **without** invalidation, a wrong price or a typo in Terms is live for 24 hours with no lever; **with** deploy-time invalidation, ADR-0004 gains a second invalidation trigger that can be forgotten, to buy a rounding error.

### Reserved names answer honestly

Seven reserved names ship **unrouted**. The defect here is narrower than S1 §11.2 reported, and more characteristic: **ADR-0004's negative-path table already has a "Username reserved → neutral body, no CTA" row.** It was written *before* ADR-0007 created the reserved `Set`, and **no ADR ever said the renderer consults it.** The case was named, the data was built, and nothing joined them — so the observed behaviour is the unclaimed placeholder, and `linkix.io/login` answers *"the name `login` is available — claim it."* That is false: it is reserved and unclaimable. (ADR-0007's "reserved and taken produce distinct error copy" governs the **dashboard availability check**, not the public 404.)

ADR-0013 makes the join explicit, and adds redirects where a 404 is the wrong answer:

- **`/login`, `/signup` → 302 `/app/`.** Real user intent. ADR-0007's flow begins at "landing" and never said where someone who types the obvious thing ends up.
- **`/pricing` → 302 `/#pricing`.** The name is reserved and the content exists; it just isn't a page.
- **`about`, `blog`, `docs`, `help` → ADR-0004's reserved-404 body**, which now actually fires.

The reserved Set already lives in `core`, which the renderer already depends on, so this is a set-membership test on a path that has already missed the route table. It closes the same defect S2 exists to fix, one radius smaller.

### The denylist is derived, not maintained

ADR-0007 left a **standing rule**: any route added must gain its denylist entry in the same PR. Rules people must remember are precisely what ADR-0007 and ADR-0010 kept replacing with structure — the lazy harvest that needs no sweeper, the delete-on-reclaim that needs no counter.

```ts
export const RESERVED = new Set([...BASE_RESERVED, ...STATIC_ROUTES.keys()]);
```

Adding a route reserves its name **in the same expression**. The rule stops being a discipline and becomes an identity. `BASE_RESERVED` keeps the names with no route behind them — routes-in-waiting (`about`, `blog`, `docs`, `help`), authority terms, and brand.

Both live in `core`, which already holds the username regex and the reserved Set (ADR-0006), so nothing moves and nothing new is shared.

### `www` redirects to the apex

`www.linkix.io` is served by **a second, small distribution whose origin is an S3 bucket configured to redirect all requests to `linkix.io`**. Zero code, zero runtime, a stock AWS pattern, ~$0.

The reason it cannot be done on the main distribution is specific and load-bearing: **ADR-0004's default behavior forwards no cookies and does not key on `Host`.** Adding `www` as an alias there would require either putting `Host` in the cache key — fragmenting every cached Page across two hostnames, doubling origin fetches to serve identical bytes — or a CloudFront Function running ahead of cache lookup, which is a new deploy unit and an adapter in front of routing, the shape ADR-0006 rejected meta-frameworks for.

A separate distribution keeps the main one's cache key exactly as ADR-0004 designed it. The price is one more certificate SAN and a CDK construct.

Apex-only was rejected: `www.linkix.io` would be a hard DNS failure with no page to explain it, on a product whose value is people typing an address.

### Indexing

Consistent with ADR-0011: the three marketing pages are **`index,follow`** with their own OG tags pointing at `/og-card.png`, and `twitter:card: summary` (ADR-0011's forced value — the card is square). Reserved-404s are **`noindex`**, matching ADR-0011's rule for placeholders.

### Path matching

Route lookup is **exact and lowercase**, with **one trailing slash stripped** before matching, so `/terms/` resolves. Usernames cannot end in a separator (ADR-0007), so the same strip is safe above the username lookup.

**Path case is deliberately left alone.** Lowercasing the path would make `/Terms` work, but it would also silently change how `/JaneDoe` resolves — and username casing belongs to ADR-0003 and ADR-0007, not here. `/Terms` therefore falls through to the unclaimed placeholder. Flagged, not fixed; it is a one-line change for whoever owns username casing.

## Amendments

**ADR-0004** — two changes, **neither of which adds a behavior**:

- The routing table gains a note: the default `/*` behavior serves a **static route table** from `core`, checked before the username lookup. The behavior list is unchanged at six.
- The freshness section gains a **second TTL tier**: `s-maxage=300` for static routes, `s-maxage=60` for Pages, emitted per-response by the same origin. The "no routine invalidation" rule and its single trigger are unchanged.

**ADR-0007** — the reserved denylist is now **derived** (`BASE_RESERVED ∪ keys(STATIC_ROUTES)`). The standing rule "any route added must gain its denylist entry in the same PR" is **retired**, having been made structurally true.

**ADR-0011** — `/robots.txt` and `/og-card.png` are **renderer routes, not static files on the SPA origin.** ADR-0011 assumed the latter; the root-routing constraint above means the renderer is answering anyway, and putting two of the five root paths on a different origin would split ownership of one small set of files for no gain. ADR-0011's *contents* for both are unchanged.

## Considered options

- **S3 origin with per-path behaviors.** The instinctive answer, and the one S1 presented as an even trade. Rejected on the two CloudFront facts above: it cannot serve `/`, so it needs a rewrite function on top, and the mechanism splits anyway around the most important page.
- **CloudFront Function rewriting `/` → `/site/index.html`, all-static marketing.** Fully static, deployable without touching Lambda. Rejected: a new deploy unit and a rewrite on the hot path, to decouple three files that change a few times a year.
- **Renderer for HTML, two exact-match S3 behaviors for `/robots.txt` and `/og-card.png`.** Legal path patterns, no rewrite needed, keeps a binary out of a JS bundle. Rejected as the weaker half of a split: two CDK behaviors and two places to look for five root files, to avoid ~40 KB of base64 in a bundle that is deployed by the same command.
- **A separate marketing site or CMS.** Rejected with the scope: it is a recurring content cost, and v1 has three pages.
- **Same `s-maxage=60` as Pages.** One TTL for the whole distribution and no ADR-0004 amendment at all. Genuinely tempting on simplicity; rejected because the front door is the one path where revalidation latency is paid by the least forgiving visitor.
- **`s-maxage=86400` with deploy-time invalidation.** Rejected: a second invalidation trigger, forgettable, in exchange for a rounding error.
- **Leaving reserved names on the unclaimed placeholder.** Zero work. Rejected as the same defect S2 was opened to fix, at a smaller radius.
- **302 every reserved name to `/`.** No dead ends, no copy to write. Rejected: `/blog` silently becoming the homepage is confusing rather than honest.
- **Two lists plus a unit test asserting containment.** Keeps both lists explicit and catches drift. Rejected: a test enforcing an invariant an expression can make unrepresentable.
- **`www` via a CloudFront Function on a main-distribution alias.** One distribution, one cert. Rejected on the cache-key argument above.
- **Apex only.** Rejected: a hard DNS failure is worse than a 404, because there is no page to explain it.

## Consequences

**Positive**

- **The front door stops offering to sell the empty username** — the one thing S1 called not shippable.
- **ADR-0004's reserved-404 body finally has something that fires it**, three ADRs after the Set it needs was built.
- **Zero new CloudFront behaviors, origins or deploy units.** The distribution ADR-0004 designed is untouched.
- **Marketing pages never touch DynamoDB**, so the landing page's cost is one Lambda invocation per edge per five minutes.
- **ADR-0007's standing denylist rule is retired by construction**, removing a class of bug — shipping a route whose name a creator already owns — that could only ever surface on deploy day.
- **ADR-0004 keeps exactly one invalidation trigger.**
- **`/login` and `/signup` stop being dead ends** on a product with exactly one funnel.

**Negative / accepted tradeoffs**

- **The renderer now has two jobs.** A bad marketing deploy breaks every public Page. It is one deploy unit either way, and the alternative was a second one — but this is a real coupling that did not exist before, and it should be the first thing suspected when Pages break after a copy change.
- **A copy fix is a renderer deploy.** In practice `cdk deploy` regardless, but marketing iteration now moves at the speed of a Lambda deploy.
- **The landing page states `$20/yr` and `$2.99/mo` (ADR-0002), and nothing enforces that against the Stripe catalogue.** Two sources of truth for the product's headline number, on a product competing on price. No mechanism proposed; written down so it is a known watch item.
- **`/Terms` 404s.** Deliberate — see Path matching.
- **`about`, `blog`, `docs` and `help` are reserved names with no pages**, which is honest but means four reserved-404s at launch.
- **`www` costs a second distribution and a certificate SAN** — small, but it is a second thing in CDK that must exist before launch.
- **The brand card and all three pages' copy do not exist.** Build-checklist items, not decisions.

## Build-checklist additions

- Write the landing page, Terms of Service and Privacy Policy copy.
- Legal review of Terms and Privacy before launch.
- `www` certificate SAN, the redirect bucket and its distribution in CDK.

*(`og-card.png` as a design asset is already on ADR-0011's checklist.)*
