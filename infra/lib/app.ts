import { Annotations, App } from 'aws-cdk-lib';

import { AllLinksStack, type Stage } from './all-links-stack.js';

/** Used when no `alertEmail` is configured; `.invalid` can never be delivered. */
const PLACEHOLDER_ALERT_EMAIL = 'alerts@example.invalid';

/**
 * The registered apex (#27). The one place the domain is written down: every
 * other use — the renderer's canonical URLs, the certificate, the aliases —
 * derives from it, so there is no second literal to fall out of step.
 */
const DEFAULT_BASE_DOMAIN = 'linkix.io';

/**
 * `prod` is the apex, `dev` is a real subdomain of it.
 *
 * Dev cannot borrow the distribution's generated `*.cloudfront.net` hostname
 * instead: feeding it to the renderer as an environment variable would make
 * the Lambda depend on the distribution that already depends on the Lambda.
 */
export function siteDomainFor(stage: Stage, baseDomain: string): string {
  return stage === 'prod' ? baseDomain : `${stage}.${baseDomain}`;
}

/**
 * Two stacks from one app (ADR-0006). T1 deploys `dev` only.
 *
 * Stacks are environment-agnostic apart from the region, so `cdk synth` and
 * the infra tests run without AWS credentials; `cdk deploy` picks up the
 * account from the caller's profile.
 */
export function buildApp(app: App = new App()): App {
  /**
   * CI passes `-c alertEmail=${{ vars.ALERT_EMAIL }}`, which arrives as a
   * literal `-c alertEmail=` when the repository variable is unset. An empty
   * value is a missing one — otherwise the budget gets a blank subscriber and
   * the region resolves to nothing.
   */
  const configured = (name: string, fallback?: string): string | undefined => {
    const candidates = [app.node.tryGetContext(name) as string | undefined, fallback];
    return candidates.find((value) => value !== undefined && value !== '');
  };

  const alertEmail = configured('alertEmail', process.env['ALERT_EMAIL']) ?? PLACEHOLDER_ALERT_EMAIL;
  const baseDomain = configured('baseDomain', process.env['BASE_DOMAIN']) ?? DEFAULT_BASE_DOMAIN;

  /**
   * Both by ARN/id rather than by lookup: `HostedZone.fromLookup` needs a
   * concrete account and AWS credentials at synth time, which would cost CI
   * and the infra tests the property that they run without either.
   *
   * One wildcard certificate (`linkix.io` + `*.linkix.io`) covers the apex,
   * `www` and every stage subdomain, so both stacks take the same ARN.
   */
  const certificateArn = configured('certificateArn', process.env['CERTIFICATE_ARN']);
  const hostedZoneId = configured('hostedZoneId', process.env['HOSTED_ZONE_ID']);
  const hostedZone = hostedZoneId ? { id: hostedZoneId, name: baseDomain } : undefined;

  const env = {
    account: process.env['CDK_DEFAULT_ACCOUNT'] || undefined,
    region: configured('region', process.env['CDK_DEFAULT_REGION']) ?? 'us-east-1',
  };

  const dev = new AllLinksStack(app, 'AllLinks-dev', {
    stage: 'dev',
    alertEmail,
    domainName: siteDomainFor('dev', baseDomain),
    certificateArn,
    hostedZone,
    monthlyBudgetUsd: 20,
    rendererReservedConcurrency: 10,
    env,
  });

  const prod = new AllLinksStack(app, 'AllLinks-prod', {
    stage: 'prod',
    alertEmail,
    domainName: siteDomainFor('prod', baseDomain),
    certificateArn,
    hostedZone,
    monthlyBudgetUsd: 100,
    rendererReservedConcurrency: 100,
    env,
  });

  if (alertEmail === PLACEHOLDER_ALERT_EMAIL) {
    for (const stack of [dev, prod]) {
      Annotations.of(stack).addWarningV2(
        'all-links:budget-alert-email',
        `No alertEmail configured — the Budgets alarm will notify ${PLACEHOLDER_ALERT_EMAIL}, ` +
          'which nobody reads. Set it with `-c alertEmail=you@example.com` or $ALERT_EMAIL.',
      );
    }
  }

  return app;
}
