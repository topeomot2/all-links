import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import { GSI1_PROJECTED_ATTRIBUTES } from '@all-links/core';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
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
import type { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

export type Stage = 'dev' | 'prod';

export interface AllLinksStackProps extends StackProps {
  stage: Stage;
  /** Where the mandatory Budgets alarm mails (ADR-0001). */
  alertEmail: string;
  /**
   * The apex domain every public Page's abuse mailto points at (ADR-0010).
   * It is the renderer's only knowledge of where it is deployed; the real
   * domain lands with P1.
   */
  siteDomain: string;
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

  constructor(scope: Construct, id: string, props: AllLinksStackProps) {
    super(scope, id, props);

    const { stage } = props;
    const isProd = stage === 'prod';

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
        SITE_DOMAIN: props.siteDomain,
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
        // CDK would otherwise leave `@aws-sdk/*` external and trust whatever
        // the managed runtime ships. Bundling it means the DynamoDB client the
        // renderer is tested against is the one it runs on, and a runtime
        // refresh cannot change the read path underneath a deployed Lambda.
        bundleAwsSDK: true,
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

    const distribution = new Distribution(this, 'Distribution', {
      comment: `all-links ${stage}`,
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
    new CfnOutput(this, 'RendererFunctionUrl', {
      value: rendererUrl.url,
      description: 'Must return 403 when requested directly — OAC signs, IAM enforces',
    });
    new CfnOutput(this, 'TableName', { value: this.table.tableName });
  }
}
