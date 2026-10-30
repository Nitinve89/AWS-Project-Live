/**
 * Line-item recommendation rules.
 *
 * Used when the upload has usage-type detail per service (e.g. an AWS bill PDF):
 * each rule reads the actual usage types, quantities and amounts and returns
 * recommendations with an exact dollar estimate (fixedSavings).
 *
 * Item shape: { service, region, usageType, description, quantity, unit, cost }
 * Savings factors are conservative typical outcomes, not guarantees.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FinOpsLineRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  const HOURS = 730;
  const n2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
  const int = (n) => Math.round(n).toLocaleString('en-US');
  const num = (n, d = 1) => n.toLocaleString('en-US', { maximumFractionDigits: d });
  const text = (i) => `${i.usageType || ''} ${i.description || ''}`;
  const pick = (items, re, not) => items.filter((i) => re.test(text(i)) && !(not && not.test(text(i))));
  const paid = (items) => items.filter((i) => (i.cost || 0) > 0);
  const cost = (arr) => arr.reduce((s, i) => s + (i.cost || 0), 0);
  const qty = (arr) => arr.reduce((s, i) => s + (i.quantity || 0), 0);
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
  const rec = (o) => Object.assign({ priority: 'Medium', effort: 'Low', savingsPct: 0, fixedSavings: 0 }, o);
  const INSTANCE_TYPE = /\b([a-z][a-z0-9-]*\d[a-z0-9-]*\.\d*x?(?:nano|micro|small|medium|large|xlarge|metal))\b/i;

  // Cost Explorer usage types start with a region code, e.g. "APS3-DataProcessing-Bytes"
  const USAGE_REGION = {
    USE1: 'US East (N. Virginia)', USE2: 'US East (Ohio)', USW1: 'US West (N. California)', USW2: 'US West (Oregon)',
    APS1: 'Asia Pacific (Singapore)', APS2: 'Asia Pacific (Sydney)', APS3: 'Asia Pacific (Mumbai)', APS5: 'Asia Pacific (Hyderabad)',
    APN1: 'Asia Pacific (Tokyo)', APN2: 'Asia Pacific (Seoul)', APN3: 'Asia Pacific (Osaka)', APE1: 'Asia Pacific (Hong Kong)',
    EU: 'EU (Ireland)', EUC1: 'EU (Frankfurt)', EUW2: 'EU (London)', EUW3: 'EU (Paris)', EUN1: 'EU (Stockholm)', EUS1: 'EU (Milan)',
    CAN1: 'Canada (Central)', SAE1: 'South America (Sao Paulo)', MES1: 'Middle East (Bahrain)', AFS1: 'Africa (Cape Town)',
  };
  function regionFromUsageType(u) {
    const m = /^([A-Z]{2,3}\d?)-/.exec(u || '');
    if (m && USAGE_REGION[m[1]]) return USAGE_REGION[m[1]];
    return /^[A-Z][a-z]/.test(u || '') ? USAGE_REGION.USE1 : ''; // no prefix = us-east-1
  }

  function costByRegion(items) {
    const m = new Map();
    for (const i of items) m.set(i.region || '', (m.get(i.region || '') || 0) + (i.cost || 0));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }

  const RULES = [
    // ------------------------------------------------------------------ Secrets Manager
    {
      service: /secrets\s*manager/i,
      build(items, total, ctx) {
        const api = pick(items, /api\s*request/i);
        const secrets = pick(items, /secret/i, /api\s*request/i);
        const apiCost = cost(api);
        if (apiCost < 10 || apiCost < total * 0.5) return [];
        const calls = qty(api);
        const invocations = qty(pick(ctx.itemsFor(/lambda/i), /request/i));
        const perInvocation = invocations > 0 ? calls / invocations : 0;
        return [rec({
          category: 'Waste Elimination', priority: 'High', effort: 'Low',
          title: `Cache secrets: API calls are ${pct(apiCost, total)}% of Secrets Manager cost`,
          detail: `${int(calls)} API calls cost ${n2(apiCost)} this month (about ${int(calls / (HOURS * 3600))} calls per second)`
            + `${secrets.length ? `, while storing ${num(qty(secrets), 3)} secrets costs only ${n2(cost(secrets))}` : ''}.`
            + `${perInvocation >= 0.5 ? ` That is roughly ${num(perInvocation, 1)} secret reads per Lambda invocation, so secrets are fetched on every call.` : ' The application is fetching secrets on every request.'}`
            + ' Use the AWS Parameters and Secrets Lambda Extension or the Secrets Manager caching libraries (Java, Python, .NET, Go) with a TTL of a few minutes, and load secrets once at cold start instead of per invocation. This usually removes 90%+ of calls.',
          fixedSavings: apiCost * 0.9,
        })];
      },
    },

    // ------------------------------------------------------------------ Lambda
    {
      service: /lambda/i,
      build(items) {
        const compute = paid(pick(items, /GB-?Second|Duration|Compute/i, /free\s*tier|request/i));
        const isArm = (i) => /\barm\b|-arm|arm64/i.test(text(i));
        const x86 = compute.filter((i) => !isArm(i));
        const x86Cost = cost(x86);
        if (x86Cost < 20) return [];
        const allGbs = qty(pick(items, /GB-?Second/i));
        const invocations = qty(pick(items, /request/i));
        return [rec({
          category: 'Modernization', priority: x86Cost >= 500 ? 'High' : 'Medium', effort: 'Low',
          title: 'Move Lambda functions to arm64 (Graviton)',
          detail: `${int(qty(x86))} GB-seconds of x86 compute cost ${n2(x86Cost)}`
            + `${invocations ? ` across ${int(invocations)} invocations (~${num(allGbs / invocations, 2)} GB-s each)` : ''}.`
            + ' arm64 is about 20% cheaper per GB-second and usually runs Node.js, Python and Java code unchanged.'
            + ' Use AWS Lambda Power Tuning to pick the cheapest memory size, and cut timeouts and retries on slow downstream calls. Steady compute is also covered by the Compute Savings Plan.',
          fixedSavings: x86Cost * 0.2,
        })];
      },
    },

    // ------------------------------------------------------------------ DynamoDB
    {
      service: /dynamodb/i,
      build(items) {
        const out = [];
        const throughput = pick(items, /PayPerRequest|RequestUnits|request units|ReadCapacity|WriteCapacity/i);
        const onDemand = pick(throughput, /PayPerRequest|request units|RequestUnits/i);
        const writes = pick(onDemand, /write/i);
        const reads = pick(onDemand, /read/i);
        const tpCost = cost(throughput);
        const odCost = cost(onDemand);

        if (odCost >= 50) {
          const wShare = pct(cost(writes), odCost);
          out.push(rec({
            category: 'Rightsizing', priority: odCost >= 500 ? 'High' : 'Medium', effort: 'Medium',
            title: 'Cut DynamoDB on-demand write and read costs',
            detail: `On-demand throughput costs ${n2(odCost)}: ${int(qty(writes))} write request units (${n2(cost(writes))}) and ${int(qty(reads))} read request units (${n2(cost(reads))}).`
              + `${wShare >= 60 ? ` Writes are ${wShare}% of it. Look for rewrites of unchanged items, items over 1 KB (every extra KB is another write unit), per-event counters and GSIs that copy every write.` : ''}`
              + ' For tables with steady traffic, provisioned capacity with auto scaling is usually cheaper than on-demand; keep on-demand for spiky or new tables. Use eventually consistent reads (half the read cost) where possible.',
            fixedSavings: odCost * 0.2,
          }));
        }

        const storage = paid(pick(items, /TimedStorage-ByteHrs|of storage used/i, /backup|pitr/i));
        const sCost = cost(storage);
        if (sCost >= 20) {
          const gb = qty(storage);
          const iaNet = sCost * 0.6 - tpCost * 0.25; // Standard-IA: ~60% cheaper storage, ~25% dearer throughput
          if (iaNet > 0) {
            out.push(rec({
              category: 'Storage Optimization', priority: 'Medium', effort: 'Low',
              title: 'Switch storage-heavy tables to the Standard-IA table class',
              detail: `${int(gb)} GB of table storage costs ${n2(sCost)} vs ${n2(tpCost)} for throughput. Standard-IA cuts storage price by ~60% and raises throughput price by ~25%, a net saving here. The change is online and can be reverted.`,
              fixedSavings: iaNet,
            }));
          } else {
            out.push(rec({
              category: 'Storage Optimization', priority: 'Medium', effort: 'Medium',
              title: 'Expire or archive old DynamoDB items',
              detail: `${int(gb)} GB of table storage costs ${n2(sCost)}. Moving the whole account to Standard-IA would not pay off (throughput is ${n2(tpCost)} and costs ~25% more on IA), so enable TTL on sessions, events and other time-bound items, and export cold data to S3. Use Standard-IA only for individual tables where storage dominates.`,
              fixedSavings: sCost * 0.25,
            }));
          }
        }

        const pitr = paid(pick(items, /PITR|point-in-time/i));
        if (cost(pitr) >= 10) {
          out.push(rec({
            category: 'Storage Optimization', priority: 'Low', effort: 'Low',
            title: 'Limit point-in-time recovery to tables that need it',
            detail: `PITR covers ${int(qty(pitr))} GB for ${n2(cost(pitr))}. Keep it on production tables; disable it on dev, test and easily rebuilt tables, and avoid paying again for daily AWS Backup copies of the same tables.`,
          }));
        }
        return out;
      },
    },

    // ------------------------------------------------------------------ AWS Backup
    {
      service: /backup/i,
      build(items, total, ctx) {
        if (total < 20) return [];
        const gb = qty(items.filter((i) => /GB/i.test(i.unit || '')));
        const cold = cost(pick(items, /cold/i));
        const warm = cost(pick(items, /warm/i));
        const dyn = ctx.itemsFor(/dynamodb/i);
        const dynGB = qty(pick(dyn, /TimedStorage-ByteHrs|of storage used/i, /backup|pitr/i));
        const pitrCost = cost(pick(dyn, /PITR/i));
        const ratio = dynGB > 0 && /dynamodb/i.test(items.map(text).join(' ')) ? gb / dynGB : 0;
        const split = [cold && `${n2(cold)} cold`, warm && `${n2(warm)} warm`].filter(Boolean).join(', ');
        return [rec({
          category: 'Storage Optimization', priority: total >= 100 ? 'High' : 'Medium', effort: 'Low',
          title: ratio >= 2 ? `Trim backup retention: ${num(ratio, 1)}× the live DynamoDB data` : 'Trim AWS Backup retention',
          detail: `AWS Backup stores ${int(gb)} GB-month of recovery points (${split || n2(total)})`
            + `${ratio >= 2 ? `, about ${num(ratio, 1)}× the ${int(dynGB)} GB of live DynamoDB data. That points to long retention or overlapping backup plans` : ''}.`
            + ` Shorten retention to what your policy requires, avoid daily AWS Backup copies on top of PITR${pitrCost ? ` (already ${n2(pitrCost)}/mo)` : ''}, and delete recovery points for tables and volumes that no longer exist.`,
          fixedSavings: total * 0.4,
        })];
      },
    },

    // ------------------------------------------------------------------ EC2-Other (NAT, EBS, snapshots, IPs)
    {
      service: /ec2[\s-]*other/i,
      build(items, total, ctx) {
        const out = [];
        const natData = paid(pick(items, /data processed by nat|NatGateway-Bytes/i));
        const natHours = paid(pick(items, /nat gateway hour|NatGateway-Hours/i));
        const dc = cost(natData);
        if (dc >= 20) {
          const uses = [
            ctx.itemsFor(/dynamodb/i).length && 'DynamoDB',
            ctx.itemsFor(/simple storage|\bs3\b/i).length && 'S3',
            ctx.itemsFor(/secrets\s*manager/i).length && 'Secrets Manager',
          ].filter(Boolean);
          out.push(rec({
            category: 'Waste Elimination', priority: dc >= 100 ? 'High' : 'Medium', effort: 'Medium',
            title: 'Route AWS service traffic around the NAT Gateway with VPC endpoints',
            detail: `${int(qty(natData))} GB passed through NAT Gateways, costing ${n2(dc)} in data processing`
              + `${natHours.length ? ` plus ${n2(cost(natHours))} for ${int(qty(natHours))} NAT Gateway hours` : ''}.`
              + `${uses.length ? ` This account also uses ${uses.join(', ')}; calls to them from private subnets go through NAT unless a VPC endpoint exists.` : ''}`
              + ' Add the free S3 and DynamoDB gateway endpoints, add interface endpoints for other high-volume AWS APIs (Secrets Manager, CloudWatch Logs, SQS), and check VPC Flow Logs for the top destinations.',
            fixedSavings: dc * 0.5,
          }));
        }
        const gp2 = paid(pick(items, /gp2/i));
        if (cost(gp2) >= 5) {
          out.push(rec({
            category: 'Storage Optimization', priority: 'Medium', effort: 'Low',
            title: 'Migrate gp2 EBS volumes to gp3',
            detail: `${int(qty(gp2))} GB-month of gp2 storage costs ${n2(cost(gp2))}. gp3 is about 20% cheaper per GB, includes a 3,000 IOPS / 125 MB/s baseline and can be changed online with Elastic Volumes.`,
            fixedSavings: cost(gp2) * 0.2,
          }));
        }
        const snaps = paid(pick(items, /snapshot/i));
        if (cost(snaps) >= 10) {
          out.push(rec({
            category: 'Waste Elimination', priority: 'Medium', effort: 'Low',
            title: 'Clean up old EBS snapshots',
            detail: `${int(qty(snaps))} GB-month of snapshots cost ${n2(cost(snaps))}. Apply Data Lifecycle Manager retention, delete snapshots of deleted volumes and use the Archive tier for long-term copies.`,
            fixedSavings: cost(snaps) * 0.3,
          }));
        }
        const crossAz = paid(pick(items, /Regional-Bytes|regional data transfer/i));
        if (cost(crossAz) >= 10) {
          out.push(rec({
            category: 'Waste Elimination', priority: 'Medium', effort: 'Medium',
            title: 'Reduce cross-AZ traffic',
            detail: `${int(qty(crossAz))} GB of traffic between Availability Zones cost ${n2(cost(crossAz))} (charged on both sides). Keep chatty services and their databases/caches in the same AZ and use AZ-aware routing.`,
            fixedSavings: cost(crossAz) * 0.5,
          }));
        }
        const idle = paid(pick(items, /idle\s*address|IdleAddress|not\s*associated/i));
        if (cost(idle) > 0) {
          out.push(rec({
            category: 'Waste Elimination', priority: 'Medium', effort: 'Low',
            title: 'Release idle Elastic IP addresses',
            detail: `Idle Elastic IPs cost ${n2(cost(idle))}. Release any address that is not attached to a running resource.`,
            fixedSavings: cost(idle),
          }));
        }
        return out;
      },
    },

    // ------------------------------------------------------------------ EC2 instances
    {
      service: /ec2[\s-]*instances/i,
      build(items) {
        const win = paid(pick(items, /windows/i));
        if (!win.length) return []; // generic EC2 advice applies
        const hrs = qty(win);
        const c = cost(win);
        const types = [...new Set(win.map((i) => (INSTANCE_TYPE.exec(i.description) || [])[1]).filter(Boolean))];
        return [rec({
          category: 'Modernization', priority: 'Medium', effort: 'High',
          title: `Review Windows licensing on ${types.join(', ') || 'EC2'} (${int(hrs)} hrs on-demand)`,
          detail: `${int(hrs)} instance-hours of Windows ${types.join(', ')} ran on-demand at ~${n2(c / hrs)}/hr (${n2(c)}), about ${num(hrs / HOURS, 1)} instance(s) running 24/7.`
            + ' The Windows license is roughly 40-45% of that rate and Savings Plans do not discount it. If the workload can run on Linux (for example .NET 8 on Linux), the same instance costs about 45% less.'
            + ' Otherwise check CPU and memory in AWS Compute Optimizer before committing, since an oversized Windows instance also overpays for the license. Graviton is not available for Windows.',
        })];
      },
    },

    // ------------------------------------------------------------------ CloudWatch
    {
      service: /cloudwatch/i,
      build(items, total, ctx) {
        const out = [];
        // PDF wording ("PutLogEvents", "ingested") and Cost Explorer usage types ("DataProcessing-Bytes", "VendedLog-Bytes")
        const ingest = paid(pick(items, /PutLogEvents|ingested|DataProcessing-Bytes|VendedLog-Bytes/i));
        const ic = cost(ingest);
        if (ic >= 20) {
          const vended = pick(ingest, /vended/i);
          ingest.forEach((i) => { if (!i.region) i.region = regionFromUsageType(i.usageType); });
          const regions = costByRegion(ingest);
          const top = ctx.topRegion;
          const elsewhere = regions.filter(([rg]) => rg && rg !== top);
          const elsewhereCost = elsewhere.reduce((s, [, v]) => s + v, 0);
          const regionNote = top && elsewhereCost >= ic * 0.25
            ? ` ${n2(elsewhereCost)} of it is ingested in ${elsewhere.map(([rg]) => rg).join(', ')} although most of your spend is in ${top}; find which log groups receive it and whether they are needed.`
            : '';
          out.push(rec({
            category: 'Waste Elimination', priority: ic >= 100 ? 'High' : 'Medium', effort: 'Low',
            title: 'Reduce CloudWatch Logs ingestion',
            detail: `${num(qty(ingest), 1)} GB of logs were ingested for ${n2(ic)}`
              + `${vended.length ? ` (${pct(cost(vended), ic)}% vended logs such as Lambda, VPC Flow Logs or API Gateway access logs)` : ''}.`
              + ' Lower log levels in production, stop logging full request/response bodies, use the Infrequent Access log class for logs you rarely query (about half the ingestion price), and send VPC Flow Logs to S3 instead.'
              + regionNote,
            fixedSavings: ic * 0.3,
          }));
        }
        const storage = paid(pick(items, /TimedStorage|log storage/i));
        if (cost(storage) >= 10) {
          out.push(rec({
            category: 'Storage Optimization', priority: 'Medium', effort: 'Low',
            title: 'Set CloudWatch Logs retention',
            detail: `${int(qty(storage))} GB-month of stored logs cost ${n2(cost(storage))}. Log groups never expire by default; set 30-90 day retention and export anything needed long-term to S3.`,
            fixedSavings: cost(storage) * 0.5,
          }));
        }
        const metrics = paid(pick(items, /metric/i, /GetMetricData/i));
        if (cost(metrics) >= 20) {
          out.push(rec({
            category: 'Waste Elimination', priority: 'Low', effort: 'Low',
            title: 'Remove unused custom metrics',
            detail: `${int(qty(metrics))} metrics cost ${n2(cost(metrics))}. Delete metrics nobody alarms on or charts, and reduce high-cardinality dimensions.`,
            fixedSavings: cost(metrics) * 0.3,
          }));
        }
        return out;
      },
    },

    // ------------------------------------------------------------------ CloudFront
    {
      service: /cloudfront/i,
      build(items, total, ctx) {
        if (total < 50) return [];
        const bw = paid(pick(items, /data transfer out|bandwidth/i));
        const https = paid(pick(items, /https/i, /proxy/i));
        const waf = cost(ctx.itemsFor(/\bwaf\b/i));
        return [rec({
          category: 'Commitment Discounts', priority: 'Medium', effort: 'Low',
          title: 'Use the CloudFront Security Savings Bundle and raise cache-hit ratio',
          detail: `CloudFront cost ${n2(total)}: ${n2(cost(bw))} for ${num(qty(bw), 0)} GB of data transfer out and ${n2(cost(https))} for ${int(qty(https))} HTTPS requests.`
            + ` The CloudFront Security Savings Bundle gives up to 30% off for a 1-year monthly commitment and includes AWS WAF usage credit${waf ? ` (WAF costs ${n2(waf)} here)` : ''}.`
            + ' Keep headers, cookies and query strings out of the cache key, set longer TTLs on static assets and enable compression.',
          fixedSavings: total * 0.2,
        })];
      },
    },

    // ------------------------------------------------------------------ Data Transfer
    {
      service: /data\s*transfer/i,
      build(items) {
        const out = [];
        const regional = paid(pick(items, /regional data transfer|between EC2 AZs|Regional-Bytes/i));
        if (cost(regional) >= 10) {
          out.push(rec({
            category: 'Waste Elimination', priority: 'Medium', effort: 'Medium',
            title: 'Reduce cross-AZ traffic',
            detail: `${int(qty(regional))} GB of regional traffic (between AZs, or via Elastic IPs / load balancers) cost ${n2(cost(regional))}, billed on both sides. Keep chatty services and their caches/databases in the same AZ, use AZ-aware routing, and avoid sending internal traffic to public or Elastic IPs.`,
            fixedSavings: cost(regional) * 0.5,
          }));
        }
        const out2 = paid(pick(items, /data transfer out/i, /regional|cloudfront/i));
        if (cost(out2) >= 20) {
          out.push(rec({
            category: 'Waste Elimination', priority: 'Low', effort: 'Medium',
            title: 'Serve internet traffic through CloudFront',
            detail: `${int(qty(out2))} GB to the internet cost ${n2(cost(out2))}. Transfer from AWS origins to CloudFront is free and CloudFront rates are usually lower, so put public endpoints and downloads behind CloudFront.`,
            fixedSavings: cost(out2) * 0.2,
          }));
        }
        return out;
      },
    },

    // ------------------------------------------------------------------ SES
    {
      service: /simple\s*email|\bses\b/i,
      build(items, total) {
        const vdm = paid(pick(items, /deliverability\s*manager|\bVDM\b/i));
        if (cost(vdm) < 5) return [];
        return [rec({
          category: 'Waste Elimination', priority: 'Medium', effort: 'Low',
          title: 'Turn off SES Virtual Deliverability Manager if unused',
          detail: `${int(qty(vdm))} emails were processed by Virtual Deliverability Manager for ${n2(cost(vdm))} (${pct(cost(vdm), total)}% of SES). VDM adds a per-email fee on top of sending for its dashboard and advice. If nobody uses those insights, turn it off, or enable it only for the configuration sets you monitor.`,
          fixedSavings: cost(vdm),
        })];
      },
    },

    // ------------------------------------------------------------------ WAF
    {
      service: /\bwaf\b/i,
      build(items, total) {
        const req = paid(pick(items, /request/i));
        if (total < 20 || cost(req) < total * 0.5) return [];
        return [rec({
          category: 'Commitment Discounts', priority: 'Low', effort: 'Low',
          title: 'Cover AWS WAF request fees with the CloudFront bundle',
          detail: `${int(qty(req))} inspected requests cost ${n2(cost(req))} (${pct(cost(req), total)}% of WAF); rules and web ACLs are only ${n2(total - cost(req))}. Request fees scale with traffic, so include WAF in the CloudFront Security Savings Bundle and serve static assets from a distribution without a web ACL.`,
        })];
      },
    },

    // ------------------------------------------------------------------ API Gateway
    {
      service: /api\s*gateway/i,
      build(items) {
        const rest = paid(pick(items, /ApiGatewayRequest|REST|per million requests|\/million requests/i, /HttpRequest|HTTP API|websocket|cache/i));
        if (cost(rest) < 10) return [];
        return [rec({
          category: 'Modernization', priority: 'Medium', effort: 'Medium',
          title: 'Move REST APIs to HTTP APIs',
          detail: `${int(qty(rest))} REST API requests cost ${n2(cost(rest))}. HTTP APIs cost roughly two-thirds less per request and support Lambda/HTTP integrations, JWT authorizers and CORS. Keep REST only for APIs that need API keys/usage plans, request validation, caching or private endpoints.`,
          fixedSavings: cost(rest) * 0.65,
        })];
      },
    },

    // ------------------------------------------------------------------ S3
    {
      service: /simple\s*storage|\bs3\b/i,
      build(items, total) {
        const out = [];
        const gets = paid(pick(items, /Requests-Tier2|GET and all other/i));
        const storage = paid(pick(items, /TimedStorage|of storage used/i, /request/i));
        if (cost(gets) >= 10 && cost(gets) >= total * 0.3) {
          out.push(rec({
            category: 'Waste Elimination', priority: 'Medium', effort: 'Medium',
            title: `Cut S3 GET request costs (${pct(cost(gets), total)}% of S3)`,
            detail: `${int(qty(gets))} GET/other requests cost ${n2(cost(gets))}, more than storage (${n2(cost(storage))}). Cache hot objects in CloudFront or in the application, avoid LIST/HEAD calls in loops, and combine many small objects.`,
            fixedSavings: cost(gets) * 0.3,
          }));
        }
        if (cost(storage) >= 10) {
          out.push(rec({
            category: 'Storage Optimization', priority: 'Low', effort: 'Low',
            title: 'Enable S3 Intelligent-Tiering and lifecycle rules',
            detail: `${int(qty(storage))} GB-month of storage costs ${n2(cost(storage))}. Intelligent-Tiering moves objects not accessed for 30 days to a ~40% cheaper tier automatically. Also expire old versions and abort incomplete multipart uploads after 7 days.`,
            fixedSavings: cost(storage) * 0.2,
          }));
        }
        return out;
      },
    },

    // ------------------------------------------------------------------ VPC
    {
      service: /virtual\s*private\s*cloud|\bvpc\b/i,
      build(items) {
        const ip = paid(pick(items, /ipv4/i));
        if (cost(ip) < 3) return [];
        const hrs = qty(ip);
        return [rec({
          category: 'Waste Elimination', priority: 'Low', effort: 'Low',
          title: `Review ${num(hrs / HOURS, 1)} public IPv4 addresses`,
          detail: `${int(hrs)} public IPv4 address-hours (about ${num(hrs / HOURS, 1)} addresses held all month) cost ${n2(cost(ip))}. Each public IPv4 costs about 3.65/month, attached or not. Release unneeded Elastic IPs and keep instances in private subnets; the NAT Gateway itself needs one.`,
        })];
      },
    },
  ];

  /** Run every rule that matches the service; returns recommendation objects for the engine. */
  function run(service, items, ctx) {
    const total = cost(items);
    const out = [];
    for (const rule of RULES) {
      if (!rule.service.test(service)) continue;
      out.push(...(rule.build(items, total, ctx) || []).filter(Boolean));
    }
    // Region where most of this service's cost is (used to fill in CLI commands)
    const top = costByRegion(items).find(([rg]) => rg && !/^(any|global|no region)$/i.test(rg));
    out.forEach((r) => {
      r.fixedSavings = Math.round((r.fixedSavings || 0) * 100) / 100;
      if (!r.region && top) r.region = top[0];
    });
    return out;
  }

  return { run, RULES, regionFromUsageType };
});
