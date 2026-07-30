import { Annotations, App } from 'aws-cdk-lib';

import { AllLinksStack } from './all-links-stack.js';

/** Used when no `alertEmail` is configured; `.invalid` can never be delivered. */
const PLACEHOLDER_ALERT_EMAIL = 'alerts@example.invalid';

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

  const env = {
    account: process.env['CDK_DEFAULT_ACCOUNT'] || undefined,
    region: configured('region', process.env['CDK_DEFAULT_REGION']) ?? 'us-east-1',
  };

  const dev = new AllLinksStack(app, 'AllLinks-dev', {
    stage: 'dev',
    alertEmail,
    monthlyBudgetUsd: 20,
    rendererReservedConcurrency: 10,
    env,
  });

  const prod = new AllLinksStack(app, 'AllLinks-prod', {
    stage: 'prod',
    alertEmail,
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
