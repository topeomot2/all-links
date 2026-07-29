---
status: accepted
---

# ADR-0003 — DynamoDB single-table data model

- **Date:** 2026-07-28
- **Decision ticket:** [A1 — DynamoDB single-table data model](https://github.com/topeomot2/all-links/issues/6)
- **Builds on:** ADR-0001 (AWS serverless / DynamoDB on-demand), ADR-0002 (payments — merchant of record)
- **Vocabulary:** see `CONTEXT.md` (Account, Page, Link, Username, Theme, Subscription)

## Context

v1 stores everything in one DynamoDB table (ADR-0001). The hot path is rendering a public **Page** by **Username** to the whole internet; the private path is a creator managing their own Account/Page/Links. The design must serve the public page in one query, keep private data (email, Subscription) structurally off the public path, and support atomic per-Link click counters and cheap reordering.

## Decision

**Single table**, one item-collection per account under `PK = ACCOUNT#<accountId>` (accountId is the immutable identity — the auth subject / a ULID). Four item types:

| Item | Keys | Notable attributes |
|---|---|---|
| **Account** (private) | `SK=ACCOUNT` | email, auth subject; Subscription block: `status`, `plan`, `trial_end`, `current_period_end`, `mor_customer_id`, `mor_subscription_id`. **No `GSI1PK`** → never on the public path. |
| **Page** (public) | `SK=PAGE`, `GSI1PK=USERNAME#<name>`, `GSI1SK=0` | username, displayName, `bio` (**≤160 chars — ADR-0011**), ~~`avatarKey` (→ S3)~~ → **`avatarWebp`** (inline blob, ≤24 KB — ADR-0009) with **`avatarW`/`avatarH`** (intrinsic dimensions — ADR-0011), `themeId`, `pageViewCount` (atomic `ADD`), **`active`** (mirrored visibility flag) |
| **Link** (public) | `SK=LINK#<ulid>`, `GSI1PK=USERNAME#<name>`, `GSI1SK=1#<rank>` | label, url, `rank` (fractional index), `clickCount` (atomic `ADD`) |
| **Username** (uniqueness) | `PK=USERNAME#<name>`, `SK=USERNAME#<name>` | `ownerAccountId` (**removable — ADR-0012**); **`tombstonedAt`** (burnt handle — ADR-0012); written with `attribute_not_exists` inside the signup / rename transaction |

**GSI1** (public read): `GSI1PK` / `GSI1SK`, projecting **public attributes only**. A public render is a single `Query GSI1 where GSI1PK=USERNAME#<name>` → the Page (`GSI1SK=0`) followed by Links in `rank` order.

**Access patterns:** public render = 1 GSI1 query; dashboard = `Query PK=ACCOUNT#<id>`; Link CRUD/reorder = single-item writes (reorder updates one `rank`); click/view = atomic `ADD`; Subscription gate = get Account item.

**Public visibility gate** (amended by **ADR-0010**) = `active && !suspendedAt`. The Page item gains **`suspendedAt`** — a moderation attribute, orthogonal to `active` and never written by the billing webhook — and both attributes arrive in the same GSI1 query, so the check costs no extra read.

**Amended by ADR-0011:** the Page gains **`avatarW`/`avatarH`** — the intrinsic dimensions ADR-0009's validator already parses from the WebP header and discarded — so the renderer can declare `og:image:width`/`height` and size the inline `<img>`; and **`bio` is capped at 160 characters** at the API, matching `og:description` truncation so the renderer needs no truncation logic.

**Amended by ADR-0012:** the Username item gains **`tombstonedAt`**, and `ownerAccountId` becomes **removable** rather than fixed for the item's lifetime. Together they let a suspended handle stay burnt through an erasure while retaining no personal data — the item degenerates from an account record into a denylist entry. This also moves ADR-0010's "never harvest a suspended Page's handle" clause off the **Page** and onto the Username item, so the claim's condition reads only the item it is already writing. **New access pattern:** erasure = `Query PK=ACCOUNT#<id>` → `BatchWriteItem` delete, plus a conditional write to the Username item.

**Username** is changeable: a rename is a transaction (claim new Username item, release old, rewrite `GSI1PK` across Page + all Link items). Old URLs 404 — no redirect table in v1.

## Considered options

- **One Account+Page item vs. two.** Chose **two** (Account private, Page public) so the username GSI indexes only public items — private data (email/Subscription) is *structurally* unreachable on the public read path, not merely un-projected.
- **Links as separate items vs. an array on the Page.** Chose **separate items** so a click is an atomic `ADD` on an isolated item; the array approach makes every click a contended whole-object rewrite with no atomic per-link increment.
- **Ordering: fractional `rank` vs. integer position vs. position-in-SK.** Chose **fractional `rank`** — O(1) reorder (one write) and stable Link identity (SK) so click counts survive reordering. Position-in-SK rejected (SKs immutable → reorder orphans counters).

## Consequences

- **The mirrored `active` flag on the Page item** is the load-bearing cross-cutting piece: the public read never touches the private Account item, so it can't see Subscription status. The billing webhook (ADR-0002) updates both the Account Subscription block *and* the Page `active` flag; the public path gates visibility on `active` alone. This is what makes "hide a lapsed Page" implementable without a private read — and it means **every subscription-state change must write the Page `active` flag**, or lapsed pages stay visible.
- Username uniqueness and renames require **`TransactWriteItems`**; a rename is O(number of Links) writes (rare).
- Reserved-username denylist is enforced in-app before the claim (contents TBD in the onboarding flow).
- ~~Avatars are S3 objects referenced by `avatarKey`; the upload flow is implementation detail for the build.~~ **Amended by ADR-0009:** there is no avatar object. `avatarKey` becomes **`avatarWebp`** — a ≤24 KB WebP blob stored on the Page item and projected into GSI1 with the other public attributes, inlined by the renderer as a `data:` URI.
