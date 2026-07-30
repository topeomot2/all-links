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

Freshness is the renderer's, not the distribution's: the cache policy sets
`MinTTL`/`DefaultTTL` to 0, so the origin's `Cache-Control` decides. That is
what lets one behavior serve `s-maxage=60` Pages and `s-maxage=300` static
routes (ADR-0013).

## First deploy

```bash
export AWS_PROFILE=…                       # a real account
npx cdk bootstrap                          # once per account/region
npm run deploy:dev -w @all-links/infra -- -c alertEmail=you@example.com
./tools/verify-deployment.sh AllLinks-dev
```

`alertEmail` is where the Budgets alarm mails. Without it, synth warns and
falls back to `alerts@example.invalid`, which nobody reads. Set it as CDK
context (`-c alertEmail=…`) or `$ALERT_EMAIL`.

Region defaults to `us-east-1`; override with `-c region=…` or
`$CDK_DEFAULT_REGION`. One region, per ADR-0001.

`tools/verify-deployment.sh` checks the two things only a deployed stack can
answer: the site returns renderer HTML and a second request is a CloudFront
`HIT`, and the Function URL returns **403** when hit directly.

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
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:topeomot2/all-links:ref:refs/heads/main" }
    }
  }]
}
```

The role needs permission to assume CDK's bootstrap roles, which is what
actually performs the deploy:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "sts:AssumeRole",
    "Resource": "arn:aws:iam::<account>:role/cdk-*"
  }]
}
```

## Not here yet

The `/api/*`, `/px`, `/r/*`, `/i/*` and `/app/*` behaviors, the SPA bucket, the
Cognito user pool, the custom domain and certificate, and the `www` redirect
distribution all arrive with the tickets that need them. T1 is the walking
skeleton: one origin, one behavior, one path through the whole system.
