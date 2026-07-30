import { GSI1_PROJECTED_ATTRIBUTES } from '@all-links/core';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../lib/app.js';

let app: App;
let dev: Template;
let prod: Template;

beforeAll(() => {
  app = buildApp(new App({ context: { alertEmail: 'ops@example.com' } }));
  dev = Template.fromStack(app.node.findChild('AllLinks-dev') as never);
  prod = Template.fromStack(app.node.findChild('AllLinks-prod') as never);
});

describe('one CDK app, two stacks', () => {
  it('defines dev and prod', () => {
    const stacks = app.node.children.filter((c) => Stack.isStack(c)).map((s) => s.node.id);

    expect(stacks.sort()).toEqual(['AllLinks-dev', 'AllLinks-prod']);
  });

  it('keeps the prod table when the stack goes away, and lets dev go', () => {
    prod.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
    dev.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
  });
});

describe('the table', () => {
  it('is on-demand, so it has no floor cost (ADR-0001)', () => {
    dev.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('is keyed PK/SK for one item collection per Account (ADR-0003)', () => {
    dev.hasResourceProperties('AWS::DynamoDB::Table', {
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ]),
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
    });
  });

  it('projects public attributes only into GSI1', () => {
    dev.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: {
            ProjectionType: 'INCLUDE',
            NonKeyAttributes: [...GSI1_PROJECTED_ATTRIBUTES],
          },
        }),
      ],
    });
  });

  it('cannot leak private attributes through the public index', () => {
    const table = Object.values(dev.findResources('AWS::DynamoDB::Table'))[0];
    const projected: string[] =
      table?.Properties?.GlobalSecondaryIndexes?.[0]?.Projection?.NonKeyAttributes ?? [];

    for (const priv of ['email', 'subscription', 'heldUsername']) {
      expect(projected).not.toContain(priv);
    }
  });

  it('expires the OTP throttle items it stores (ADR-0010)', () => {
    dev.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });

  it('keeps point-in-time recovery on in prod — the eraser has no other net', () => {
    prod.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });
});

describe('the renderer function', () => {
  it('is a Function URL locked to IAM, so the on.aws hostname is unusable directly', () => {
    dev.hasResourceProperties('AWS::Lambda::Url', {
      AuthType: 'AWS_IAM',
    });
  });

  it('is reachable only by CloudFront, over an OAC that signs every request', () => {
    dev.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: 'lambda',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      }),
    });

    dev.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunctionUrl',
      Principal: 'cloudfront.amazonaws.com',
      SourceArn: Match.anyValue(),
    });
  });

  it('has reserved concurrency — the cost ceiling under attack (ADR-0010)', () => {
    dev.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: Match.anyValue(),
      Runtime: 'nodejs22.x',
    });
  });

  it('knows the table and the stage it is running in', () => {
    dev.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ STAGE: 'dev', TABLE_NAME: Match.anyValue() }),
      },
    });
  });
});

describe('the distribution', () => {
  it('sends every path to the renderer through the OAC origin', () => {
    dev.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Enabled: true,
        Origins: [Match.objectLike({ OriginAccessControlId: Match.anyValue() })],
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
          Compress: true,
        }),
      }),
    });
  });

  it('forwards no cookies, so a dashboard session cannot fragment the public cache', () => {
    dev.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({
        ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
          CookiesConfig: { CookieBehavior: 'none' },
        }),
      }),
    });
  });

  it('lets the origin decide freshness, so the renderer can vary TTL per route', () => {
    dev.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({ MinTTL: 0, DefaultTTL: 0 }),
    });
  });

  it('sets no default root object — `/` must reach the renderer (ADR-0013)', () => {
    const distribution = Object.values(dev.findResources('AWS::CloudFront::Distribution'))[0];

    expect(distribution?.Properties?.DistributionConfig?.DefaultRootObject).toBeUndefined();
  });
});

describe('empty context', () => {
  // CI passes `-c alertEmail=${{ vars.ALERT_EMAIL }}`, which becomes a literal
  // `-c alertEmail=` when the repository variable is unset. Empty is missing.
  const empty = () =>
    buildApp(new App({ context: { alertEmail: '', region: '' } })).node.findChild(
      'AllLinks-dev',
    ) as never;

  it('never puts an empty address on the budget', () => {
    const budgets = Template.fromStack(empty()).findResources('AWS::Budgets::Budget');
    const subscribers = Object.values(budgets)[0]?.Properties?.NotificationsWithSubscribers ?? [];

    expect(subscribers.length).toBeGreaterThan(0);
    for (const entry of subscribers) {
      for (const subscriber of entry.Subscribers) {
        expect(subscriber.Address).toBeTruthy();
      }
    }
  });

  it('still resolves a region', () => {
    expect((empty() as unknown as Stack).region).toBe('us-east-1');
  });
});

describe('the budget', () => {
  it('is mandatory, and mails a real address (ADR-0001)', () => {
    dev.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetType: 'COST', TimeUnit: 'MONTHLY' }),
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({
          Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'ops@example.com' }],
        }),
      ]),
    });
  });
});
