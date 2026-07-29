---
status: accepted
---

# ADR-0011 — Social unfurl metadata and search indexing

- **Date:** 2026-07-29
- **Decision ticket:** [S3 — Social unfurl metadata (og:image after avatar inlining)](https://github.com/topeomot2/all-links/issues/22)
- **Builds on:** ADR-0003 (Page attributes), ADR-0004 (one distribution, `s-maxage=60`, no routine invalidation), ADR-0006 (renderer Lambda, Preact auto-escaping), ADR-0007 (username-only minimum profile, ≥3-char usernames), ADR-0008 (per-request cost model, `/r/*`, bot filtering), ADR-0009 (avatar as an inline `data:` URI), ADR-0010 (suspension + the sole invalidation trigger)
- **Amends:** ADR-0003, ADR-0004, ADR-0010
- **Vocabulary:** see `CONTEXT.md` (Page, Link, Theme, Suspension)

## Context

A link-in-bio Page exists to be pasted somewhere else — into an X post, a Discord message, an iMessage thread, a WhatsApp chat. **The unfurl is a large fraction of the product's surface area**, and it is the only part of it that renders inside someone else's app.

No ADR ever specified it. ADR-0004 rejected an SPA *partly on the grounds that OG previews need server-rendered tags* — and then never said which tags. Assembly (S1, §11) surfaced this as one of two things no ticket owned.

**What made it sharp rather than clerical:** ADR-0009 replaced the avatar's S3 object with a `data:` URI inlined in the document, and in doing so **removed `/a/*` — the only public image URL in the system**. Unfurlers cannot fetch a `data:` URI. So as inherited, `og:image` had no possible value.

### Reintroducing an image URL does not reopen ADR-0009

The obvious objection is that any image endpoint walks back a decision made eight ADRs deep. It does not. Every mechanism ADR-0009 removed was a consequence of **an immutable S3 object and the upload path** — none of them returns for a *read* endpoint keyed by username:

| ADR-0009 removed | Returns with `/i/<username>.webp`? |
|---|---|
| Key rotation (immutable long-TTL objects can't be overwritten) | **No** — the URL is the username, mutable, `s-maxage=60` like every other edit |
| Orphaned-object cleanup | **No** — there are no objects; bytes live on the Page item |
| An opaque key (ADR-0008 forbids `accountId` in a public URL) | **No** — the username *is* the public address |
| S3 bucket, presigned POST, `content-length-range` | **No** — the upload path is untouched |
| `sharp`/libvips on the upload path | **No** — nothing decodes; bytes are returned as stored |
| A second CloudFront request **per page view** (~$1/M — ADR-0008's dominant fee) | **No** — see below |

That last row is the load-bearing one. ADR-0009's cost case rested on ADR-0008's finding that the CloudFront request fee dominates, applied to a request incurred **once per view**. An unfurl fetch is incurred **once per share**, by a crawler, and is then cached both by our CDN and by the sharing platform. It is a different cost shape entirely — orders of magnitude fewer requests against the same fee.

ADR-0008 also established that crawlers fetch the HTML but not inline images. That property was used to keep `/px` view counts clean; it survives untouched, because `/i/*` is a different path than `/px` and unfurler traffic there counts nothing.

### The format risk

WebP is officially accepted for `og:image` by X, LinkedIn and Discord. **Meta's crawler is the open question**: WebP has been nominally supported since ~2024, but failures are still widely reported and the standing community workaround remains "serve the crawler a JPEG." This matters more than it would for most products — the founder sells into Europe, where **WhatsApp is a primary sharing path**.

Three ways out, priced against ADR-0008's model:

| | Cost | Result |
|---|---|---|
| **Serve the stored WebP** | $0 | Meta *may* degrade to a text-only unfurl |
| **Store JPEG instead of WebP** | ~12 KB vs ~6 KB → ~+8 KB base64 on **every cached document**, and §11.5's GSI1 read multiplier worsens (~+$0.9/M events vs +$0.5/M); ADR-0009's `RIFF`/VP8-header validator is rewritten for JPEG | Universal |
| **WebP inline + a JPEG companion item** outside the GSI1 projection | Two client encodes, two blobs, a new item type, a second read on unfurl. Hot path untouched | Universal |

The middle option taxes **every page view** to fix a **per-share** problem, and is rejected on that shape alone.

## Decision

### 1. `og:image` is a renderer route, `/i/<username>.webp`

Served by the **renderer Lambda as another route**, not a fourth deploy unit: it already runs the GSI1 query and already owns ADR-0010's `active && !suspendedAt` visibility gate. ADR-0006's shape (renderer / api / counter) is unchanged.

- Returns `avatarWebp` as `image/webp`, `s-maxage=60` — avatar edits self-heal on ADR-0004's clock, no invalidation.
- **Fallback is always a 302 to `/og-card.png`, never a 404** — for no avatar, lapsed, or suspended. The renderer normally points `og:image` straight at the brand card when there is no avatar, so `/i/*` sees these only in stale or racy cases, and a redirect means an unfurler never renders a broken card.
- The one-character prefix cannot collide with a username: ADR-0007 sets a 3-character minimum, the same argument that cleared `/px` and `/r/*`.

**WebP is served as stored.** The JPEG companion item is written down as a **pre-decided escalation** in ADR-0010's WAF idiom — mechanism agreed, cost zero until triggered:

> **Trigger:** Meta's sharing debugger shows no image for a Page that has an avatar.
> **Mechanism:** the dashboard's canvas encode emits a JPEG alongside the WebP; it is stored as a separate item under the Account, **outside the GSI1 projection**, and read only by `/i/*` (which then content-negotiates on `User-Agent`). The hot path — the document, the analytics reads — is not touched.

### 2. `/og-card.png` — a static square brand card

`twitter:card` is **always `summary`**, never `summary_large_image`. This is forced and then made useful: the avatar is ≤256×256, below `summary_large_image`'s 300×157 minimum, so an avatar *cannot* drive a large card. Making the brand card square too means **the card type never varies** — only the `og:image` URL does — and the renderer carries no branch.

The brand card is a **static PNG** on the SPA's existing S3 origin, which has a second effect worth naming: **the format risk above applies only to Pages that have an avatar.** The no-avatar case — a large share of Pages, since ADR-0007 lets them launch username-only — is universally safe for free.

### 3. Declared image dimensions

ADR-0009's validator **already parses intrinsic width and height** from the VP8 / VP8L / VP8X header to enforce the ≤256² check, and then discards them. They are now persisted on the Page item (see *Amendments*), which buys two things:

- `og:image:width` / `og:image:height` / `og:image:type` — the cheapest available hedge on the Meta risk, since declaring dimensions is the documented fix for a large class of crawler failures.
- `width` / `height` on the **inline** `<img>`, eliminating layout shift on a document that ships no JavaScript to correct it.

ADR-0009 fits the avatar *within* a 256×256 box preserving aspect, so real dimensions vary per Page and must be declared per Page. Forcing an exact 256×256 by center-cropping was rejected: with no crop UI in v1 it beheads a large fraction of photographs.

### 4. The tag set

| Tag | Value |
|---|---|
| `<title>`, `og:title`, `twitter:title` | `displayName`, plus ` (@username)` **only when the two differ** |
| `og:description`, `twitter:description` | `bio`; when empty → `All of @<username>'s links, in one place.` |
| `og:image`, `twitter:image` | `/i/<username>.webp`, or `/og-card.png` when there is no avatar |
| `og:image:width`, `og:image:height`, `og:image:type` | from the persisted dimensions |
| `og:url` + `<link rel="canonical">` | `https://<domain>/<username>` |
| `og:type` + `profile:username` | `profile` |
| `og:site_name` | the product name |
| `twitter:card` | `summary` |

Three notes:

- **The `(@username)` suffix is conditional** because ADR-0007's claim flow defaults `displayName` to the username. Unconditional appending would render "jane (@jane)" on every day-one Page.
- **The empty-bio line is generated rather than omitted.** A card with a blank description reads as broken; ADR-0009 already made this argument for the monogram — a day-one Page must look deliberate.
- **`bio` is capped at 160 characters at the API.** `og:description` truncates around 160–200 anyway; capping at input keeps one source of truth and spares the renderer truncation logic.

All values are user-supplied and land in attribute position. ADR-0006 chose Preact `render-to-string` for exactly this reason — JSX escapes attribute values as well as children, so meta-tag interpolation inherits the same guarantee as the visible document.

### 5. Indexing

**Pages are `index,follow`.** Organic discovery is free distribution for creators and a real thing to sell against Linktree. `noindex` on: the unclaimed placeholder, the lapsed 404, the suspended notice, and `/app/*`. The first three already return HTTP 404, but the tag costs one line and covers the suspended case, which ADR-0010 invalidates precisely so it stops being served.

**Outbound anchors carry `rel="nofollow ugc noopener"`, and `robots.txt` disallows `/r/`, `/px`, `/api/`, `/app/`.** This is one decision doing two jobs:

- **Click hygiene becomes structural, not heuristic.** ADR-0008 counts a click server-side at `/r/*` and defends the count with free heuristics (UA denylist, same-origin `Referer`). Indexable Pages would otherwise invite every compliant crawler to increment `clickCount` by following the anchors. `Disallow: /r/` excludes them at the source — the same move ADR-0008 made in choosing a pixel over `sendBeacon`.
- **It removes the incentive to abuse us.** User-supplied URLs on a shared domain with no `rel` is a free PageRank pipe, which is exactly the traffic ADR-0010 has no tooling for beyond one founder's inbox. ADR-0008's 302-not-301 choice already means little equity flows even where a crawler ignores `robots.txt`; `nofollow ugc` makes it explicit.

The price: a creator who wants link equity flowing to their own site does not get it. Neither do Linktree's.

**No sitemap in v1.** Discovery is the creator sharing their own link — that is the product. A machine-generated index of every Page is also the most attractive artifact we could hand an SEO spammer, and enumerating usernames needs a scan or a second index that does not exist. Recorded as build-later, not a scope exclusion.

**No per-Page "hide from search engines" toggle in v1** — a Page attribute, a dashboard control and a renderer branch for a preference almost nobody sets at launch, with no tier structure in ADR-0002 to hang it on.

**Scope boundary:** this ADR decides what `robots.txt` *says* and that `/og-card.png` is a static asset. Routing `/robots.txt` and `/og-card.png` belongs to **[S2 — Root, marketing and legal routes](https://github.com/topeomot2/all-links/issues/21)**, which is already deciding what answers `/`, `/terms` and `/privacy`.

## Amendments

**ADR-0003** — the Page item gains **`avatarW`** and **`avatarH`** (small ints, written by the api Lambda from the header values ADR-0009's validator already parses; absent when there is no avatar), and **`bio` is capped at 160 characters**.

**ADR-0004** — the distribution gains a **sixth behavior**:

| Behavior | Origin | Caching |
|---|---|---|
| `/i/*` (unfurl image) | **page renderer Lambda** | `s-maxage=60` — added by ADR-0011 |

`/og-card.png` and `/robots.txt` are static files on the existing SPA origin; their behavior wiring is S2's.

Note this does **not** revisit ADR-0009's "one request per page view" — `/i/*` is never fetched by a browser rendering the Page, only by a crawler unfurling a link to it.

**ADR-0010** — the suspension action's invalidation must cover **`/i/<username>` as well as `/<username>`**. One more path in the same call; without it a suspended creator's avatar keeps serving for up to 60 s inside every unfurl that already exists. Volume remains far inside the free 1,000 paths/month.

## Considered options

- **Omit `og:image` entirely.** Zero machinery, and honest about what ADR-0009 left us. Rejected: a naked text unfurl is the product's most-seen surface looking broken next to the incumbent's.
- **Generate a 1200×630 card per Page** (name, monogram, theme). Needs image encoding in Lambda — the `sharp`-class dependency ADR-0009 spent a whole decision removing, now on the *read* path instead of the write path.
- **Store JPEG rather than WebP.** Universal, one blob — but taxes every view to fix a per-share problem. See the table above.
- **`/i/*` as its own Lambda.** A fourth deploy unit that would duplicate the renderer's GSI1 query and its visibility gate, with a second place for the gate to drift.
- **`noindex` on all Pages.** Avoids being an SEO-spam target on a shared domain, but discards the only distribution channel that is not the creator's own posting — and ADR-0010 already chose takedown as the lever for abuse over pre-emptive lockdown.
- **Dofollow outbound links** as a creator-facing SEO feature. Rejected: it is precisely the property that makes a link-in-bio host worth abusing.

## Consequences

- **`og:image` has a real URL again**, at the cost of one route, one static PNG and one CloudFront behavior — no bucket, no new deploy unit, no upload-path change.
- **Meta unfurls may be text-only at launch.** Accepted knowingly, with the trigger and the fix pre-agreed. X, Discord, Slack, iMessage and LinkedIn are unaffected.
- **Every outbound link becomes `nofollow`** — permanently, in the sense that reversing it later invites exactly the traffic we are trying not to attract.
- **Click counts get a structural defence** they did not have when ADR-0008 was written, which is a strict improvement to a number ADR-0008 could only call approximate.
- **The Page item grows by two ints and loses 160+ characters of bio range.** Both are noise against the 24 KB avatar blob already there.
- **Two files at the root are now owed by S2** (`robots.txt`, `og-card.png`) that S2 did not know about when it was written.
- **The brand card is a design asset nobody has made yet** — a build-checklist item, not a decision.
