import { existsSync } from 'node:fs';

import { GSI1_PROJECTED_ATTRIBUTES } from '@all-links/core';
import { App, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../lib/app.js';

let app: App;
let dev: Template;
let prod: Template;

/** The one page distribution's config — dev has no `www` distribution. */
function distributionConfig(template: Template): any {
  const distributions = Object.values(template.findResources('AWS::CloudFront::Distribution'));
  expect(distributions).toHaveLength(1);
  return distributions[0]?.Properties?.DistributionConfig;
}

function behavior(template: Template, pattern: string): any {
  return distributionConfig(template).CacheBehaviors.find(
    (b: { PathPattern: string }) => b.PathPattern === pattern,
  );
}

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

  it('knows the table, the stage, and the apex its abuse mailto points at', () => {
    dev.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          STAGE: 'dev',
          TABLE_NAME: Match.anyValue(),
          // The apex, not this stage's host: reports must reach a real mailbox
          // from dev too (ADR-0010).
          BASE_DOMAIN: 'linkix.io',
        }),
      },
    });
  });

  it('may read the table and nothing more — every write path is the api Lambda’s', () => {
    dev.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith(['dynamodb:Query']),
          }),
        ]),
      }),
    });

    // The public read path is one GSI1 query, so the grant has to cover the
    // index as well as the table itself (ADR-0003).
    const policies = dev.findResources('AWS::IAM::Policy');
    const renderer = Object.entries(policies).filter(([id]) => id.startsWith('Renderer'));
    expect(renderer).toHaveLength(1);
    const actions = JSON.stringify(renderer);

    expect(actions).not.toContain('dynamodb:PutItem');
    expect(actions).not.toContain('dynamodb:UpdateItem');
    expect(actions).not.toContain('dynamodb:DeleteItem');
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
    const config = distributionConfig(dev);
    const origin = config.Origins.find(
      (o: { Id: string }) => o.Id === config.DefaultCacheBehavior.TargetOriginId,
    );

    expect(origin?.OriginAccessControlId).toBeDefined();
    expect(JSON.stringify(origin)).toContain('RendererFunctionUrl');
    dev.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Enabled: true,
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
    // The dashboard bucket is the only one, and it is no website.
    wiredDev.resourceCountIs('AWS::S3::Bucket', 1);
    wiredDev.resourcePropertiesCountIs(
      'AWS::S3::Bucket',
      { WebsiteConfiguration: Match.anyValue() },
      0,
    );
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

  it('has no fixed name, so changing its subscriber can replace it', () => {
    dev.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetName: Match.absent() }),
    });
  });
});

describe('auth (ADR-0005)', () => {
  it('is a Cognito pool on Essentials with passwordless email OTP', () => {
    dev.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolTier: 'ESSENTIALS',
      UsernameAttributes: ['email'],
      AutoVerifiedAttributes: ['email'],
      Policies: Match.objectLike({
        SignInPolicy: { AllowedFirstAuthFactors: Match.arrayWith(['EMAIL_OTP']) },
      }),
    });
  });

  it('has no social identity providers — Google is deferred past v1', () => {
    dev.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 0);
  });

  it('gives the SPA a secretless client that can only run USER_AUTH', () => {
    dev.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      ExplicitAuthFlows: ['ALLOW_USER_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      PreventUserExistenceErrors: 'ENABLED',
    });
  });

  it('has no hosted UI, OAuth grants or callback URLs', () => {
    const client = Object.values(dev.findResources('AWS::Cognito::UserPoolClient'))[0];

    expect(client?.Properties?.AllowedOAuthFlows).toBeUndefined();
    expect(client?.Properties?.CallbackURLs).toBeUndefined();
  });

  it('keeps a long refresh token so an Account rarely re-OTPs', () => {
    dev.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      RefreshTokenValidity: 60 * 24 * 60,
      TokenValidityUnits: Match.objectLike({ RefreshToken: 'minutes' }),
    });
  });

  it('creates the Account from a post-confirmation trigger', () => {
    dev.hasResourceProperties('AWS::Cognito::UserPool', {
      LambdaConfig: { PostConfirmation: Match.anyValue() },
    });
  });

  it('lets the trigger Put an item and nothing more', () => {
    const policies = Object.entries(dev.findResources('AWS::IAM::Policy')).filter(([id]) =>
      id.startsWith('PostConfirmation'),
    );

    expect(policies).toHaveLength(1);
    expect(policies[0]?.[1]?.Properties?.PolicyDocument?.Statement).toEqual([
      expect.objectContaining({ Action: 'dynamodb:PutItem', Effect: 'Allow' }),
    ]);
  });

  it('protects the prod pool from deletion', () => {
    prod.hasResource('AWS::Cognito::UserPool', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({ DeletionProtection: 'ACTIVE' }),
    });
  });
});

describe('the api (ADR-0006)', () => {
  it('knows the pool it verifies JWTs against, in process', () => {
    dev.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          USER_POOL_ID: Match.anyValue(),
          USER_POOL_CLIENT_ID: Match.anyValue(),
          TABLE_NAME: Match.anyValue(),
        }),
      },
      ReservedConcurrentExecutions: Match.anyValue(),
    });
  });

  it('has no API Gateway in front of it', () => {
    dev.resourceCountIs('AWS::ApiGateway::RestApi', 0);
    dev.resourceCountIs('AWS::ApiGatewayV2::Api', 0);
  });

  it('is reached on /api/* through an OAC origin, never cached', () => {
    const api = behavior(dev, '/api/*');
    const origin = distributionConfig(dev).Origins.find(
      (o: { Id: string }) => o.Id === api.TargetOriginId,
    );

    expect(JSON.stringify(origin)).toContain('ApiFunctionUrl');
    expect(origin.OriginAccessControlId).toBeDefined();
    // The managed CachingDisabled policy.
    expect(api.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
    expect(api.AllowedMethods).toContain('POST');
  });

  it('forwards the token header, no cookies, and never Host', () => {
    dev.hasResourceProperties('AWS::CloudFront::OriginRequestPolicy', {
      OriginRequestPolicyConfig: Match.objectLike({
        CookiesConfig: { CookieBehavior: 'none' },
        HeadersConfig: {
          HeaderBehavior: 'whitelist',
          Headers: Match.arrayWith(['x-authorization']),
        },
      }),
    });
    const policy = JSON.stringify(dev.findResources('AWS::CloudFront::OriginRequestPolicy'));
    expect(policy.toLowerCase()).not.toContain('"host"');
    // CloudFront rejects the whole policy at deploy if it names any `x-amz-*`
    // header — synth accepts it, so only this test catches it before AWS does.
    expect(policy.toLowerCase()).not.toContain('"x-amz-');
  });

  it('is a Function URL locked to IAM like the renderer', () => {
    dev.resourcePropertiesCountIs('AWS::Lambda::Url', { AuthType: 'AWS_IAM' }, 2);
    dev.resourcePropertiesCountIs('AWS::Lambda::Url', { AuthType: 'NONE' }, 0);
  });
});

describe('the dashboard (ADR-0006)', () => {
  it('lives in a private bucket read by CloudFront over OAC', () => {
    dev.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    dev.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({ OriginAccessControlOriginType: 's3' }),
    });
  });

  it('serves the shell uncached, so a deploy needs no invalidation', () => {
    const shell = behavior(dev, '/app/*');

    expect(shell.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
    expect(shell.FunctionAssociations).toEqual([
      expect.objectContaining({ EventType: 'viewer-request' }),
    ]);
    dev.hasResourceProperties('Custom::CDKBucketDeployment', {
      DestinationBucketKeyPrefix: 'app/',
      SystemMetadata: { 'cache-control': 'no-store' },
    });
  });

  it('serves hashed assets immutable for a year', () => {
    expect(behavior(dev, '/app/assets/*')).toBeDefined();
    dev.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({ MinTTL: 31536000, DefaultTTL: 31536000 }),
    });
    dev.hasResourceProperties('Custom::CDKBucketDeployment', {
      DestinationBucketKeyPrefix: 'app/assets/',
      SystemMetadata: { 'cache-control': 'public, max-age=31536000, immutable' },
    });
  });

  it('lists /app/assets/* before /app/*, so hashed assets never get the shell', () => {
    const patterns = distributionConfig(dev).CacheBehaviors.map(
      (b: { PathPattern: string }) => b.PathPattern,
    );

    expect(patterns.indexOf('/app/assets/*')).toBeLessThan(patterns.indexOf('/app/*'));
  });

  it('uploads the hashed assets before the shell that references them', () => {
    const shell = Object.entries(dev.findResources('Custom::CDKBucketDeployment')).find(
      ([id]) => id.startsWith('DashboardShell'),
    );
    const dependsOn: string[] = shell?.[1]?.DependsOn ?? [];

    expect(dependsOn.some((id) => id.startsWith('DashboardAssets'))).toBe(true);
  });

  it('never prunes, so a tab open across a deploy can still load its assets', () => {
    for (const deployment of Object.values(dev.findResources('Custom::CDKBucketDeployment'))) {
      expect(deployment.Properties.Prune).toBe(false);
    }
  });

  it('refuses to synth the placeholder shell when a deploy demands the build', () => {
    // The repo has no committed build, so this holds unless one was just made.
    const built = existsSync(new URL('../../packages/dashboard/dist/index.html', import.meta.url));
    const strict = buildApp(new App({ context: { requireDashboardBuild: 'true' } }));
    const errors = Annotations.fromStack(strict.node.findChild('AllLinks-dev') as never).findError(
      '*',
      Match.stringLikeRegexp('dashboard/dist is missing'),
    );

    expect(errors).toHaveLength(built ? 0 : 1);
  });
});
