---
status: accepted
---

# ADR-0005 — Authentication: Cognito, passwordless email OTP

- **Date:** 2026-07-28
- **Decision ticket:** [A3 — Auth: method + service](https://github.com/topeomot2/all-links/issues/8)
- **Builds on:** ADR-0001 (AWS serverless), ADR-0002 (payments / card-up-front signup), ADR-0003 (Account identity)

## Context

v1 needs creator authentication. Because there is no free tier (card up front — ADR-0002), **auth MAU equals paying creators**, so a fixed monthly floor fee is punishing at low scale, while per-MAU cost is negligible against a $2–3/mo price. Auth must also fit the AWS stack (ADR-0001) and supply the stable subject id that is the Account identity (ADR-0003).

Current pricing (2026-07-28): Cognito has **no floor** (Lite $0.0055/MAU, Essentials $0.015/MAU, both 10k MAU free); Clerk and Supabase carry a **$25/mo Pro floor**.

## Decision

- **Service: Amazon Cognito User Pool, Essentials tier.**
- **Method: passwordless email OTP** (6-digit code). No passwords stored.
- **Email delivery: Amazon SES** in production (SPF/DKIM/DMARC on the sending domain); Cognito sends OTP through it.
- **Identity:** the Cognito `sub` **is** the Account's `authSubject` / `accountId` (ADR-0003). A **post-confirmation Lambda trigger** creates the Account item (`active=false`, no subscription yet).
- **Sessions:** Cognito JWTs with a **long refresh token (~30–90 days)** so creators rarely re-OTP; API calls authorize by verifying the Cognito JWT.
- **Signup ordering (card up front):** OTP verify → Account created (`active=false`) → **Stripe hosted checkout** → billing webhook sets subscription `trialing` and flips Page `active=true` (page goes live for the trial).

## Considered options

- **Clerk** — best-in-class DX, but a **$25/mo floor** that is ~20% of revenue at 50 creators, plus an external vendor and auth outside AWS. Rejected on floor economics at low scale.
- **Supabase Auth** — would mean running a Postgres product for auth alongside DynamoDB. Rejected on fit.
- **Roll-your-own** on Lambda+DynamoDB — cheapest, but owns password hashing, sessions, recovery, token issuance, rate-limiting: a large security surface for a solo dev. Rejected on risk.
- **Email + password (Cognito Lite)** — familiar and no email-on-login dependency, but owns reset/recovery flows and password liability. Rejected in favour of passwordless.
- **Magic link vs OTP** — OTP chosen; magic links break across devices/mail clients.

## Consequences

- Passwordless puts **email on the critical login path** → SES must be production-grade with good deliverability. (SES is needed for billing/system email regardless.)
- Essentials tier ($0.015/MAU after 10k free) → **effectively $0 auth cost up to 10k paying creators**, no floor.
- Long refresh tokens keep OTP friction rare — the main UX risk of passwordless is mitigated.
- **Google social login is deferred** to post-v1 (add as a fast-path if signup conversion needs it).
