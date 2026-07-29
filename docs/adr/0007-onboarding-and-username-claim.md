---
status: accepted
---

# ADR-0007 — Onboarding and username claim

- **Date:** 2026-07-29
- **Decision ticket:** [A6 — Onboarding & username-claim flow](https://github.com/topeomot2/all-links/issues/11)
- **Builds on:** ADR-0002 (card-up-front signup, lapse policy), ADR-0003 (single-table model, Username uniqueness item), ADR-0004 (path routing at the root), ADR-0005 (Cognito passwordless OTP)

## Context

The username **is** the product — it is the address the creator hands out, and it lives at the root of the domain (ADR-0004 rejected confining app routes under a prefix). Onboarding therefore has to settle who may take a name, when they take it relative to paying, and what happens to a name nobody paid for.

Two prior decisions constrain the shape:

- **Card up front** (ADR-0002) means signup already passes through a hosted checkout and every Account has a Subscription from the moment it is usable. The funnel has one wall in it already; a second one is expensive.
- **`active` is a pure function of Subscription status** (ADR-0002's single state machine, mirrored onto the Page by ADR-0003). Anything that gates page visibility on something *other* than billing reintroduces the account state that decision collapsed.

ADR-0003 left two things explicitly to this ticket: the contents of the reserved-username denylist, and how it is enforced.

## Decision

### Flow

```
landing → email → Cognito OTP (ADR-0005)
  ↓  post-confirmation Lambda: Account (active=false)
claim username          ← availability is known HERE, before any payment
  ↓  writes the Username item only
hosted checkout (card, 5-day trial — ADR-0002)
  ↓  billing webhook: trialing
Page created, active=true → live at ourapp.com/<username>
  ↓
editor, empty state prompting the first Link
```

**Username is claimed before checkout.** The handle is what the creator is buying; discovering it is taken *after* paying is a refund path. No profile fields sit between the claim and the card.

### Username rules

```
^(?=.{3,30}$)[a-z0-9]+(?:[_-][a-z0-9]+)*$
```

3–30 characters, `a-z 0-9 - _`. **Lowercase-canonical**: typed uppercase is silently lowercased rather than rejected. The body is alphanumeric runs joined by *single* separators, so a separator can never lead, trail, or double; the lookahead carries the length bound. No percent-encoding is ever possible in a Page URL.

Uniqueness is on the literal name. Separator-collapsing uniqueness (`janedoe` blocking `jane-doe`) was considered and rejected — see below.

### Reserved names

A frozen `Set` in the shared `core` package, checked before the claim transaction, in three buckets:

1. **Routing and marketing namespace**, reserved ahead of need — `api`, `app`, `login`, `signup`, `pricing`, `about`, `terms`, `privacy`, `help`, `blog`, `docs`, `status`, `contact`, `admin`, …
2. **Authority and impersonation** — `support`, `billing`, `security`, `staff`, `team`, `official`, `moderator`, `abuse`, `legal`, `noreply`, `www`, `mail`
3. **The product's own brand** and near-variants

Of the live CloudFront behaviours (ADR-0004: `/api/*`, `/app/*`, `/a/*`, `/px`), only `api` and `app` can collide — `a` and `px` are already excluded by the 3-character minimum.

**No profanity list.** False positives are endemic (the Scunthorpe problem), the list needs perpetual maintenance, and abuse already has a lever in Page takedown.

**Amended by ADR-0013 — the Set is now derived, not maintained.** `RESERVED = BASE_RESERVED ∪ keys(STATIC_ROUTES)`, both in `core`. Bucket 1 above splits: names with a live route (`terms`, `privacy`, `login`, `signup`, `pricing`) come from the route table; names reserved ahead of need (`about`, `blog`, `docs`, `help`, `status`, `contact`, …) stay in `BASE_RESERVED`, as do buckets 2 and 3. Adding a route reserves its name in the same expression, which **retires the standing rule** below.

### Holds and reclaim

A claim writes **only** the Username item — `{ ownerAccountId, claimedAt }`:

```
CLAIM      put Username
             attribute_not_exists(PK)
             OR (holder inactive AND claimedAt < now - 7d)
```

**An unpaid hold lasts 7 days**, and is harvested **lazily, on contention only** — there is no sweeper, no scheduled job, no TTL. A held name that nobody else wants simply stays held, at zero cost. ADR-0002's *canceled + 30 days → username released* rides the same condition, so one mechanism implements both releases.

The two windows are deliberately different: a signup that never paid earns less protection than a customer who did.

### Page creation

**The Page is created by whichever of {claim, billing webhook} completes second**, in a transaction guarded by a `ConditionCheck` that the Username item still names this Account:

```
TransactWriteItems
  ConditionCheck  Username.ownerAccountId == me
  put Page        GSI1PK=USERNAME#<name>, displayName=<name>, active=true
  update Account  subscription
```

In the normal order the webhook is second and creates the Page. Stating the rule by *ordering* rather than by *event* also covers the rare recovery case where the webhook's `ConditionCheck` loses the race: the Account is paid but nameless, and the next successful claim creates the Page.

Because a claim touches one item, **reclaiming a stale hold is a single-item overwrite with no Page anywhere to orphan** — two Pages sharing one `GSI1PK` is structurally impossible rather than prevented by remembering to clean up.

### Minimum profile

**Username only.** `displayName` defaults to the username; bio, avatar and Links are all optional. `active` stays a pure function of Subscription status.

### Rename

Same regex, same denylist, same claim transaction. The old name is **released immediately** back to the pool (ADR-0004 already accepted that old URLs 404 with no redirect table). Rate-limited to **once per 30 days** via a `lastRenamedAt` attribute on the Account — ADR-0003 assumes renames are rare because each one rewrites `GSI1PK` across the Page and every Link, and this is what makes that assumption true.

### Availability check

Applies the **same 7-day staleness rule** as the claim. Otherwise the UI reports a stale hold as taken while the transaction would have accepted it — worse than either answer consistently. Reserved and taken produce distinct error copy.

## Considered options

- **Claim after checkout.** Names are only ever held by paying accounts, so squatting is zero. Rejected: the creator pays before learning whether their handle is available.
- **Claim before checkout with no reclaim.** Simplest possible v1; rejected because abandoned signups squat names permanently for no gain over a lazy check that costs nothing until contended.
- **A sweeper job / DynamoDB TTL to release holds.** Rejected: TTL deletion lags by up to 48h and cannot express "only if never paid", and a scheduled job is operational surface for a release that only ever matters at the moment of contention.
- **Separator-collapsing uniqueness** (`janedoe` reserves `jane-doe` and `jane_doe`). Strongest anti-impersonation, rejected: a second uniqueness key, and "why is this taken?" becomes unanswerable to the creator.
- **`a-z0-9` only, no separators.** Kills the confusable class outright and trivialises the denylist, rejected as too far from the handles creators expect to type.
- **Reserved names as seeded Username items** owned by a system account. One atomic mechanism, and reserving a name becomes a data write rather than a deploy. Rejected: needs a CDK seeding resource, and the reclaim condition would need a special case so reserved rows are never harvested. The code list also couples a reservation to the route it protects — they land in the same PR.
- **Requiring display name, or a first Link, before the page goes live.** Rejected: the first narrows an already-walled funnel for little gain; the second can only be enforced by gating `active` on profile completeness, which puts a second condition on the flag ADR-0002 made purely billing-driven.
- **Page created at claim time**, with reclaim deleting or nulling the loser's Page. Lets the editor be used before paying, at the cost of an invariant that depends on every reclaim path remembering to clean up.

## Consequences

**Positive**

- Availability is known before any payment — the refund path closes.
- One condition expresses both the 7-day unpaid hold and ADR-0002's 30-day canceled reservation.
- No scheduled jobs, no TTL, no seeding resource: username lifecycle costs $0 until two people want the same name.
- Two Pages sharing a username is structurally unreachable.
- `active` remains a pure function of Subscription status.

**Negative / accepted tradeoffs**

- **Abandoned signups hold names indefinitely if uncontended.** Accepted — an uncontended hold harms nobody, and the harvest happens exactly when it matters.
- **A creator who abandons at the card wall and returns after 7 days may find their handle gone**, with no warning email. Accepted for v1.
- **Confusable handles can coexist** (`jane-doe`, `jane_doe`, `janedoe`). Accepted; impersonation is handled reactively via takedown.
- **No profanity filter at claim time** — offensive handles are possible until reported.
- The paid-but-nameless recovery path is rare but real, and must be tested rather than assumed away.

**Downstream constraints this imposes**

- ~~`core` owns the reserved `Set` and the username regex; adding a root route means adding its reservation in the same PR.~~ **Retired by ADR-0013:** `core` still owns both, but the reserved `Set` is derived from the static route table, so adding a root route reserves its name structurally — there is no longer a rule to remember.
- Account gains `lastRenamedAt`; the Username item carries `claimedAt` (ADR-0003 listed only `ownerAccountId`).
- Post-auth routing must resolve four states: active → dashboard; inactive with no username → claim; inactive holding a username → resume checkout; inactive whose hold was reclaimed → claim, with a notice.
- **Rate-limiting the OTP-send and claim endpoints** (SES cost, username enumeration) is not settled here — it belongs with the abuse/takedown story.
