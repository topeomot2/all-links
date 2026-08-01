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
  HttpVersion,
  PriceClass,
  SecurityPolicyProtocol,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { FunctionUrlOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
  type TableProps,
} from 'aws-cdk-lib/aws-dynamodb';
import { Architecture, FunctionUrlAuthType, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { AaaaRecord, ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { HttpsRedirect } from 'aws-cdk-lib/aws-route53-patterns';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import type { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

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
}

/**
 * Everything the product runs on, in one stack per stage.
 *
 * T1 builds the walking skeleton: the table, the renderer, and one CloudFront
 * distribution whose default behavior reaches the renderer's Function URL
 * through Origin Access Control. The api, counter and dashboard origins arrive
 * with the tickets that need them.
 */
export class AllLinksStack extends Stack {
  readonly table: Table;
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

    const renderer = new NodejsFunction(this, 'Renderer', {
      entry: path.join(repoRoot, 'packages/renderer/src/handler.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
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
        NODE_OPTIONS: '--enable-source-maps',
      },
      projectRoot: repoRoot,
      depsLockFilePath: path.join(repoRoot, 'package-lock.json'),
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
        minify: true,
        sourceMap: true,
        sourcesContent: false,
        tsconfig: path.join(repoRoot, 'tsconfig.json'),
        mainFields: ['module', 'main'],
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
      priceClass: PriceClass.PRICE_CLASS_100,
      httpVersion: HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
    });

    this.distributionDomainName = distribution.distributionDomainName;

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
    new CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `all-links-${stage}`,
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
    new CfnOutput(this, 'TableName', { value: this.table.tableName });
  }
}
