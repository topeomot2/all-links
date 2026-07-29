---
status: accepted
---

# ADR-0009 — Avatar handling and upload constraints

- **Date:** 2026-07-29
- **Decision ticket:** [A7 — Avatar upload constraints](https://github.com/topeomot2/all-links/issues/15)
- **Builds on:** ADR-0003 (single-table data model — `avatarKey`), ADR-0004 (serving — the `/a/*` behavior), ADR-0006 (framework — the SPA dashboard and api Lambda), ADR-0008 (analytics — the per-request cost model)
- **Amends:** ADR-0003, ADR-0004
- **Vocabulary:** see `CONTEXT.md` (Page, Theme)

## Context

ADR-0003 gave the Page an `avatarKey` pointing at an S3 object and called the upload flow "implementation detail for the build". ADR-0004 gave that object a CloudFront behavior — `/a/*`, immutable, long TTL — and closed by naming the debt explicitly: avatar delivery "exposes an egress and abuse vector — upload size/format limits and resize-on-upload are still to be decided."

The ticket asked for three numbers: a size cap, an accepted format list, and a yes/no on re-encoding. Answering them inside the inherited design turns out to cost more than replacing it.

**What the inherited design actually obliges us to build.** An immutable, long-TTL object cannot be overwritten in place, so every avatar change must mint a **new key** — which means key rotation, and then orphaned-object cleanup, and then a decision about whether cleanup is a sweeper or lazy. The key must also be **opaque**: ADR-0008 established that `accountId` is the Cognito `sub` and must never appear in a public URL, so `/a/<accountId>/…` is closed off and the key needs its own identifier. Enforcing a cap *at* S3 means presigned POST with a `content-length-range` policy; enforcing it in Lambda means the bytes transit a Lambda. Guaranteeing a ceiling and stripping EXIF means a server-side decode, which means `sharp`/libvips — a ~30 MB native layer on the upload path, built for the right architecture, with its own cold start.

That is five interlocking mechanisms in service of one small square image.

**The cost fact that reframes it.** ADR-0008 established that the **CloudFront request fee (~$1/M) dominates** — it is larger than the DynamoDB write it was being compared against. ADR-0004 budgeted "two requests per page view (document + avatar)". The avatar is therefore not a rounding error on the read path: it is **half of the request cost of the product's hot path**, spent on ~6 KB that could have travelled inside a document already being sent.

Measured against that, the numbers land differently than expected:

| | Separate S3 object | Inlined in the document |
|---|---|---|
| CloudFront requests / 1M views | +1M (~**$1.00**) | 0 |
| Extra egress / 1M views | ~5 KB × 1M (~$0.43) | ~8 KB × 1M (~**$0.60**) |
| Machinery | key rotation, orphan cleanup, presigned upload, `/a/*` behavior, S3 bucket | none |

Inlining is marginally *cheaper*, and the cost column was never the point — the machinery column is. Cost is a wash; operational surface is not, and operational simplicity is a standing hard constraint for a solo founder.

## Decision

**The avatar is not an S3 object.** It is a small WebP blob stored on the Page item and inlined into the rendered document as a `data:` URI.

### Pipeline

```
dashboard (SPA)                    api Lambda                      renderer
─────────────────────────────      ────────────────────────        ──────────────────
<input accept="image/*">
  → decode in <img>            →   POST /api/page/avatar
  → drawImage to canvas,           (base64 in JSON)
    fit within 256×256 box     →   validate (below)          →     inline as
  → toBlob('image/webp', 0.8)      → write Page item               data:image/webp;base64
  ≈ 6 KB
```

The **client** re-encodes; the **server** validates. Neither decodes an image the way a library would.

### Validation — the whole abuse boundary

With no S3 bucket and no presigned URL, the api Lambda is the only path to the bytes. It enforces three checks, in `core`, in **pure JavaScript with no dependencies**:

1. **Hard cap: 24 KB decoded.** ~4× a typical 256 px WebP — generous for the honest case, useless for the dishonest one.
2. **Magic bytes:** the blob must begin `RIFF` … `WEBP`.
3. **Intrinsic dimensions ≤ 256×256**, read directly from the VP8 / VP8L / VP8X header — roughly forty lines, no decode, no allocation proportional to the image.

Check 3 is what makes check 1 meaningful: without it a 24 KB blob can still declare itself 4000×4000 and force every viewer's browser to decode and downscale a bomb. Together they mean a scripted client bypassing the dashboard entirely cannot store a multi-megabyte blob, a decode bomb, an SVG, or a non-image. Its best available attack is ≤24 KB of inert bytes on a page it is already paying for.

### Formats

**In:** anything the browser can decode — `accept="image/*"`. **Out:** WebP, always.

This inverts the usual SVG question. SVG is dangerous because it is script-bearing on a public surface; here it is **safe as an input precisely because it cannot survive as an output** — canvas re-encoding makes SVG-out structurally impossible rather than denylisted. The same mechanism flattens animated GIF/WebP to a first frame, which is a feature: no animated avatars, and no code written to prevent them.

The dashboard rejects files over 10 MB before decoding. This is a **UX guard, not a security control** — it stops a phone choking on a 40 MB HEIC. The security control is the 24 KB server cap, which the client cannot influence.

### Storage and rendering

The blob lives on the **Page** item, inside the GSI1 public projection, so a public render remains **one GSI1 query** (ADR-0003) with no second lookup. A few KB on an item read roughly once per Page per minute — ADR-0004's `s-maxage=60` origin rate — is noise against both RCU and the 400 KB item limit.

The renderer emits `<img src="data:image/webp;base64,…">` with `object-fit: cover`. The client scales to *fit* a 256 px box and CSS crops to fill, so there is **no crop UI to build** and the visual result is identical to a server-side centre crop.

**No avatar → a themed monogram**: a CSS circle in the Theme's accent color bearing the first character of the display name, falling back to the username. Zero bytes, zero requests, no `<img>` element. ADR-0007 set the minimum profile at username-only, so a large share of Pages go live with no avatar at all; they should look deliberate on day one rather than broken, and the layout must not jump when an avatar arrives later.

### Amendment to ADR-0004

The **`/a/*` behavior and the avatar S3 bucket are removed.** After ADR-0008 added `/r/*`, the distribution returns to **five behaviors**.

ADR-0004's "**two requests per page view**" becomes **one** — document only, avatar included, monogram or not. On the product's hot path, against the cost line ADR-0008 identified as dominant, that is a halving.

The reserved-name denylist is unaffected: ADR-0007's 3-character minimum already excluded `a` structurally, so retiring the route removes nothing that was being defended.

### Amendment to ADR-0003

The Page's **`avatarKey` (S3 pointer) becomes `avatarWebp`** — the base64 blob itself, projected into GSI1 with the rest of the public attributes.

## Considered options

- **Keep `/a/*`, re-encode server-side with `sharp`.** The rigorous answer: a guaranteed ceiling and EXIF stripped no matter what the client does. Rejected for what it drags in — a ~30 MB native libvips layer, architecture-specific builds, cold starts on the upload path — and because the guarantee it buys over client-encode-plus-header-validation is narrow: both bound the stored bytes and the stored dimensions.
- **Keep `/a/*`, store as uploaded, cap via presigned S3 POST `content-length-range`.** Enforces the cap at S3 with no image library and no Lambda in the byte path — genuinely elegant. Rejected because it accepts whatever arrives: EXIF (including GPS) intact, arbitrary dimensions, client-asserted content type, and the full key-rotation and orphan-cleanup burden still to build.
- **Upload the original through the api Lambda for server-side validation only, no re-encode.** Half-measure: pays the Lambda byte-path cost without buying the ceiling or the EXIF strip.
- **A default silhouette placeholder instead of a monogram.** Consistent layout for avatar-less Pages, but every such Page looks identical and reads as an unfilled stock default.
- **Omitting the avatar element entirely when absent.** Least code and arguably most honest, but a new Page looks unfinished and the layout shifts when an avatar is added.
- **Raising the cap to permit larger avatars.** Rejected: the Page renders one avatar at one modest display size. A larger cap buys pixels no viewer sees, on bytes shipped with every document.

## Consequences

**Accepted tradeoffs**
- **~+8 KB on every cached document.** Base64 costs a third over raw and does not gzip well. Paid back by the request it removes; still, the public document grows meaningfully in relative terms.
- **A hostile client can skip the client-side resize.** Bounded to ≤24 KB of magic-byte-and-header-valid inert bytes on its own paying Page. Accepted as immaterial.
- **No server-side decode**, so a deliberately malformed WebP with a well-formed header reaches viewers, and the only thing between it and them is the browser's own decoder. This is the browser's threat model, not ours.
- **Client-side canvas re-encode** is quality-lossier than libvips and varies slightly across browsers. Invisible at 256 px.
- **Avatar upload requires JavaScript.** The dashboard is already a React SPA (ADR-0006); the *public* Page remains zero-JS.
- **EXIF stripping is a side effect of canvas, not a server guarantee.** A scripted client could upload EXIF-bearing bytes — but only its own, ≤24 KB, on its own Page.

**Problems this removes rather than solves**
- **Immutable-key rotation**: gone. Avatar edits now ride ADR-0004's `s-maxage=60` like every other edit — the same 60-second lag, the same self-healing, no new-key dance.
- **Orphaned-object cleanup**: gone. There are no objects.
- **`accountId` leakage into public URLs** (ADR-0008's constraint): gone. There is no public avatar URL to leak into.
- **S3-as-free-hosting**: gone. There is no publicly addressable bucket.

**Constraints this imposes downstream**
- **A8 (abuse & takedown):** an abusive avatar is now removed by a **Page item write**, not an S3 delete — and it goes dark within 60 s with no invalidation, matching how abusive text is already handled. One takedown mechanism, not two.
- **Final spec assembly (S1):** the routing table is five behaviors; the Page item carries `avatarWebp`; the api Lambda needs no image dependency and the CDK stack no avatar bucket.
