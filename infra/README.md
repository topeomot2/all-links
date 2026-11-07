# infra

One CDK app, two stacks — `AllLinks-dev` and `AllLinks-prod` (ADR-0006). T1
deploys `dev` only; `prod` is defined but untouched until T17.

## What T1 creates

| Resource | Why it looks like that |
|---|---|
| DynamoDB table, **on-demand** | No floor fee, scales to zero, cheap atomic counters (ADR-0001) |
| GSI1, `INCLUDE` projection | Built from `core`'s `GSI1_PROJECTED_ATTRIBUTES`, so private attributes cannot reach the public index. The Account item has no `GSI1PK` at all |
| Renderer Lambda | Node 22, arm64, ESM bundle, reserved concurrency as the cost ceiling (ADR-0010) |
| Function URL, `AWS_IAM` | The `*.lambda-url.*.on.aws` hostname answers 403 to anyone who is not CloudFront signing with SigV4 |
| One CloudFront distribution | Default behavior → renderer over OAC, **no cookies** in the cache key, no `DefaultRootObject` so `/` reaches the renderer (ADR-0013) |
| AWS Budgets alarm | Mandatory per ADR-0001 — the backstop on accepted egress risk |

## What T7 adds

| Resource | Why it looks like that |
|---|---|
| Cognito user pool, **Essentials** | Passwordless email OTP, no floor fee (ADR-0005). Email is the sign-in name; the `sub` is the accountId. No identity providers — Google is post-v1 |
| SPA app client | No secret, `USER_AUTH` + refresh only, 60-day refresh token, 1-hour access token, token revocation on |
| Post-confirmation Lambda | Writes the Account item (`attribute_not_exists`, so a retry is harmless). Its role may `PutItem` and nothing else |
| api Lambda + Function URL (`AWS_IAM`) | Hono routing, Cognito JWT verified in process with cached JWKS — **no API Gateway**. Reserved concurrency, like the renderer |
| `/api/*` behavior | OAC origin, `CachingDisabled`, forwards only `x-authorization` and `content-type` — no cookies, never `Host`. (`x-amz-*` names are refused in a policy; OAC passes `x-amz-content-sha256` through itself) |
| Dashboard bucket | Private, read over S3 OAC. Shell + `config.json` at `app/` with `no-store`; hashed assets at `app/assets/` with `immutable`, one year. Never pruned, so an open tab survives a deploy |
| `/app/assets/*`, `/app/*` behaviors | Assets cached a year; the shell uncached, with a CloudFront Function serving `index.html` for any non-file path — so a dashboard deploy needs **no invalidation** |

**The token is in `x-authorization`, not `Authorization`.** OAC signs every
origin request with SigV4, and that signature *is* the `Authorization` header —
CloudFront overwrites the viewer's. The dashboard therefore sends
`x-authorization: Bearer <access token>`. Still a header and never a cookie, so
ADR-0004's no-cookie public cache holds. A future `POST`/`PUT` must also send
`x-amz-content-sha256` (the body's SHA-256): Lambda rejects unsigned payloads
behind OAC.

**Deploys need the dashboard built first.** Synth reads
`packages/dashboard/dist`; without it the stack would ship a placeholder shell.
That is fine for `synth` and the tests, and an error once
`-c requireDashboardBuild=true` is passed, as the deploy workflow does.

Freshness is the renderer's, not the distribution's: the cache policy sets
`MinTTL`/`DefaultTTL` to 0, so the origin's `Cache-Control` decides. That is
what lets one behavior serve `s-maxage=60` Pages and `s-maxage=300` static
routes (ADR-0013).

## First deploy

```bash
export AWS_PROFILE=…                       # a real account
npx cdk bootstrap                          # once per account/region
npm run build:dashboard
npm run deploy:dev -w @all-links/infra -- -c alertEmail=you@example.com -c requireDashboardBuild=true
./tools/verify-deployment.sh AllLinks-dev
```

`alertEmail` is where the Budgets alarm mails. Without it, synth warns and
falls back to `alerts@example.invalid`, which nobody reads. Set it as CDK
context (`-c alertEmail=…`) or `$ALERT_EMAIL`.

Region defaults to `us-east-1`; override with `-c region=…` or
`$CDK_DEFAULT_REGION`. One region, per ADR-0001.

## The domain is one configured value

`baseDomain` (context, or `$BASE_DOMAIN`) defaults to the registered apex,
**`linkix.io`**. Each stage derives its hostname from it and nothing else:

| Stage | Hostname | `SITE_ORIGIN` given to the renderer |
|---|---|---|
| `prod` | `linkix.io` | `https://linkix.io` |
| `dev` | `dev.linkix.io` | `https://dev.linkix.io` |

The renderer cannot work its own hostname out. CloudFront reaches it over a
Function URL — so the `Host` it sees is `*.lambda-url.*.on.aws` — and ADR-0004
keeps `Host` out of the cache key, because forwarding it would fragment every
cached Page across apex and `www`. The stack therefore injects `SITE_ORIGIN`,
and `packages/renderer/src/config.ts` is the only thing that reads it:
canonical URLs and `og:url` (ADR-0011) are built there.

Dev gets a real subdomain rather than borrowing the distribution's generated
`*.cloudfront.net` name for the same reason it cannot be inferred: passing that
name into the Lambda's environment would make the function depend on the
distribution that already depends on the function.

### Certificate, aliases and DNS

Two more values in `cdk.json` turn the hostname on, and both stages share them:

| Context | Value | Why it is an id, not a lookup |
|---|---|---|
| `certificateArn` | the wildcard ACM cert (`linkix.io` + `*.linkix.io`), **us-east-1** | `Certificate.fromCertificateArn` needs no credentials, so CI still synths without AWS |
| `hostedZoneId` | the public zone for `baseDomain` | same reason — `HostedZone.fromLookup` would need an account and a credentialed synth |

With both present a stage gets: the alias on its distribution, the certificate,
and `A` + `AAAA` alias records at its hostname. With either missing the stage
falls back to its generated CloudFront hostname and synth says so. `SiteUrl`
(where the stack answers) and `SiteOrigin` (what the renderer calls itself) are
both outputs, and are the same thing only once the domain is wired.

`www` is prod-only and is **not** an alias on the page distribution — it is an
S3 website-redirect bucket behind its own small distribution (`HttpsRedirect`),
because aliasing it here would force `Host` into the public cache key
(ADR-0013). The wildcard cert covers it, so it needs no second certificate.

### The DNS records, and who owns each

`linkix.io` is a Route 53 public zone (`Z05137581JRU2TJI2GT7A`) in the same
account as the stacks, with the registrar's nameservers already delegated to
it. Everything below the delegation is CloudFormation's:

| Record | Type | Points at | Created by |
|---|---|---|---|
| `dev.linkix.io` | `A` + `AAAA` alias | the dev page distribution | `AllLinks-dev` — **deployed** |
| `linkix.io` | `A` + `AAAA` alias | the prod page distribution | `AllLinks-prod` — at launch |
| `www.linkix.io` | `A` + `AAAA` alias | the `www` redirect distribution | `AllLinks-prod` — at launch |
| `_ec1ed793….linkix.io` | `CNAME` | ACM validation | issued by hand; **leave it** — deleting it breaks certificate renewal |
| `linkix.io` | `NS`, `SOA` | — | the zone itself |

**The apex and `www` do not resolve until `AllLinks-prod` is deployed.** That
is one command with no manual DNS step: the same `certificateArn` and
`hostedZoneId` already in `cdk.json` create both hostnames' records and the
redirect distribution.

**Nothing should be added here by hand.** Three alias records and three
distribution aliases were once set in the console; because CloudFormation
issues `CREATE` and not `UPSERT` for a `RecordSet`, a manual record at a name a
stack owns fails the deploy that would have created it — and a manual alias on
a CDK-managed distribution is silently dropped by the next deploy. Both were
removed when the domain was wired.

Launch checklist, in order:

1. `cdk deploy AllLinks-prod` — creates the apex and `www` records.
2. `./tools/verify-deployment.sh AllLinks-prod`.
3. `curl -sI https://www.linkix.io/` returns **301** to `https://linkix.io/`.
4. Check a live Page in Meta's sharing debugger (spec §10 item 13) — the first
   moment `og:url` and `og:image` can be verified against a real hostname.

`tools/verify-deployment.sh` checks what only a deployed stack can answer: the
site returns renderer HTML, repeat requests come from the CloudFront cache
(`HIT` on `/`, a rising `age` on a 404), both Function URLs return **403** when
hit directly, `/api/me` refuses a request with no token, and the dashboard
shell and a deep link both answer `no-store`.

## What a human identity needs

CI does not use any of this — it assumes a role over OIDC (below). This is for
a laptop. Prefer an IAM Identity Center permission set over an IAM user with
long-lived access keys; the policies are the same either way.

Almost all the power lives in the **bootstrap roles**, not in your identity.
`cdk deploy` assumes `cdk-hnb659fds-deploy-role-…`, which passes
`cdk-hnb659fds-cfn-exec-role-…` to CloudFormation, and *that* role is what
creates resources — `AdministratorAccess` unless you bootstrapped with
`--cloudformation-execution-policies`. So the identity you keep needs almost
nothing.

**Bootstrapping is the exception.** `cdk bootstrap` creates IAM roles, the
assets bucket and an SSM parameter; it is not meaningfully scopable. Run it
once with an admin session, then never again.

**Tier 1 — deploy.** Enough for `cdk deploy`, `cdk diff`, `cdk destroy` and
`tools/verify-deployment.sh`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "AssumeCdkRoles", "Effect": "Allow", "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::<ACCOUNT>:role/cdk-hnb659fds-*-<ACCOUNT>-<REGION>" },
    { "Sid": "VerifyScript", "Effect": "Allow", "Action": "cloudformation:DescribeStacks",
      "Resource": "arn:aws:cloudformation:<REGION>:<ACCOUNT>:stack/AllLinks-*/*" },
    { "Sid": "BootstrapVersion", "Effect": "Allow", "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:<REGION>:<ACCOUNT>:parameter/cdk-bootstrap/hnb659fds/version" }
  ]
}
```

**Tier 2 — `cdk watch`.** Hotswap does **not** go through the deploy role.
`hotswapDeployment` asks for an SDK with `forEnvironment(env, ForWriting)` and
no `assumeRoleArn`, so it calls Lambda directly with *your* credentials
(checked against aws-cdk 2.1134). Without these it still works, but every
change falls back to a full CloudFormation deploy and the ~5–10 s loop is lost:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow",
      "Action": ["lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration", "lambda:GetFunction"],
      "Resource": "arn:aws:lambda:<REGION>:<ACCOUNT>:function:AllLinks-dev-*" },
    { "Effect": "Allow",
      "Action": ["cloudformation:DescribeStacks", "cloudformation:DescribeStackResources", "cloudformation:GetTemplate"],
      "Resource": "arn:aws:cloudformation:<REGION>:<ACCOUNT>:stack/AllLinks-dev/*" }
  ]
}
```

**Tier 3 — the local dev server, from T2.** It reads the real dev table, not
DynamoDB Local (ADR-0006):

```json
{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow",
    "Action": ["dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
               "dynamodb:DeleteItem", "dynamodb:BatchWriteItem", "dynamodb:TransactWriteItems"],
    "Resource": ["arn:aws:dynamodb:<REGION>:<ACCOUNT>:table/AllLinks-dev-Table*",
                 "arn:aws:dynamodb:<REGION>:<ACCOUNT>:table/AllLinks-dev-Table*/index/GSI1"] }]
}
```

Scope tiers 2 and 3 to `AllLinks-dev*`: nothing on a laptop should be able to
reach prod. As later tickets add Cognito, SES, EventBridge Scheduler and the
SPA bucket, tier 1 does not change — those resources are created by the
`cfn-exec-role`, not by you. Only tiers 2 and 3 grow.

## CI deploys with OIDC, not keys

`.github/workflows/deploy-dev.yml` assumes a role via GitHub's OIDC provider —
there are no long-lived AWS keys in CI (ADR-0006). The job stays **skipped**
until these repository variables exist:

| Variable | Example |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::123456789012:role/all-links-deploy-dev` |
| `AWS_REGION` | `us-east-1` |
| `ALERT_EMAIL` | `you@example.com` |

`BASE_DOMAIN` is optional — unset, it is `linkix.io`.

Create the provider and role once, by hand, in the target account — it is the
credential the pipeline needs before the pipeline exists:

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
```

Trust policy for the role, scoped to this repository's `main`:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:topeomot2@1574124/all-links@1315063734:ref:refs/heads/main"
      }
    }
  }]
}
```

This repository uses GitHub's immutable subject format, so the `sub` carries the
owner and repository IDs. `gh api repos/topeomot2/all-links/actions/oidc/customization/sub`
returns the prefix.

The `sub` also depends on the workflow. Adding `environment:` to the deploy job
replaces the `ref:refs/heads/main` suffix with `environment:<name>`, and this
policy then denies the job until it is updated to match.

The role needs permission to assume CDK's bootstrap roles, which is what
actually performs the deploy, and to read the stack outputs for
`tools/verify-deployment.sh`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::<account>:role/cdk-*" },
    { "Effect": "Allow",
      "Action": "cloudformation:DescribeStacks",
      "Resource": "arn:aws:cloudformation:<region>:<account>:stack/AllLinks-dev/*" }
  ]
}
```

## Not here yet

The `/px`, `/r/*` and `/i/*` behaviors arrive with the tickets that need them
(T5, T6). SES for the OTP mail is P3; until then Cognito sends it, capped at 50
a day.
