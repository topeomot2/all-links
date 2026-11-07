import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import { GSI1_PROJECTED_ATTRIBUTES } from '@all-links/core';
import {
  Annotations,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { Certificate, type ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  AllowedMethods,
  CachePolicy,
  CacheCookieBehavior,
  CacheHeaderBehavior,
  CacheQueryStringBehavior,
  Distribution,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  HttpVersion,
  OriginRequestCookieBehavior,
  OriginRequestHeaderBehavior,
  OriginRequestPolicy,
  OriginRequestQueryStringBehavior,
  PriceClass,
  SecurityPolicyProtocol,
  ViewerProtocolPolicy,
  Function as CloudFrontFunction,
} from 'aws-cdk-lib/aws-cloudfront';
import { FunctionUrlOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import {
  AccountRecovery,
  FeaturePlan,
  UserPool,
  UserPoolClient,
} from 'aws-cdk-lib/aws-cognito';
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
  type TableProps,
} from 'aws-cdk-lib/aws-dynamodb';
import { Architecture, FunctionUrlAuthType, Runtime } from 'aws-cdk-lib/aws-lambda';
import {
  NodejsFunction,
  OutputFormat,
  type BundlingOptions,
  type NodejsFunctionProps,
} from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { AaaaRecord, ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { HttpsRedirect } from 'aws-cdk-lib/aws-route53-patterns';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, CacheControl, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { AUTH_HEADER, DASHBOARD_PATH } from '@all-links/core';
import type { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/** The dashboard's Vite build. `npm run build:dashboard` must run before a deploy. */
const dashboardDist = path.join(repoRoot, 'packages/dashboard/dist');
/**
 * Stands in for the build when it is absent, so `cdk synth` and the infra
 * tests need no frontend build. A deploy must not ship it: the deploy
 * workflow passes `-c requireDashboardBuild=true`, which turns this into an
 * error.
 */
const dashboardPlaceholder = path.join(here, '../assets/dashboard-placeholder');

export type Stage = 'dev' | 'prod';

export interface AllLinksStackProps extends StackProps {
  stage: Stage;
  /** Where the mandatory Budgets alarm mails (ADR-0001). */
  alertEmail: string;
  /**
   * The hostname this stage is served on — `linkix.io` in prod,
   * `dev.linkix.io` in dev (#27). Derived from one configured base domain in
   * `app.ts`, and the only place a hostname enters the system: the renderer
   * gets it as `SITE_ORIGIN`, and the certificate and CloudFront aliases will
   * read the same prop.
   */
  domainName: string;
  /**
   * The registered apex, without any stage prefix (#27).
   *
   * Distinct from `domainName` on purpose: the abuse mailbox (ADR-0010) lives
   * at the apex at every stage, so `dev` must advertise `abuse@linkix.io` and
   * not `abuse@dev.linkix.io`, which nobody reads.
   */
  baseDomain: string;
  /**
   * The wildcard certificate covering the apex, `www` and every stage
   * subdomain. Must live in us-east-1 — CloudFront reads it from nowhere else.
   * Absent, the stage answers on its generated CloudFront hostname only.
   */
  certificateArn?: string | undefined;
  /**
   * The public zone for the base domain, by id — not by lookup, which would
   * need credentials at synth time. Absent, DNS is a manual step.
   */
  hostedZone?: { id: string; name: string } | undefined;
  /** Monthly spend the budget is measured against, in USD. */
  monthlyBudgetUsd: number;
  /**
   * The cost ceiling under attack: an attacker cannot outrun a concurrency cap
   * into an unbounded bill (ADR-0010). Sizing is P9 on the pre-build checklist.
   */
  rendererReservedConcurrency: number;
  /** The same floor for the api Lambda (ADR-0010). */
  apiReservedConcurrency: number;
  /**
   * Fail synth if the dashboard has not been built, rather than deploying the
   * placeholder shell. Set by the deploy workflow.
   */
  requireDashboardBuild?: boolean | undefined;
}

/**
 * Everything the product runs on, in one stack per stage.
 *
 * One CloudFront distribution fronts everything: the renderer on the default
 * behavior, the api on `/api/*`, and the dashboard SPA from S3 on `/app/*` —
 * each Lambda through Origin Access Control, the bucket through its own. The
 * counter origin arrives with T5.
 */
export class AllLinksStack extends Stack {
  readonly table: Table;
  readonly userPool: UserPool;
  readonly distributionDomainName: string;
  /** `https://<domainName>` — what this stage calls itself in a URL. */
  readonly siteOrigin: string;

  constructor(scope: Construct, id: string, props: AllLinksStackProps) {
    super(scope, id, props);

    const { stage } = props;
    const isProd = stage === 'prod';

    this.siteOrigin = `https://${props.domainName}`;

    // ---- Data ------------------------------------------------------------
    // One table, on-demand: no floor fee, scales to zero, cheap atomic
    // counters (ADR-0001, ADR-0003).
    const tableProps: TableProps = {
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      // The OTP throttle items are the only ones that expire (ADR-0010).
      timeToLiveAttribute: 'expiresAt',
      // The eraser is unattended destructive code with no undo (ADR-0012).
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProd },
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    };
    this.table = new Table(this, 'Table', tableProps);

    // GSI1 is the public read path. Its INCLUDE projection is built from
    // `core`'s list, so a new private attribute cannot reach it by accident —
    // and the Account item has no GSI1PK, so it is not in the index at all.
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: AttributeType.STRING },
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: [...GSI1_PROJECTED_ATTRIBUTES],
    });

    // ---- Renderer --------------------------------------------------------
    const rendererLogs = new LogGroup(this, 'RendererLogs', {
      retention: isProd ? RetentionDays.ONE_MONTH : RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Every Lambda is bundled the same way; only entry, env and limits differ.
    const bundling: BundlingOptions = {
      format: OutputFormat.ESM,
      target: 'node22',
      minify: true,
      sourceMap: true,
      sourcesContent: false,
      tsconfig: path.join(repoRoot, 'tsconfig.json'),
      mainFields: ['module', 'main'],
      // CDK would otherwise leave `@aws-sdk/*` external and trust whatever
      // the managed runtime ships. Bundling it means the DynamoDB client a
      // handler is tested against is the one it runs on, and a runtime
      // refresh cannot change the data path underneath a deployed Lambda.
      bundleAwsSDK: true,
    };
    const lambdaDefaults: Partial<NodejsFunctionProps> = {
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      projectRoot: repoRoot,
      depsLockFilePath: path.join(repoRoot, 'package-lock.json'),
      bundling,
    };
    const logRetention = isProd ? RetentionDays.ONE_MONTH : RetentionDays.ONE_WEEK;

    const renderer = new NodejsFunction(this, 'Renderer', {
      ...lambdaDefaults,
      entry: path.join(repoRoot, 'packages/renderer/src/handler.ts'),
      memorySize: 512,
      timeout: Duration.seconds(10),
      reservedConcurrentExecutions: props.rendererReservedConcurrency,
      logGroup: rendererLogs,
      environment: {
        STAGE: stage,
        TABLE_NAME: this.table.tableName,
        // The renderer cannot learn its own hostname from the request: it is
        // reached over a Function URL, and ADR-0004 keeps `Host` out of the
        // cache key so CloudFront must not forward it. Canonical URLs and
        // `og:url` (ADR-0011) come from here instead (#27).
        SITE_ORIGIN: this.siteOrigin,
        // The apex, for the abuse mailbox the Page footer links (ADR-0010).
        BASE_DOMAIN: props.baseDomain,
        NODE_OPTIONS: '--enable-source-maps',
      },
    });

    // The renderer's whole job is the one GSI1 query (ADR-0003). Read only —
    // every write path is the api Lambda's.
    this.table.grantReadData(renderer);

    // AWS_IAM, so the `*.lambda-url.*.on.aws` hostname is unusable by anyone
    // who is not CloudFront signing with SigV4 (ADR-0006).
    const rendererUrl = renderer.addFunctionUrl({
      authType: FunctionUrlAuthType.AWS_IAM,
    });

    // ---- Auth ------------------------------------------------------------
    // Passwordless email OTP on Essentials — no floor fee, and auth MAU equals
    // paying Accounts (ADR-0005). The post-confirmation trigger writes the
    // Account the moment an email is verified.
    const postConfirmation = new NodejsFunction(this, 'PostConfirmation', {
      ...lambdaDefaults,
      entry: path.join(repoRoot, 'packages/api/src/post-confirmation.ts'),
      memorySize: 256,
      timeout: Duration.seconds(5),
      logGroup: new LogGroup(this, 'PostConfirmationLogs', {
        retention: logRetention,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        STAGE: stage,
        TABLE_NAME: this.table.tableName,
        NODE_OPTIONS: '--enable-source-maps',
      },
    });
    // One conditional Put of the Account item, and nothing else.
    this.table.grant(postConfirmation, 'dynamodb:PutItem');

    this.userPool = new UserPool(this, 'UserPool', {
      featurePlan: FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: true,
      // The email *is* the sign-in name; Cognito generates the `sub` that
      // becomes the accountId (ADR-0005).
      signInAliases: { email: true },
      autoVerify: { email: true },
      // The sign-up code is the first sign-in for a new Account, so it reads
      // like one rather than like "verify your account".
      userVerification: {
        emailSubject: 'Your All-Links sign-in code',
        emailBody: 'Your All-Links sign-in code is {####}. It expires in 24 hours.',
      },
      standardAttributes: { email: { required: true, mutable: true } },
      // Cognito insists a password factor stays allowed at the pool level; no
      // client flow here ever offers one, and sign-up is passwordless.
      signInPolicy: { allowedFirstAuthFactors: { password: true, emailOtp: true } },
      // Nothing to recover: there is no password.
      accountRecovery: AccountRecovery.NONE,
      lambdaTriggers: { postConfirmation },
      deletionProtection: isProd,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const userPoolClient = new UserPoolClient(this, 'DashboardClient', {
      userPool: this.userPool,
      // A public SPA client: no secret, and only the choice-based USER_AUTH
      // flow that carries EMAIL_OTP (plus refresh, which is always on).
      generateSecret: false,
      authFlows: { user: true },
      // No hosted UI and no redirects: CDK otherwise enables the implicit and
      // code grants against a placeholder callback URL.
      disableOAuth: true,
      // Long refresh so an Account rarely re-OTPs (ADR-0005); short access
      // tokens so a revoked session dies within the hour.
      refreshTokenValidity: Duration.days(60),
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
    });

    // ---- API -------------------------------------------------------------
    const api = new NodejsFunction(this, 'Api', {
      ...lambdaDefaults,
      entry: path.join(repoRoot, 'packages/api/src/handler.ts'),
      memorySize: 512,
      timeout: Duration.seconds(10),
      reservedConcurrentExecutions: props.apiReservedConcurrency,
      logGroup: new LogGroup(this, 'ApiLogs', {
        retention: logRetention,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        STAGE: stage,
        TABLE_NAME: this.table.tableName,
        // The JWT is verified in process against this pool's JWKS (ADR-0006).
        USER_POOL_ID: this.userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
        NODE_OPTIONS: '--enable-source-maps',
      },
    });
    // Every write path is the api's — CRUD, claim, billing (ADR-0003).
    this.table.grantReadWriteData(api);

    const apiUrl = api.addFunctionUrl({ authType: FunctionUrlAuthType.AWS_IAM });

    // ---- Dashboard -------------------------------------------------------
    // Private bucket, read only by this distribution over OAC (ADR-0006).
    const dashboardBucket = new Bucket(this, 'DashboardBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Every object is a build output; the source of truth is the repo.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const dashboardOrigin = S3BucketOrigin.withOriginAccessControl(dashboardBucket);

    // ---- Edge ------------------------------------------------------------
    // No cookies in the cache key: a dashboard session can never fragment the
    // public cache, which is why the dashboard uses a Bearer token (ADR-0004).
    const pageCachePolicy = new CachePolicy(this, 'PageCachePolicy', {
      comment: 'Public pages — no cookies, origin-controlled freshness',
      cookieBehavior: CacheCookieBehavior.none(),
      headerBehavior: CacheHeaderBehavior.none(),
      queryStringBehavior: CacheQueryStringBehavior.none(),
      // Freshness is the renderer's to state per response: s-maxage=60 for a
      // Page, s-maxage=300 for a static route (ADR-0013). CloudFront only
      // falls back to DefaultTTL when the origin sends no Cache-Control.
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.days(1),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // A stage answers on its own hostname only once both halves exist: the
    // certificate CloudFront serves it under, and the alias records pointing
    // at the distribution. Either alone is useless — aliases without a
    // certificate are rejected outright, and records without aliases resolve
    // to a distribution that 403s the host it was sent (#27).
    const certificate: ICertificate | undefined = props.certificateArn
      ? Certificate.fromCertificateArn(this, 'SiteCertificate', props.certificateArn)
      : undefined;

    const zone = props.hostedZone
      ? HostedZone.fromHostedZoneAttributes(this, 'SiteZone', {
          hostedZoneId: props.hostedZone.id,
          zoneName: props.hostedZone.name,
        })
      : undefined;

    // The api forwards exactly what it reads: the token header and the
    // content type. No cookies, and never `Host` — a Function URL rejects any
    // but its own. `x-amz-content-sha256` (the body hash a signed POST/PUT
    // needs) is deliberately absent: CloudFront refuses `x-amz-*` names in a
    // policy, and OAC carries the viewer's into its signature by itself.
    const apiOriginRequestPolicy = new OriginRequestPolicy(this, 'ApiOriginRequestPolicy', {
      comment: 'api — token header, no cookies, no Host',
      cookieBehavior: OriginRequestCookieBehavior.none(),
      headerBehavior: OriginRequestHeaderBehavior.allowList(AUTH_HEADER, 'content-type'),
      queryStringBehavior: OriginRequestQueryStringBehavior.all(),
    });

    // Hashed assets are immutable, so the edge may keep them as long as the
    // objects' own `Cache-Control` says — a year (ADR-0006).
    const dashboardAssetsCachePolicy = new CachePolicy(this, 'DashboardAssetsCachePolicy', {
      comment: 'Dashboard hashed assets — immutable, one year',
      cookieBehavior: CacheCookieBehavior.none(),
      headerBehavior: CacheHeaderBehavior.none(),
      queryStringBehavior: CacheQueryStringBehavior.none(),
      minTtl: Duration.days(365),
      defaultTtl: Duration.days(365),
      maxTtl: Duration.days(365),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // The SPA owns every path under `/app/`: anything that is not a file is
    // the shell, so a deep link or a reload lands on index.html, not an S3 403.
    const spaRewrite = new CloudFrontFunction(this, 'DashboardSpaRewrite', {
      comment: 'Serve the dashboard shell for any /app/ path that is not a file',
      runtime: FunctionRuntime.JS_2_0,
      code: FunctionCode.fromInline(
        [
          'function handler(event) {',
          '  var request = event.request;',
          '  if (!/\\.[A-Za-z0-9]+$/.test(request.uri)) {',
          `    request.uri = '${DASHBOARD_PATH}index.html';`,
          '  }',
          '  return request;',
          '}',
        ].join('\n'),
      ),
    });

    const distribution = new Distribution(this, 'Distribution', {
      comment: `all-links ${stage}`,
      // `www` is deliberately not among them: an alias here would force `Host`
      // into the cache key below, fragmenting every cached Page across two
      // hostnames (ADR-0013). It gets its own distribution instead.
      ...(certificate ? { domainNames: [props.domainName], certificate } : {}),
      // `/` must reach the renderer: DefaultRootObject would rewrite it to
      // /index.html and the renderer would look up that username (ADR-0013).
      defaultBehavior: {
        origin: FunctionUrlOrigin.withOriginAccessControl(rendererUrl),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: pageCachePolicy,
        compress: true,
      },
      additionalBehaviors: {
        // Per-Account, never cached. The JWT rides in its own header because
        // OAC's SigV4 signature occupies `Authorization` (see AUTH_HEADER).
        '/api/*': {
          origin: FunctionUrlOrigin.withOriginAccessControl(apiUrl),
          viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          originRequestPolicy: apiOriginRequestPolicy,
          compress: true,
        },
        // More specific than `/app/*`, so CloudFront matches it first.
        '/app/assets/*': {
          origin: dashboardOrigin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: dashboardAssetsCachePolicy,
          compress: true,
        },
        // The shell and its runtime config: `no-store`, so a deploy is live on
        // the next load and needs no invalidation (ADR-0006).
        '/app/*': {
          origin: dashboardOrigin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          compress: true,
          functionAssociations: [
            { function: spaRewrite, eventType: FunctionEventType.VIEWER_REQUEST },
          ],
        },
      },
      priceClass: PriceClass.PRICE_CLASS_100,
      httpVersion: HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
    });

    this.distributionDomainName = distribution.distributionDomainName;

    // ---- Dashboard deploy ------------------------------------------------
    const hasBuild = existsSync(path.join(dashboardDist, 'index.html'));
    if (!hasBuild) {
      const message =
        'packages/dashboard/dist is missing — the placeholder shell would be deployed. ' +
        'Run `npm run build:dashboard` first.';
      if (props.requireDashboardBuild) {
        Annotations.of(this).addError(message);
      } else {
        Annotations.of(this).addInfoV2('all-links:dashboard-build', message);
      }
    }
    const dashboardSource = hasBuild ? dashboardDist : dashboardPlaceholder;
    const dashboardPrefix = DASHBOARD_PATH.slice(1); // `app/`

    // Two uploads because the two halves differ in Cache-Control. Neither
    // prunes: a tab opened before a deploy still references the old hashed
    // assets, and they must keep resolving.
    const dashboardAssets = new BucketDeployment(this, 'DashboardAssets', {
      sources: [Source.asset(path.join(dashboardSource, 'assets'))],
      destinationBucket: dashboardBucket,
      destinationKeyPrefix: `${dashboardPrefix}assets/`,
      cacheControl: [CacheControl.fromString('public, max-age=31536000, immutable')],
      prune: false,
    });

    const dashboardShell = new BucketDeployment(this, 'DashboardShell', {
      sources: [
        Source.asset(dashboardSource, { exclude: ['assets'] }),
        // Read at boot, so pool ids reach the SPA without baking them into a
        // build that would then differ per stage.
        Source.jsonData('config.json', {
          region: this.region,
          userPoolId: this.userPool.userPoolId,
          userPoolClientId: userPoolClient.userPoolClientId,
        }),
      ],
      destinationBucket: dashboardBucket,
      destinationKeyPrefix: dashboardPrefix,
      cacheControl: [CacheControl.noStore()],
      prune: false,
    });
    // The shell is live the instant it lands (`no-store`), so the hashed
    // assets it names must already be there — otherwise a first load in the
    // gap between the two uploads 404s on its own script.
    dashboardShell.node.addDependency(dashboardAssets);

    // ---- Names -----------------------------------------------------------
    if (zone && certificate) {
      const target = RecordTarget.fromAlias(new CloudFrontTarget(distribution));

      new ARecord(this, 'SiteRecord', { zone, recordName: props.domainName, target });
      // CloudFront answers on IPv6 whether or not anything points at it; an
      // AAAA-only client is otherwise a silent failure.
      new AaaaRecord(this, 'SiteRecordIpv6', { zone, recordName: props.domainName, target });

      // `www` → apex, an S3 website-redirect bucket behind its own small
      // distribution (ADR-0013). Prod only: `www.dev` is not a thing anyone
      // types, and the pattern costs a distribution per use.
      if (isProd) {
        new HttpsRedirect(this, 'WwwRedirect', {
          zone,
          certificate,
          targetDomain: props.domainName,
          recordNames: [`www.${props.domainName}`],
        });
      }
    } else {
      Annotations.of(this).addInfoV2(
        'all-links:site-domain',
        `${props.domainName} is not wired up: this stage answers on its CloudFront hostname ` +
          'only. Needs both `-c certificateArn=…` (us-east-1) and `-c hostedZoneId=…` (#27).',
      );
    }

    if (certificate && this.region !== 'us-east-1') {
      Annotations.of(this).addWarningV2(
        'all-links:certificate-region',
        `CloudFront reads certificates from us-east-1 only, and this stack is in ${this.region}.`,
      );
    }

    // ---- Cost ceiling ----------------------------------------------------
    // Mandatory per ADR-0001: egress past CloudFront's 1 TB free tier is the
    // accepted risk, and this is the backstop that makes it survivable.
    //
    // Unnamed on purpose. Changing a subscriber replaces this resource, and
    // CloudFormation creates the new budget before deleting the old one, so a
    // fixed name fails the deploy with AlreadyExists.
    new CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: props.monthlyBudgetUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: props.alertEmail }],
        },
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: props.alertEmail }],
        },
      ],
    });

    // ---- Outputs ---------------------------------------------------------
    new CfnOutput(this, 'SiteUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'Public entry point for this stage',
    });
    // Until the certificate and aliases land, this is what the renderer claims
    // in its canonical URLs, not where the distribution actually answers.
    new CfnOutput(this, 'SiteOrigin', {
      value: this.siteOrigin,
      description: 'Canonical origin the renderer emits — the DNS target for this stage',
    });
    new CfnOutput(this, 'RendererFunctionUrl', {
      value: rendererUrl.url,
      description: 'Must return 403 when requested directly — OAC signs, IAM enforces',
    });
    new CfnOutput(this, 'ApiFunctionUrl', {
      value: apiUrl.url,
      description: 'Must return 403 when requested directly — OAC signs, IAM enforces',
    });
    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'TableName', { value: this.table.tableName });
  }
}
