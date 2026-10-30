/**
 * Implementation playbooks for recommendations.
 *
 * For each recommendation: how long it takes, risk and rollback, step-by-step instructions,
 * ready-to-adapt AWS CLI commands and how to confirm the saving afterwards.
 * Matched on the recommendation title/category/service; the first match wins.
 * Placeholders in <angle brackets> must be replaced; known IDs and regions are filled in.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FinOpsPlaybooks = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  const REGION_CODES = {
    'us east (n. virginia)': 'us-east-1', 'us east (ohio)': 'us-east-2', 'us west (n. california)': 'us-west-1', 'us west (oregon)': 'us-west-2',
    'asia pacific (mumbai)': 'ap-south-1', 'asia pacific (hyderabad)': 'ap-south-2', 'asia pacific (singapore)': 'ap-southeast-1', 'asia pacific (sydney)': 'ap-southeast-2',
    'asia pacific (tokyo)': 'ap-northeast-1', 'asia pacific (seoul)': 'ap-northeast-2', 'asia pacific (osaka)': 'ap-northeast-3', 'asia pacific (hong kong)': 'ap-east-1',
    'eu (ireland)': 'eu-west-1', 'eu (london)': 'eu-west-2', 'eu (paris)': 'eu-west-3', 'eu (frankfurt)': 'eu-central-1', 'eu (stockholm)': 'eu-north-1', 'eu (milan)': 'eu-south-1',
    'canada (central)': 'ca-central-1', 'south america (sao paulo)': 'sa-east-1', 'middle east (bahrain)': 'me-south-1', 'africa (cape town)': 'af-south-1',
  };

  /** Fill-ins for commands: AWS region code and the resource ID when we know it. */
  function context(rec) {
    const raw = String(rec.region || '').split(',')[0].trim();
    const region = /^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(raw) ? raw : REGION_CODES[raw.toLowerCase()] || '<region>';
    const id = String(rec.awsResourceId || rec.resourceId || '');
    const pick = (re, fallback) => (re.test(id) ? id : fallback);
    const typeMatch = /→\s*([a-z0-9-]+\.[a-z0-9]+)/i.exec(rec.title || '');
    return {
      region,
      instance: pick(/^i-[0-9a-f]+$/, '<instance-id>'),
      volume: pick(/^vol-[0-9a-f]+$/, '<volume-id>'),
      snapshot: pick(/^snap-[0-9a-f]+$/, '<snapshot-id>'),
      eip: pick(/^eipalloc-[0-9a-f]+$/, '<allocation-id>'),
      db: /^db-|^[a-z][a-z0-9-]*$/i.test(id) && /rds|db\./i.test(`${rec.service} ${rec.instanceType}`) ? id : '<db-instance-id>',
      fn: /lambda/i.test(rec.title) && rec.awsResourceId ? rec.awsResourceId : '<function-name>',
      target: typeMatch ? typeMatch[1] : '<new-type>',
      service: String(rec.service || ''),
      bucket: /\bs3\b|simple storage/i.test(rec.service || '') && /^[a-z0-9][a-z0-9.-]{2,62}$/.test(id) ? id : '<bucket>',
    };
  }

  const cmd = (label, text) => ({ label, cmd: text });

  const PLAYBOOKS = [
    // ---------------------------------------------------------------- Secrets Manager
    {
      match: /cache secrets|secrets manager api/i, time: '1-3 days (code change)', risk: 'Low. Cached secrets refresh after the TTL, so rotations take effect a few minutes later.',
      steps: [
        'Find who calls GetSecretValue most: CloudTrail → Event history → filter Event name = GetSecretValue, then group by user/role (or query CloudTrail Lake / Athena for a full month).',
        'For Lambda: add the "AWS Parameters and Secrets Lambda Extension" layer and read secrets from http://localhost:2773/secretsmanager/get?secretId=<name> with the header X-Aws-Parameters-Secrets-Token set to AWS_SESSION_TOKEN. Set SECRETS_MANAGER_TTL (e.g. 300 seconds).',
        'For containers/EC2: use the Secrets Manager caching client for your language (Java, Python, .NET, Go) or load secrets once at startup.',
        'Move plain configuration that never rotates to SSM Parameter Store standard parameters (no charge).',
        'Delete secrets nobody reads (check "Last retrieved" in the Secrets Manager console).',
      ],
      cli: (c) => [
        cmd('Top callers (last 90 days, management events)', `aws cloudtrail lookup-events --region ${c.region} --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue --max-results 50 --query "Events[].Username"`),
        cmd('Secrets and when they were last read', `aws secretsmanager list-secrets --region ${c.region} --query "SecretList[].[Name,LastAccessedDate]" --output table`),
      ],
      verify: 'Cost Explorer → filter Service = Secrets Manager, group by Usage type: the "APIRequest" line should drop within a day of deploying.',
    },
    // ---------------------------------------------------------------- Lambda
    {
      match: /lambda.*(arm64|graviton)/i, time: '1-2 days per function group', risk: 'Low-medium. Native dependencies (e.g. compiled npm/pip packages) must be rebuilt for arm64. Roll back by redeploying x86_64.',
      steps: [
        'List x86_64 functions and sort by cost (Cost Explorer → Lambda → group by Resource if resource-level data is enabled, or by duration in CloudWatch).',
        'Start with Node.js and Python functions without native modules; rebuild container images for linux/arm64.',
        'Deploy with architecture arm64 to a test alias and compare duration and errors for a day.',
        'Shift traffic with an alias/weighted version, then switch the remaining functions.',
        'Run AWS Lambda Power Tuning to pick the cheapest memory size after the move.',
      ],
      cli: (c) => [
        cmd('x86_64 functions', `aws lambda list-functions --region ${c.region} --query "Functions[?Architectures[0]=='x86_64'].[FunctionName,MemorySize,Runtime]" --output table`),
        cmd('Deploy as arm64', `aws lambda update-function-code --region ${c.region} --function-name ${c.fn} --architectures arm64 --zip-file fileb://function.zip`),
      ],
      verify: 'Cost Explorer → Lambda → group by Usage type: "Lambda-GB-Second" falls and "Lambda-GB-Second-ARM" appears at about 20% lower cost per GB-second.',
    },
    {
      match: /rightsize lambda|lambda function/i, time: '1 hour per function', risk: 'Low. Less memory also means less CPU; watch duration and timeouts. Roll back by restoring the old memory size.',
      steps: [
        'Open the function in the Lambda console → Monitor: check max memory used and duration.',
        'Set the recommended memory on a test alias and compare p95 duration.',
        'Apply to production if duration and errors are unchanged.',
      ],
      cli: (c) => [cmd('Change memory', `aws lambda update-function-configuration --region ${c.region} --function-name ${c.fn} --memory-size <MB>`)],
      verify: 'CloudWatch → Lambda → Duration and the "Lambda-GB-Second" usage in Cost Explorer for that function.',
    },
    // ---------------------------------------------------------------- NAT / network
    {
      match: /nat gateway|vpc endpoint/i, time: '1 day', risk: 'Low for gateway endpoints (no downtime, free). Interface endpoints cost about $7-8/month per AZ plus $0.01/GB, so add them only for high-volume services.',
      steps: [
        'Turn on VPC Flow Logs for the NAT Gateway ENI (or use CloudWatch Contributor Insights) to see which destinations send the most bytes.',
        'Create the free gateway endpoints for S3 and DynamoDB and attach them to the private subnets\' route tables. Traffic moves automatically.',
        'For other high-volume AWS APIs (Secrets Manager, CloudWatch Logs, ECR, SQS) add interface endpoints with private DNS enabled.',
        'If NAT traffic is to the internet (package downloads, third-party APIs), cache artifacts (ECR pull-through cache, CodeArtifact) or move large downloads out of the hot path.',
      ],
      cli: (c) => [
        cmd('Gateway endpoint for DynamoDB', `aws ec2 create-vpc-endpoint --region ${c.region} --vpc-id <vpc-id> --service-name com.amazonaws.${c.region}.dynamodb --route-table-ids <rtb-id-1> <rtb-id-2>`),
        cmd('Gateway endpoint for S3', `aws ec2 create-vpc-endpoint --region ${c.region} --vpc-id <vpc-id> --service-name com.amazonaws.${c.region}.s3 --route-table-ids <rtb-id-1> <rtb-id-2>`),
        cmd('Interface endpoint for Secrets Manager', `aws ec2 create-vpc-endpoint --region ${c.region} --vpc-id <vpc-id> --vpc-endpoint-type Interface --service-name com.amazonaws.${c.region}.secretsmanager --subnet-ids <subnet-ids> --security-group-ids <sg-id> --private-dns-enabled`),
      ],
      verify: 'Cost Explorer → EC2-Other → group by Usage type: "NatGateway-Bytes" should drop the day after the endpoints are in place.',
    },
    {
      match: /cross-az/i, time: '1-2 weeks (architecture)', risk: 'Medium. Pinning traffic to one AZ must not remove your multi-AZ resilience.',
      steps: [
        'Use VPC Flow Logs (or Network Flow Monitor) to find the chattiest pairs of services across AZs.',
        'Enable AZ-aware routing: ELB cross-zone off where appropriate, topology-aware routing in Kubernetes, read replicas/caches in each AZ.',
        'Send internal traffic to private IPs, not public or Elastic IPs (that is also billed as regional transfer).',
      ],
      cli: () => [],
      verify: 'Cost Explorer → usage type "DataTransfer-Regional-Bytes" trending down.',
    },
    {
      match: /serve internet traffic through cloudfront/i, time: '2-5 days', risk: 'Low. Test caching headers so dynamic content is not cached by mistake.',
      steps: [
        'Identify the public endpoints that send the most data (ALB/S3 access logs).',
        'Put a CloudFront distribution in front, with the origin restricted to CloudFront (OAC for S3, a custom header or prefix list for ALB).',
        'Set Cache-Control headers on static assets and turn on compression.',
      ],
      cli: () => [],
      verify: 'Data Transfer "Out-Bytes" in Cost Explorer falls; CloudFront bandwidth rises by less than it saves.',
    },
    // ---------------------------------------------------------------- DynamoDB
    {
      match: /dynamodb on-demand|dynamodb write|dynamodb capacity/i, time: '2-5 days', risk: 'Medium. Provisioned tables can throttle on spikes: use auto scaling with headroom. Switching capacity mode is limited per table per day.',
      steps: [
        'In CloudWatch, check ConsumedWriteCapacityUnits / ConsumedReadCapacityUnits per table for 2 weeks. Steady tables (peak under ~2× average) are good candidates.',
        'Reduce write units: avoid rewriting unchanged items (use conditional/partial updates), keep items under 1 KB, and remove GSIs that project every attribute.',
        'Use eventually consistent reads where strong consistency is not needed (half the read cost).',
        'For steady tables: switch to provisioned capacity with auto scaling (target utilization ~70%).',
      ],
      cli: (c) => [
        cmd('Switch a table to provisioned', `aws dynamodb update-table --region ${c.region} --table-name <table> --billing-mode PROVISIONED --provisioned-throughput ReadCapacityUnits=<rcu>,WriteCapacityUnits=<wcu>`),
        cmd('Table sizes and item counts', `aws dynamodb describe-table --region ${c.region} --table-name <table> --query "Table.[TableSizeBytes,ItemCount,BillingModeSummary.BillingMode]"`),
      ],
      verify: 'Cost Explorer → DynamoDB → group by Usage type: "WriteRequestUnits"/"ReadRequestUnits" fall; "WriteCapacityUnit-Hrs" appears if you switched to provisioned.',
    },
    {
      match: /standard-ia table class/i, time: '1 hour', risk: 'Low. Online change; reads/writes cost ~25% more on IA, so only switch storage-heavy tables. You can switch back (limited times per 30 days).',
      steps: ['Pick tables where storage cost is higher than throughput cost.', 'Change the table class to Standard-IA.', 'Watch the next bill for both storage and request lines.'],
      cli: (c) => [cmd('Change table class', `aws dynamodb update-table --region ${c.region} --table-name <table> --table-class STANDARD_INFREQUENT_ACCESS`)],
      verify: 'Cost Explorer → DynamoDB → usage type "IA-TimedStorage-ByteHrs" replaces "TimedStorage-ByteHrs".',
    },
    {
      match: /expire or archive old dynamodb|dynamodb items/i, time: '1-3 days', risk: 'Low if the TTL attribute is set correctly; deleted items cannot be recovered except from backups.',
      steps: [
        'Add an expiry attribute (epoch seconds) to time-bound items such as sessions, events and logs.',
        'Enable TTL on that attribute; DynamoDB deletes expired items for free.',
        'Export cold history to S3 (Export to S3 feature) and query it with Athena if needed.',
      ],
      cli: (c) => [cmd('Enable TTL', `aws dynamodb update-time-to-live --region ${c.region} --table-name <table> --time-to-live-specification "Enabled=true, AttributeName=expiresAt"`)],
      verify: 'Table size in the DynamoDB console and "TimedStorage-ByteHrs" in Cost Explorer go down over the following weeks.',
    },
    {
      match: /point-in-time recovery/i, time: '30 minutes', risk: 'Medium: without PITR you can only restore from scheduled backups. Keep it on production tables.',
      steps: ['List tables with PITR enabled.', 'Disable it on dev/test and easily rebuilt tables.', 'Make sure AWS Backup does not also take daily copies of the same tables.'],
      cli: (c) => [cmd('Disable PITR on a table', `aws dynamodb update-continuous-backups --region ${c.region} --table-name <table> --point-in-time-recovery-specification PointInTimeRecoveryEnabled=false`)],
      verify: 'Cost Explorer usage type "TimedPITRStorage-ByteHrs" drops.',
    },
    // ---------------------------------------------------------------- Backup
    {
      match: /backup retention|aws backup/i, time: '1 day', risk: 'Medium: shorter retention means fewer restore points. Confirm the retention your policy/compliance requires first.',
      steps: [
        'AWS Backup → Backup plans: list rules, their frequency and "Retention" / "Move to cold storage" settings.',
        'Shorten retention to what policy requires and avoid daily backups of non-production.',
        'If DynamoDB PITR is on, you rarely also need daily AWS Backup copies of the same table.',
        'Backup vaults → delete recovery points for resources that no longer exist.',
      ],
      cli: (c) => [
        cmd('Backup plans', `aws backup list-backup-plans --region ${c.region}`),
        cmd('Recovery points in a vault', `aws backup list-recovery-points-by-backup-vault --region ${c.region} --backup-vault-name <vault> --query "RecoveryPoints[].[ResourceArn,CreationDate,BackupSizeInBytes]" --output table`),
      ],
      verify: 'Cost Explorer → AWS Backup → "WarmStorage"/"ColdStorage" usage trends down as old points expire.',
    },
    // ---------------------------------------------------------------- CloudWatch
    {
      match: /cloudwatch logs ingestion/i, time: '1-3 days', risk: 'Low. Make sure logs needed for audits or incidents are still collected.',
      steps: [
        'CloudWatch → Metrics → Logs → IncomingBytes per LogGroupName: find the top log groups.',
        'Lower log levels in production (INFO → WARN), stop logging full request/response bodies, and sample debug logs.',
        'Use the Infrequent Access log class for logs you rarely query (about half the ingestion price).',
        'Send VPC Flow Logs and other vended logs to S3 instead of CloudWatch when you do not need live queries.',
      ],
      cli: (c) => [cmd('Log groups by stored size', `aws logs describe-log-groups --region ${c.region} --query "reverse(sort_by(logGroups,&storedBytes))[:20].[logGroupName,storedBytes,retentionInDays]" --output table`)],
      verify: 'Cost Explorer → CloudWatch → usage types "DataProcessing-Bytes" and "VendedLog-Bytes" fall.',
    },
    {
      match: /cloudwatch logs retention/i, time: '30 minutes', risk: 'Low. Export anything you must keep long-term to S3 before shortening.',
      steps: ['List log groups with no retention ("Never expire").', 'Set 30-90 days retention on each.', 'Export long-term logs to S3 with lifecycle rules.'],
      cli: (c) => [
        cmd('Log groups that never expire', `aws logs describe-log-groups --region ${c.region} --query "logGroups[?!retentionInDays].logGroupName"`),
        cmd('Set 30-day retention', `aws logs put-retention-policy --region ${c.region} --log-group-name <log-group> --retention-in-days 30`),
      ],
      verify: 'Cost Explorer → CloudWatch → "TimedStorage-ByteHrs" falls over the next weeks.',
    },
    {
      match: /custom metrics|cloudwatch log retention and trim/i, time: '1 day', risk: 'Low.',
      steps: ['CloudWatch → All metrics: find custom namespaces with many metrics.', 'Remove high-cardinality dimensions (request IDs, user IDs).', 'Delete unused dashboards and alarms; set log retention.'],
      cli: (c) => [cmd('Custom metrics count by namespace', `aws cloudwatch list-metrics --region ${c.region} --query "Metrics[].Namespace" --output text`)],
      verify: 'Cost Explorer → CloudWatch → "MetricMonitorUsage" falls.',
    },
    // ---------------------------------------------------------------- CloudFront / WAF / API GW / SES
    {
      generic: true, match: /cloudfront security savings bundle|cloudfront/i, time: '1 hour (bundle) + a few days (caching)', risk: 'Low. The bundle is a 1-year monthly commitment; size it below your lowest monthly CloudFront spend.',
      steps: [
        'CloudFront console → Savings bundle: commit to a monthly amount below your steady CloudFront usage (it also covers some WAF usage).',
        'CloudFront → Reports → Cache statistics: find behaviors with a low hit ratio.',
        'Remove unnecessary headers, cookies and query strings from cache keys; use longer TTLs for static files; enable compression.',
      ],
      cli: () => [],
      verify: 'The bill shows a "Savings Bundle" credit; cache hit ratio in CloudFront reports goes up.',
    },
    {
      match: /waf/i, time: '1 day', risk: 'Low. Do not remove rules that protect public endpoints.',
      steps: ['WAF console: list web ACLs and their associated resources.', 'Share one web ACL across resources where rules are the same.', 'Serve static assets from a path/distribution without a web ACL.', 'Include WAF in the CloudFront Security Savings Bundle.'],
      cli: () => [cmd('Web ACLs (CloudFront scope)', 'aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1')],
      verify: 'Cost Explorer → WAF → request charges fall.',
    },
    {
      match: /rest apis to http apis/i, time: '1-2 weeks', risk: 'Medium. Check feature gaps (usage plans/API keys, request validation, caching, private APIs) before migrating.',
      steps: ['List REST APIs and which features each uses.', 'Create an HTTP API with the same routes and Lambda/HTTP integrations (JWT authorizers replace Cognito authorizers).', 'Test, then switch the custom domain mapping to the HTTP API.'],
      cli: (c) => [cmd('REST APIs', `aws apigateway get-rest-apis --region ${c.region} --query "items[].[id,name]" --output table`)],
      verify: 'Cost Explorer → API Gateway → "ApiGatewayRequest" falls and "ApiGatewayHttpRequest" appears at a lower rate.',
    },
    {
      match: /deliverability manager|\bvdm\b/i, time: '15 minutes', risk: 'Low. You lose VDM dashboards and advice.',
      steps: ['SES console → Virtual Deliverability Manager: check whether anyone uses the dashboard.', 'Turn VDM off, or enable it only on the configuration sets you monitor.'],
      cli: (c) => [cmd('Turn off VDM', `aws sesv2 put-account-vdm-attributes --region ${c.region} --vdm-attributes VdmEnabled=DISABLED`)],
      verify: 'The SES line for Virtual Deliverability Manager disappears from the next bill.',
    },
    // ---------------------------------------------------------------- S3
    {
      match: /s3 get request/i, time: '2-5 days', risk: 'Low.',
      steps: ['Enable S3 Storage Lens or server access logs to find buckets/prefixes with the most GET/LIST calls.', 'Cache hot objects in CloudFront or the application.', 'Replace LIST calls in loops with an index (e.g. DynamoDB) and combine many small objects.'],
      cli: () => [],
      verify: 'Cost Explorer → S3 → "Requests-Tier2" falls.',
    },
    {
      match: /intelligent-tiering|lifecycle|cooler tier|archive tier/i, time: '1 hour', risk: 'Low. Archive tiers have retrieval time and fees; do not archive data you read often.',
      steps: ['Pick buckets with large, rarely read data (S3 Storage Lens).', 'Add a lifecycle rule: transition to Intelligent-Tiering (or Glacier for archives), expire old versions, abort incomplete multipart uploads after 7 days.'],
      cli: (c) => [cmd('Apply a lifecycle configuration', `aws s3api put-bucket-lifecycle-configuration --bucket ${c.bucket} --lifecycle-configuration file://lifecycle.json`)],
      verify: 'Storage class breakdown in S3 Storage Lens; "TimedStorage" cost falls the following month.',
    },
    // ---------------------------------------------------------------- IPs, EBS, snapshots
    {
      match: /public ipv4|elastic ip|ip address/i, time: '30 minutes', risk: 'Low. A released Elastic IP cannot be recovered; update DNS first.',
      steps: ['EC2 → Elastic IPs: find addresses not associated with anything.', 'Release them.', 'For running instances, move them to private subnets behind a load balancer or NAT where a public IP is not needed.'],
      cli: (c) => [
        cmd('Unassociated Elastic IPs', `aws ec2 describe-addresses --region ${c.region} --query "Addresses[?AssociationId==null].[PublicIp,AllocationId]" --output table`),
        cmd('Release one', `aws ec2 release-address --region ${c.region} --allocation-id ${c.eip}`),
      ],
      verify: 'Cost Explorer → VPC / EC2-Other → "PublicIPv4" usage falls.',
    },
    {
      match: /gp2.*gp3/i, time: '15 minutes per volume', risk: 'Very low. Online change with no downtime; gp3 includes 3,000 IOPS and 125 MB/s.',
      steps: ['List gp2 volumes.', 'Change each to gp3 (larger gp2 volumes above 1 TB may need extra provisioned IOPS/throughput to match).', 'For RDS, change storage type to gp3 in a maintenance window.'],
      cli: (c) => [
        cmd('gp2 volumes', `aws ec2 describe-volumes --region ${c.region} --filters Name=volume-type,Values=gp2 --query "Volumes[].[VolumeId,Size,Iops]" --output table`),
        cmd('Change to gp3', `aws ec2 modify-volume --region ${c.region} --volume-id ${c.volume} --volume-type gp3`),
      ],
      verify: 'Cost Explorer → EC2-Other → "VolumeUsage.gp2" falls and "VolumeUsage.gp3" appears about 20% cheaper.',
    },
    {
      match: /io1/i, time: '30 minutes', risk: 'Low. Check that peak IOPS fit gp3 limits (16,000).',
      steps: ['Check peak IOPS in CloudWatch (VolumeReadOps + VolumeWriteOps).', 'If under 16,000 change to gp3 with matching IOPS; otherwise change to io2.'],
      cli: (c) => [cmd('Change to gp3', `aws ec2 modify-volume --region ${c.region} --volume-id ${c.volume} --volume-type gp3 --iops <iops>`)],
      verify: 'Volume line in Cost Explorer.',
    },
    {
      match: /unattached volume|delete unattached|delete unused ebs/i, time: '15 minutes', risk: 'Medium: deleting is permanent. Take a final snapshot first.',
      steps: ['Confirm the volume is unattached and nobody owns it.', 'Create a final snapshot (snapshots cost much less than volumes).', 'Delete the volume.'],
      cli: (c) => [
        cmd('Unattached volumes', `aws ec2 describe-volumes --region ${c.region} --filters Name=status,Values=available --query "Volumes[].[VolumeId,Size,CreateTime]" --output table`),
        cmd('Final snapshot', `aws ec2 create-snapshot --region ${c.region} --volume-id ${c.volume} --description "final before delete"`),
        cmd('Delete', `aws ec2 delete-volume --region ${c.region} --volume-id ${c.volume}`),
      ],
      verify: 'The volume no longer appears in EBS usage the next day.',
    },
    {
      generic: true, match: /snapshot/i, time: '1 hour', risk: 'Medium: deleted snapshots cannot be restored. Keep those required by policy.',
      steps: ['List your snapshots by age.', 'Set an Amazon Data Lifecycle Manager policy with a retention count/age.', 'Delete snapshots outside the policy; move long-term ones to the Archive tier.'],
      cli: (c) => [
        cmd('Snapshots older than a date', `aws ec2 describe-snapshots --region ${c.region} --owner-ids self --query "Snapshots[?StartTime<='<YYYY-MM-DD>'].[SnapshotId,VolumeSize,StartTime]" --output table`),
        cmd('Delete one', `aws ec2 delete-snapshot --region ${c.region} --snapshot-id ${c.snapshot}`),
      ],
      verify: 'Cost Explorer → EC2-Other → "SnapshotUsage" falls.',
    },
    {
      match: /reduce ec2-other/i, time: '1-2 days', risk: 'Low.',
      steps: ['Cost Explorer → EC2-Other → group by Usage type to see which part is largest (NAT, EBS, snapshots, IPs, data transfer).', 'Apply the matching steps: gp3 migration, unattached volume cleanup, snapshot policy, VPC endpoints, release idle IPs.'],
      cli: (c) => [cmd('gp2 volumes', `aws ec2 describe-volumes --region ${c.region} --filters Name=volume-type,Values=gp2 --query "Volumes[].VolumeId"`)],
      verify: 'EC2-Other monthly total in Cost Explorer.',
    },
    // ---------------------------------------------------------------- EC2 / compute
    {
      generic: true, match: /idle resource|stop idle|stop or terminate/i, time: '1 hour', risk: 'Medium: confirm with the owner. Stopped instances still pay for EBS; snapshot before terminating.',
      steps: ['Check CPU, network and connections for 2 weeks (CloudWatch).', 'Tag the instance and notify the owner with a stop date.', 'Stop it; terminate after a week if nobody complains (snapshot volumes first).'],
      cli: (c) => [cmd('Stop', `aws ec2 stop-instances --region ${c.region} --instance-ids ${c.instance}`)],
      verify: 'EC2 instance hours for that instance drop to zero in Cost Explorer (resource-level view).',
    },
    {
      generic: true, match: /terminate long-stopped|decommission/i, time: '1 hour', risk: 'Medium: permanent. Snapshot disks and record the configuration first.',
      steps: ['Confirm nobody needs the resource (owner, tags, last used).', 'Snapshot attached volumes / take a final DB snapshot.', 'Terminate or delete; release attached Elastic IPs.'],
      cli: (c) => (/load\s*balancer|\belb\b|\balb\b|\bnlb\b/i.test(c.service)
        ? [cmd('Delete the load balancer', `aws elbv2 delete-load-balancer --region ${c.region} --load-balancer-arn <load-balancer-arn>`)]
        : /rds|database/i.test(c.service)
          ? [cmd('Delete with a final snapshot', `aws rds delete-db-instance --region ${c.region} --db-instance-identifier ${c.db} --final-db-snapshot-identifier ${c.db}-final`)]
          : [cmd('Terminate instance', `aws ec2 terminate-instances --region ${c.region} --instance-ids ${c.instance}`)]),
      verify: 'Storage and IP charges for the resource disappear next day.',
    },
    {
      match: /redshift/i, time: '1 hour', risk: 'Low. A paused cluster cannot be queried until resumed (a few minutes).',
      steps: ['Check query activity per cluster (Redshift console → Query monitoring).', 'Create pause/resume schedules for dev and reporting clusters (Redshift console → Schedules).', 'For spiky workloads, consider Redshift Serverless.'],
      cli: (c) => [
        cmd('Pause a cluster', `aws redshift pause-cluster --region ${c.region} --cluster-identifier <cluster-id>`),
        cmd('Resume it', `aws redshift resume-cluster --region ${c.region} --cluster-identifier <cluster-id>`),
      ],
      verify: 'Redshift node hours in Cost Explorer.',
    },
    {
      match: /elasticache|opensearch|cache\/search/i, time: '1 maintenance window', risk: 'Medium: node type changes replace nodes; do it in a quiet period.',
      steps: ['Check CPU and memory (EngineCPUUtilization, DatabaseMemoryUsagePercentage / JVMMemoryPressure).', 'Change to the Graviton node type of the right size (e.g. cache.r7g, r7g.search).', 'For OpenSearch, move old indices to UltraWarm or cold storage.'],
      cli: (c) => [cmd('Change ElastiCache node type', `aws elasticache modify-replication-group --region ${c.region} --replication-group-id <group-id> --cache-node-type <cache.r7g.large> --apply-immediately`)],
      verify: 'ElastiCache / OpenSearch node hours in Cost Explorer.',
    },
    {
      match: /ses dedicated/i, time: '1 hour', risk: 'Low-medium: shared IPs change your sending reputation profile.',
      steps: ['SES console → Dedicated IPs: check sending volume per IP.', 'If volume is low, move to shared IPs or managed dedicated IPs.', 'Keep the suppression list enabled to avoid paying for bounces.'],
      cli: (c) => [cmd('Dedicated IP pools', `aws sesv2 list-dedicated-ip-pools --region ${c.region}`)],
      verify: 'SES dedicated IP charges on the next bill.',
    },
    {
      match: /schedule non-production|off-hours/i, time: '1 day', risk: 'Low. Agree working hours with the team; give an override tag for late work.',
      steps: [
        'Tag non-production instances/databases (e.g. Schedule=office-hours).',
        'Deploy "Instance Scheduler on AWS", or create EventBridge Scheduler rules that call ec2:StopInstances at night and StartInstances in the morning.',
        'For RDS use stop/start (RDS restarts automatically after 7 days stopped, so keep the schedule running).',
      ],
      cli: (c) => [cmd('Stop now (test)', `aws ec2 stop-instances --region ${c.region} --instance-ids ${c.instance}`)],
      verify: 'Running hours per month drop from ~730 to ~260 for scheduled resources.',
    },
    {
      match: /compute optimizer|rightsize ec2 with/i, time: '1 day to enable, then per instance', risk: 'Low to enable. Each resize needs a stop/start.',
      steps: ['Enable AWS Compute Optimizer (free) for the account/organization.', 'Wait ~12-24 hours, then review EC2 recommendations marked "Over-provisioned".', 'Enable Cost Optimization Hub to see all savings in one list, then connect this tool to AWS to pull them in.'],
      cli: () => [
        cmd('Enable Compute Optimizer', 'aws compute-optimizer update-enrollment-status --status Active --include-member-accounts'),
        cmd('Enable Cost Optimization Hub', 'aws cost-optimization-hub update-enrollment-status --status Active --include-member-accounts --region us-east-1'),
        cmd('EC2 recommendations', 'aws compute-optimizer get-ec2-instance-recommendations --query "instanceRecommendations[].[instanceArn,finding,currentInstanceType,recommendationOptions[0].instanceType]" --output table'),
      ],
      verify: 'Compute Optimizer and Cost Optimization Hub show estimated savings; EC2 cost trends down as you apply them.',
    },
    {
      match: /rightsize.*db\.|rightsize rds|rds instance|graviton \/ gp3/i, time: '1 maintenance window', risk: 'Medium: a class change restarts the database (short downtime on Multi-AZ failover). Test performance first.',
      steps: ['Check CPU, memory (FreeableMemory) and connections in Performance Insights for 2 weeks.', 'Pick the smaller or Graviton class (r7g/m7g) and test on a snapshot restore.', 'Apply during a maintenance window; also switch storage gp2 → gp3.'],
      cli: (c) => [cmd('Change class (next maintenance window)', `aws rds modify-db-instance --region ${c.region} --db-instance-identifier ${c.db} --db-instance-class ${c.target.startsWith('db.') ? c.target : '<db.new-class>'} --storage-type gp3 --no-apply-immediately`)],
      verify: 'RDS instance hours in Cost Explorer move to the new class at the lower rate.',
    },
    {
      generic: true, match: /rightsize|scale in|smaller instance/i, time: '1 hour per instance', risk: 'Medium: needs a stop/start (brief downtime) unless behind a load balancer. Roll back by changing the type back.',
      steps: ['Confirm peak CPU and memory over 2+ weeks (install the CloudWatch agent for memory).', 'Test the smaller type in staging or on one instance of an Auto Scaling group.', 'Stop, change the type, start; for Auto Scaling groups update the launch template.'],
      cli: (c) => [
        cmd('Stop', `aws ec2 stop-instances --region ${c.region} --instance-ids ${c.instance}`),
        cmd('Change type', `aws ec2 modify-instance-attribute --region ${c.region} --instance-id ${c.instance} --instance-type "{\\"Value\\": \\"${c.target}\\"}"`),
        cmd('Start', `aws ec2 start-instances --region ${c.region} --instance-ids ${c.instance}`),
      ],
      verify: 'Cost Explorer (resource-level or by instance type) shows the new type at the lower hourly rate.',
    },
    {
      match: /compute-optimized family/i, time: '1 hour per instance', risk: 'Medium: less memory per vCPU; confirm memory headroom first.',
      steps: ['Check memory use stays well under the C-family size.', 'Change the type to the C-family size with the same vCPUs.'],
      cli: (c) => [cmd('Change type', `aws ec2 modify-instance-attribute --region ${c.region} --instance-id ${c.instance} --instance-type "{\\"Value\\": \\"<c-family-type>\\"}"`)],
      verify: 'Instance-hour rate in Cost Explorer.',
    },
    {
      generic: true, match: /previous-gen|upgrade.*→|move to graviton|graviton|modernization/i, time: '1 hour per instance (x86) / 1-2 weeks (Graviton migration)', risk: 'Low for same-architecture upgrades. Graviton needs arm64 builds of your software.',
      steps: ['Same architecture: stop, change to the newer generation, start.', 'Graviton: build and test arm64 images/packages, then move one service at a time.', 'Update launch templates so new instances use the new type.'],
      cli: (c) => (c.target.startsWith('db.')
        ? [cmd('Change DB class (next maintenance window)', `aws rds modify-db-instance --region ${c.region} --db-instance-identifier ${c.db} --db-instance-class ${c.target} --no-apply-immediately`)]
        : [cmd('Change type (instance must be stopped)', `aws ec2 modify-instance-attribute --region ${c.region} --instance-id ${c.instance} --instance-type "{\\"Value\\": \\"${c.target}\\"}"`)]),
      verify: 'Instance-hour rate in Cost Explorer for the new family.',
    },
    {
      match: /windows licensing/i, time: '2-6 weeks', risk: 'High for a platform change; low for rightsizing first.',
      steps: ['Check CPU/memory in Compute Optimizer; rightsize first (the license cost scales with vCPUs).', 'If the app runs on .NET (Core) 6+, test it on Linux.', 'Consider bring-your-own-license on Dedicated Hosts only if you already own licenses.'],
      cli: () => [],
      verify: 'Windows instance hours fall in Cost Explorer (group by Platform).',
    },
    {
      match: /containers|fargate spot/i, time: '1-2 weeks', risk: 'Low-medium. Fargate Spot tasks can be interrupted; use it for stateless or batch work.',
      steps: ['Compare task CPU/memory reservations with actual use (Container Insights).', 'Right-size task definitions.', 'Add a Fargate Spot capacity provider for interruption-tolerant services; use ARM64 images.'],
      cli: () => [],
      verify: 'Fargate vCPU-hours and GB-hours in Cost Explorer.',
    },
    {
      match: /sagemaker/i, time: '1 day', risk: 'Low.',
      steps: ['Enable idle shutdown for Studio apps and notebook instances.', 'Delete endpoints with no invocations (CloudWatch Invocations metric).', 'Use Serverless or Asynchronous Inference for spiky traffic.'],
      cli: (c) => [cmd('Endpoints', `aws sagemaker list-endpoints --region ${c.region} --query "Endpoints[].[EndpointName,EndpointStatus]" --output table`)],
      verify: 'SageMaker instance hours in Cost Explorer.',
    },
    {
      match: /bucket keys|kms/i, time: '30 minutes', risk: 'Low.',
      steps: ['S3 → bucket → Properties → Default encryption: enable "Bucket Key" for SSE-KMS buckets.', 'Schedule deletion of unused customer-managed keys (7-30 day waiting period).'],
      cli: () => [],
      verify: 'KMS request charges fall.',
    },
    {
      match: /cloudtrail/i, time: '30 minutes', risk: 'Low. Keep one organization trail for audit.',
      steps: ['CloudTrail → Trails: find trails that log the same management events.', 'Keep one; scope data events to the buckets/functions you really need.'],
      cli: () => [cmd('Trails', 'aws cloudtrail describe-trails --query "trailList[].[Name,IsMultiRegionTrail,IsOrganizationTrail]" --output table')],
      verify: 'CloudTrail line on the bill.',
    },
    {
      match: /quicksight/i, time: '30 minutes', risk: 'Low.',
      steps: ['QuickSight → Manage users: sort by last active.', 'Remove or downgrade inactive users; review SPICE capacity.'],
      cli: () => [],
      verify: 'QuickSight user charges on the next bill.',
    },
    {
      match: /glue/i, time: '1 day', risk: 'Low. Flex jobs can start later.',
      steps: ['Switch non-urgent jobs to Flex execution.', 'Enable auto scaling and lower max workers.', 'Stop idle interactive sessions.'],
      cli: () => [],
      verify: 'Glue DPU-hours in Cost Explorer.',
    },
    {
      match: /premium/i, time: '1 hour', risk: 'Medium: needs a VM stop/deallocate for some disk changes.',
      steps: ['Check disk IOPS/throughput in Azure Monitor.', 'Change the disk SKU to Standard SSD for non-production.'],
      cli: () => [],
      verify: 'Managed disk line on the Azure invoice.',
    },
    {
      match: /tags|governance/i, time: '1-2 weeks (process)', risk: 'None.',
      steps: ['Agree a required tag set (owner, environment, cost-center).', 'Enforce it with AWS Organizations Tag Policies and an SCP or AWS Config rule.', 'Activate the tags as cost allocation tags in Billing.'],
      cli: () => [cmd('Untagged resources (sample)', 'aws resourcegroupstaggingapi get-resources --query "ResourceTagMappingList[?length(Tags)==`0`].ResourceARN"')],
      verify: 'Cost Explorer → group by Tag: the "No tag" share goes down.',
    },
    // ---------------------------------------------------------------- Commitments
    {
      match: /savings plan|reserved/i, category: /Savings Plans|Reserved Instances|Commitment/, time: '1 hour', risk: 'Commitments cannot be cancelled. Buy in stages and only for steady usage.',
      steps: [
        'Do the rightsizing and cleanup actions first; the commitment here already excludes their savings.',
        'Open the Savings Plans tab: choose the term with the two questions and test the size with the simulator.',
        'In Billing and Cost Management → Savings Plans → Purchase Analyzer, enter the hourly commitment to preview coverage and utilization.',
        'Buy 60% now and the rest after a month if utilization is about 100%.',
        'Set a reminder two months before the term ends.',
      ],
      cli: () => [cmd('Your current Savings Plans', 'aws savingsplans describe-savings-plans --states active --query "savingsPlans[].[savingsPlanType,commitment,end]" --output table')],
      verify: 'Cost Explorer → Savings Plans → Utilization (aim for ~100%) and Coverage reports.',
    },
  ];

  const FALLBACK = {
    'Waste Elimination': { time: '1 day', risk: 'Low-medium: confirm the resource is unused before removing it.', steps: ['Confirm usage and ownership.', 'Remove or reduce the resource.', 'Check the next bill.'], verify: 'Cost Explorer for the service.' },
    Rightsizing: { time: '1 day', risk: 'Medium: test the smaller size first.', steps: ['Review utilization for 2+ weeks.', 'Apply the smaller size in a maintenance window.'], verify: 'Cost Explorer for the service.' },
    'Storage Optimization': { time: '1 day', risk: 'Low.', steps: ['Review storage classes and retention.', 'Apply lifecycle/retention rules.'], verify: 'Storage usage types in Cost Explorer.' },
    Modernization: { time: '1-2 weeks', risk: 'Medium.', steps: ['Test the newer option in staging.', 'Roll out gradually.'], verify: 'Cost Explorer for the service.' },
    Scheduling: { time: '1 day', risk: 'Low.', steps: ['Tag resources with a schedule.', 'Automate stop/start.'], verify: 'Running hours per month.' },
    Governance: { time: '1-2 weeks', risk: 'None.', steps: ['Define and enforce tags.'], verify: 'Untagged share of spend.' },
  };

  /** Playbook for one recommendation: { time, risk, steps[], cli[{label,cmd}], verify }. */
  const COMMIT = /Savings Plans|Reserved Instances|Commitment Discounts/;
  const NOT_AWS = /virtual machines|azure|compute engine|\bgcp\b|standard_[a-z]|\b(n1|n2|e2|c2)-/i;

  function forRec(rec) {
    const text = `${rec.title} ${rec.service || ''}`;
    const fits = (p) => p.match.test(text) && (!p.category || p.category.test(rec.category));
    // Commitments first, then service-specific playbooks, then generic compute/storage ones
    const pb = (COMMIT.test(rec.category) && /savings plan|reserved/i.test(rec.title) && PLAYBOOKS.find((p) => p.category))
      || PLAYBOOKS.find((p) => !p.generic && !p.category && fits(p))
      || PLAYBOOKS.find((p) => p.generic && fits(p));
    const base = pb || FALLBACK[rec.category] || FALLBACK['Waste Elimination'];
    const c = context(rec);
    const otherCloud = NOT_AWS.test(`${rec.service} ${rec.instanceType} ${rec.title}`);
    return {
      time: base.time, risk: base.risk, steps: base.steps.slice(),
      // AWS CLI commands do not apply to Azure/GCP resources
      cli: otherCloud ? [] : typeof base.cli === 'function' ? base.cli(c) : [],
      note: otherCloud ? 'This is an Azure/GCP resource: apply the same steps in that cloud\'s console or CLI.' : '',
      verify: base.verify, region: c.region,
    };
  }

  /** How the saving was estimated, in plain words. */
  function explain(rec) {
    const pct = rec.currentCost > 0 ? (rec.monthlySavings / rec.currentCost) * 100 : 0;
    let basis;
    if (rec.source === 'aws') basis = 'Measured by AWS for this resource, from its recent utilization.';
    else if (/Savings Plans|Reserved/.test(rec.category)) basis = 'Commitment discount applied to the steady usage left after the other actions.';
    else if (rec.fixedSavings != null) basis = 'Calculated from the actual usage quantities and charges in your data.';
    else basis = 'Typical outcome for this kind of change, applied to this item\'s cost.';
    const confidence = rec.source === 'aws' ? 'High' : rec.fixedSavings != null || /Savings Plans|Reserved/.test(rec.category) ? 'Medium' : 'Estimate';
    return { pct, annual: rec.monthlySavings * 12, basis, confidence };
  }

  return { forRec, explain, context };
});
