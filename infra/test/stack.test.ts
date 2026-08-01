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

  // It is reached over a Function URL and ADR-0004 forwards no `Host`, so the
  // canonical origin has to be injected — one configured base domain, two
  // stages (#27).
  it('is told the origin it serves, because it cannot infer one', () => {
    dev.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ SITE_ORIGIN: 'https://dev.linkix.io' }) },
    });
    prod.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ SITE_ORIGIN: 'https://linkix.io' }) },
    });
  });

  it('takes the domain from configuration, so one value moves both stages', () => {
    const overridden = buildApp(new App({ context: { baseDomain: 'example.test' } }));

    Template.fromStack(overridden.node.findChild('AllLinks-dev') as never).hasResourceProperties(
      'AWS::Lambda::Function',
      { Environment: { Variables: Match.objectLike({ SITE_ORIGIN: 'https://dev.example.test' }) } },
    );
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

describe('the site domain', () => {
  // Values shaped like the real ones; the real ones live in cdk.json, which a
  // test never reads.
  const wired = buildApp(
    new App({
      context: {
        baseDomain: 'example.test',
        certificateArn: 'arn:aws:acm:us-east-1:111122223333:certificate/11111111-2222-3333-4444-555555555555',
        hostedZoneId: 'Z0000000000000000000',
      },
    }),
  );
  const wiredDev = Template.fromStack(wired.node.findChild('AllLinks-dev') as never);
  const wiredProd = Template.fromStack(wired.node.findChild('AllLinks-prod') as never);

  it('serves each stage under the wildcard certificate', () => {
    wiredDev.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['dev.example.test'],
        ViewerCertificate: Match.objectLike({
          AcmCertificateArn: Match.stringLikeRegexp('^arn:aws:acm:us-east-1:'),
        }),
      }),
    });
  });

  it('points the hostname at the distribution over both IPv4 and IPv6', () => {
    for (const type of ['A', 'AAAA']) {
      wiredDev.hasResourceProperties('AWS::Route53::RecordSet', {
        Type: type,
        Name: 'dev.example.test.',
        AliasTarget: Match.anyValue(),
      });
    }
  });

  it('keeps `www` off the page distribution — an alias there would key on Host', () => {
    const aliases = Object.values(wiredProd.findResources('AWS::CloudFront::Distribution'))
      .flatMap((d) => d.Properties?.DistributionConfig?.Aliases ?? [])
      .filter((alias: string) => alias.startsWith('www.'));

    // `www` is served, but by the redirect distribution, not this one.
    wiredProd.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ Aliases: ['example.test'] }),
    });
    expect(aliases).toEqual(['www.example.test']);
    wiredProd.resourceCountIs('AWS::CloudFront::Distribution', 2);
  });

  it('redirects `www` from an S3 website bucket, not from code (ADR-0013)', () => {
    wiredProd.hasResourceProperties('AWS::S3::Bucket', {
      WebsiteConfiguration: {
        RedirectAllRequestsTo: { HostName: 'example.test', Protocol: 'https' },
      },
    });
  });

  it('gives dev no `www` — nobody types www.dev', () => {
    wiredDev.resourceCountIs('AWS::CloudFront::Distribution', 1);
    wiredDev.resourceCountIs('AWS::S3::Bucket', 0);
  });

  it('falls back to the CloudFront hostname when the domain is unconfigured', () => {
    const bare = Template.fromStack(
      buildApp(new App({ context: { certificateArn: '', hostedZoneId: '' } })).node.findChild(
        'AllLinks-dev',
      ) as never,
    );
    const distribution = Object.values(bare.findResources('AWS::CloudFront::Distribution'))[0];

    expect(distribution?.Properties?.DistributionConfig?.Aliases).toBeUndefined();
    bare.resourceCountIs('AWS::Route53::RecordSet', 0);
  });
});

describe('empty context', () => {
  // CI passes `-c alertEmail=${{ vars.ALERT_EMAIL }}`, which becomes a literal
  // `-c alertEmail=` when the repository variable is unset. Empty is missing.
  const empty = () =>
    buildApp(new App({ context: { alertEmail: '', region: '', baseDomain: '' } })).node.findChild(
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

  it('never hands the renderer a half-built origin', () => {
    Template.fromStack(empty()).hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ SITE_ORIGIN: 'https://dev.linkix.io' }) },
    });
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
