/**
 * Savings Plans / Reserved capacity analyzer.
 *
 * Works on normalized resources (resource-level, service-level, Cost Explorer or CUR rows) and:
 *  1. Buckets spend by commitment type (Compute SP, EC2 Instance SP, SageMaker SP, Database SP, RIs, Azure/GCP).
 *  2. Separates on-demand vs already-covered vs Spot vs not-eligible spend.
 *  3. Sizes a conservative hourly commitment on the post-optimization baseline
 *     (rightsizing/waste savings are removed first so you never commit to waste).
 *  4. Estimates savings for every term/payment option.
 *
 * Discount rates are representative averages for common Linux workloads, not quotes.
 * AWS "up to" maxima: Compute SP 66%, EC2 Instance SP 72%, SageMaker SP 64%, Database SP 35% (1-yr only).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FinOpsCommitments = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  const HOURS_PER_MONTH = 730;
  const round2 = (n) => Math.round(n * 100) / 100;

  const TERM_OPTIONS = [
    { key: '1y-nu', label: '1-yr No Upfront', years: 1, upfront: 0 },
    { key: '1y-pu', label: '1-yr Partial Upfront', years: 1, upfront: 0.5 },
    { key: '1y-au', label: '1-yr All Upfront', years: 1, upfront: 1 },
    { key: '3y-nu', label: '3-yr No Upfront', years: 3, upfront: 0 },
    { key: '3y-pu', label: '3-yr Partial Upfront', years: 3, upfront: 0.5 },
    { key: '3y-au', label: '3-yr All Upfront', years: 3, upfront: 1 },
  ];

  /** Representative effective discounts vs on-demand per plan/component and term option. */
  const RATES = {
    computeSP_ec2: { '1y-nu': 0.27, '1y-pu': 0.30, '1y-au': 0.32, '3y-nu': 0.48, '3y-pu': 0.51, '3y-au': 0.54 },
    computeSP_fargate: { '1y-nu': 0.20, '1y-pu': 0.22, '1y-au': 0.24, '3y-nu': 0.45, '3y-pu': 0.47, '3y-au': 0.50 },
    computeSP_lambda: { '1y-nu': 0.12, '1y-pu': 0.13, '1y-au': 0.14, '3y-nu': 0.17, '3y-pu': 0.17, '3y-au': 0.17 },
    ec2InstanceSP: { '1y-nu': 0.36, '1y-pu': 0.38, '1y-au': 0.40, '3y-nu': 0.56, '3y-pu': 0.58, '3y-au': 0.60 },
    sagemakerSP: { '1y-nu': 0.25, '1y-pu': 0.28, '1y-au': 0.30, '3y-nu': 0.50, '3y-pu': 0.53, '3y-au': 0.56 },
    databaseSP_provisioned: { '1y-nu': 0.20 },
    databaseSP_serverless: { '1y-nu': 0.30 },
    dbRI: { '1y-nu': 0.30, '1y-pu': 0.34, '1y-au': 0.36, '3y-pu': 0.55, '3y-au': 0.60 },
    redshiftRN: { '1y-nu': 0.20, '1y-pu': 0.30, '1y-au': 0.33, '3y-pu': 0.58, '3y-au': 0.63 },
    azureSP: { '1y-nu': 0.22, '1y-au': 0.22, '3y-nu': 0.42, '3y-au': 0.42 },
    gcpFlexCUD: { '1y-nu': 0.28, '3y-nu': 0.46 },
  };

  /** Which spend bucket each rate component draws from (used to attribute plan savings to services). */
  const RATE_BUCKET = {
    computeSP_ec2: 'ec2', ec2InstanceSP: 'ec2', computeSP_fargate: 'fargate', computeSP_lambda: 'lambda',
    sagemakerSP: 'sagemaker', databaseSP_provisioned: 'database', databaseSP_serverless: 'database', dbRI: 'database',
    redshiftRN: 'redshift', azureSP: 'azure', gcpFlexCUD: 'gcp',
  };

  const PLAN_INFO = {
    computeSP: { label: 'Compute Savings Plan', category: 'Savings Plans', maxNote: 'up to 66% off; applies across EC2 family, size, region, OS, Fargate and Lambda' },
    ec2InstanceSP: { label: 'EC2 Instance Savings Plan', category: 'Savings Plans', maxNote: 'up to 72% off; locked to one instance family in one region' },
    sagemakerSP: { label: 'SageMaker Savings Plan', category: 'Savings Plans', maxNote: 'up to 64% off SageMaker ML instance usage' },
    databaseSP: { label: 'Database Savings Plan', category: 'Savings Plans', maxNote: 'up to 35% off; 1-yr No Upfront only; covers Aurora, RDS, DynamoDB, ElastiCache, DocumentDB, Neptune, Keyspaces, Timestream, DMS, OpenSearch' },
    dbRI: { label: 'Database Reserved Instances', category: 'Reserved Instances', maxNote: 'up to ~69% off with 3-yr; tied to engine, family and region' },
    redshiftRN: { label: 'Redshift Reserved Nodes', category: 'Reserved Instances', maxNote: 'up to ~75% off with 3-yr All Upfront' },
    azureSP: { label: 'Azure Savings Plan for Compute', category: 'Savings Plans', maxNote: 'up to 65% off; Reservations go deeper for fixed VM sizes' },
    gcpFlexCUD: { label: 'GCP Flexible Committed Use Discount', category: 'Savings Plans', maxNote: '28% (1-yr) / 46% (3-yr) off eligible Compute Engine, GKE and Cloud Run' },
  };

  // ---------------------------------------------------------------------------
  // Bucketing
  // ---------------------------------------------------------------------------

  const NOT_ELIGIBLE_RULES = [
    [/\btax\b|vat|gst/, 'Tax, not usage'],
    [/support\s*\(|aws\s*support|premium support|business support|enterprise support/, 'Support plan fee'],
    [/marketplace/, 'Marketplace charge; negotiate with the vendor'],
    [/ec2[\s-]*other|elastic\s*block\s*store|\bebs\b|ebs:|volumeusage|snapshotusage|snapshot/, 'EBS storage/snapshots are not covered by Savings Plans; optimize with gp3 and snapshot cleanup'],
    [/nat\s*gateway|natgateway/, 'NAT Gateway is not commitment-eligible; consider VPC endpoints to cut data processing'],
    [/data\s*transfer|datatransfer|-bytes|\bbytes\b|egress/, 'Data transfer is not commitment-eligible; reduce cross-AZ/egress traffic'],
    [/elastic\s*ip|elasticip|public\s*ipv4|idleaddress/, 'Public IPv4 charges are not commitment-eligible; release unused IPs'],
    [/load\s*balanc|\belb\b|loadbalancing/, 'Load balancers are not commitment-eligible'],
    [/cloudfront/, 'Not covered by Savings Plans; look at CloudFront flat-rate / Security Savings Bundle'],
    [/simple\s*storage|\bs3\b|amazons3|glacier|blob|cloud\s*storage/, 'Object storage has no commitment discount; use lifecycle/tiering'],
    [/cloudwatch|cloudtrail|\bconfig\b|guardduty|security\s*hub|\bkms\b|route\s*53|\bwaf\b|secrets\s*manager|\bsns\b|\bsqs\b|api\s*gateway|\bvpc\b|backup/, 'Usage-based service with no Savings Plan option'],
  ];

  function awsGen(type) {
    const m = /^(?:db\.|cache\.)?([a-z]+)(\d+)([a-z-]*)\.(\w+)$/i.exec(String(type || '').trim());
    return m ? { family: `${m[1]}${m[2]}${m[3]}`.toLowerCase(), gen: parseInt(m[2], 10), size: m[4].toLowerCase() } : null;
  }

  /**
   * Returns { bucket, share, reason, serverless } where bucket is one of:
   * ec2, fargate, lambda, sagemaker, database, redshift, azure, gcp, excluded
   */
  function bucketFor(r) {
    const svc = r.service.toLowerCase();
    const text = `${svc} ${r.usageType.toLowerCase()} ${r.instanceType.toLowerCase()}`;
    const ut = r.usageType.toLowerCase();

    // SageMaker, Lambda, Fargate first: their usage types can contain words like "instance"
    if (/sagemaker/.test(text)) return { bucket: 'sagemaker', share: 1 };
    if (/lambda/.test(text)) return { bucket: 'lambda', share: 1 };
    if (/fargate/.test(text)) return { bucket: 'fargate', share: 1 };
    if (/elastic\s*container\s*service|\becs\b|amazonecs/.test(svc)) return { bucket: 'fargate', share: 1 };
    if (/elastic\s*kubernetes|\beks\b|amazoneks/.test(svc)) {
      return { bucket: 'excluded', reason: 'EKS control-plane fee is not eligible; worker nodes are billed (and covered) under EC2' };
    }
    if (/redshift/.test(text)) return { bucket: 'redshift', share: 1 };
    if (/relational\s*database|\brds\b|amazonrds|aurora|dynamodb|elasticache|documentdb|neptune|keyspaces|timestream|database\s*migration|\bdms\b|opensearch|elasticsearch|^db\./.test(text)) {
      const serverless = /serverless|dynamodb|keyspaces|timestream|requestunits|readrequest|writerequest|acu/.test(text);
      return { bucket: 'database', share: 1, serverless };
    }

    for (const [re, reason] of NOT_ELIGIBLE_RULES) if (re.test(text)) return { bucket: 'excluded', reason };

    if (/spot/.test(ut) || /spot/.test(r.pricingModel.toLowerCase())) return { bucket: 'excluded', reason: 'Already on Spot pricing' };

    const isEc2 = /elastic\s*compute\s*cloud|\bec2\b|amazonec2|ec2-instances|boxusage|dedicatedusage|hostusage/.test(text)
      || (awsGen(r.instanceType) && !/^(db|cache)\./i.test(r.instanceType));
    if (isEc2) {
      // A service-level "Amazon Elastic Compute Cloud" total also contains EBS, NAT, data transfer, IPs.
      const mixed = r._synthId && !r.instanceType && !ut && !/instances|-\s*compute|boxusage/.test(svc);
      return { bucket: 'ec2', share: mixed ? 0.7 : 1, mixed };
    }

    if (/virtual\s*machines?|azure|app\s*service|^standard_/.test(text)) return { bucket: 'azure', share: 1 };
    if (/compute\s*engine|cloud\s*run|\bgke\b|kubernetes\s*engine|\b(n1|n2|n2d|n4|e2|c2|c2d|c3|c4|m1|m2|m3|t2d|t2a)-/.test(text)) return { bucket: 'gcp', share: 1 };

    return { bucket: 'excluded', reason: 'No commitment discount available for this service' };
  }

  /** Graviton (ARM) equivalent of an x86 type, e.g. m6i.xlarge → m7g.xlarge. '' if none or already Graviton. */
  function gravitonOf(type) {
    const m = /^([a-z]+)(\d+)([a-z-]*)\.(\w+)$/i.exec(String(type || ''));
    if (!m || /g/.test(m[3])) return '';
    const fam = m[1].toLowerCase();
    const map = { m: 'm7g', c: 'c7g', r: 'r7g', t: 't4g', x: 'x2gd', i: 'im4gn' };
    if (!map[fam]) return '';
    const size = m[4].toLowerCase();
    if (fam === 't' && !['nano', 'micro', 'small', 'medium', 'large', 'xlarge', '2xlarge'].includes(size)) return '';
    return `${map[fam]}.${size}`;
  }

  const BUCKET_LABELS = {
    ec2: 'EC2 instances', fargate: 'Fargate', lambda: 'Lambda', sagemaker: 'SageMaker', database: 'Databases',
    redshift: 'Redshift', azure: 'Azure compute', gcp: 'GCP compute', excluded: 'Not eligible',
  };

  const BUCKET_PLAN = {
    ec2: 'Compute SP / EC2 Instance SP', fargate: 'Compute SP', lambda: 'Compute SP', sagemaker: 'SageMaker SP',
    database: 'Database SP / Reserved Instances', redshift: 'Redshift Reserved Nodes', azure: 'Azure Savings Plan / Reservations',
    gcp: 'Committed Use Discounts', excluded: '—',
  };

  // ---------------------------------------------------------------------------
  // Sizing helpers
  // ---------------------------------------------------------------------------

  function rateFor(rateKey, termKey) {
    const table = RATES[rateKey];
    if (table[termKey] != null) return { term: termKey, discount: table[termKey] };
    // Fall back to the same term with another payment option, then to 1-yr No Upfront
    const sameTerm = Object.keys(table).find((k) => k.startsWith(termKey.slice(0, 2)));
    if (sameTerm) return { term: sameTerm, discount: table[sameTerm] };
    const first = Object.keys(table)[0];
    return { term: first, discount: table[first] };
  }

  /**
   * Build the option set for a plan made of components [{ rateKey, od }].
   * od = on-demand monthly spend to be covered.
   */
  function buildOptions(components, availableTerms) {
    return TERM_OPTIONS.filter((t) => availableTerms.includes(t.key)).map((t) => {
      let savings = 0; let commitMonthly = 0; let od = 0;
      const byBucket = {};
      const byBucketCommit = {}; // hourly commitment attributable to each bucket
      for (const c of components) {
        const d = RATES[c.rateKey][t.key];
        if (d == null) continue;
        od += c.od;
        savings += c.od * d;
        commitMonthly += c.od * (1 - d);
        const bucket = RATE_BUCKET[c.rateKey];
        byBucket[bucket] = (byBucket[bucket] || 0) + c.od * d;
        byBucketCommit[bucket] = (byBucketCommit[bucket] || 0) + (c.od * (1 - d)) / HOURS_PER_MONTH;
      }
      const hourly = commitMonthly / HOURS_PER_MONTH;
      const termCommit = hourly * HOURS_PER_MONTH * 12 * t.years;
      return {
        key: t.key, label: t.label,
        discountPct: od > 0 ? round2((savings / od) * 100) : 0,
        hourlyCommitment: round2(hourly),
        monthlySavings: round2(savings),
        upfront: round2(termCommit * t.upfront),
        totalTermSavings: round2(savings * 12 * t.years),
        byBucket,
        byBucketCommit,
      };
    });
  }

  function termsOf(...rateKeys) {
    return TERM_OPTIONS.map((t) => t.key).filter((k) => rateKeys.every((rk) => RATES[rk][k] != null));
  }

  function pickOption(options, preferred) {
    return options.find((o) => o.key === preferred)
      || options.find((o) => o.key.slice(0, 2) === preferred.slice(0, 2))
      || options[0];
  }

  // ---------------------------------------------------------------------------
  // What-if simulation
  // ---------------------------------------------------------------------------

  /**
   * Inputs for the commitment simulator:
   *  baselineOD    on-demand usage per month that a 100% commitment would cover (the steady floor)
   *  recommendedX  where the recommendation sits on that scale (estimates: target coverage; AWS: 100%)
   *  usageFactors  each month's usage relative to the floor (>= 1), from the plan's services' history
   */
  function simulationInputs(p, buckets, target) {
    const keys = Object.keys(p.recommended.byBucket || {});
    // Sum the services' monthly history (oldest → latest); only months every resource has
    let series = null;
    for (const k of keys) {
      for (const it of (buckets[k] && buckets[k].items) || []) {
        const m = it.r.monthly;
        if (!m || m.length < 2) continue;
        const share = it.r.cost > 0 ? it.od / it.r.cost : 1; // eligible part of the row
        if (!series) series = m.map(() => 0);
        if (m.length !== series.length) continue; // all rows share the same month list
        m.forEach((v, i) => { series[i] += v * share; });
      }
    }
    let usageFactors = [1];
    if (series && series.length >= 2) {
      const recent = series.slice(-3).filter((v) => v > 0);
      const floor = Math.min(...recent);
      if (floor > 0) usageFactors = recent.map((v) => round2(v / floor));
    }
    const aws = p.source === 'aws';
    const x = aws ? 1 : Math.max(0.05, target);
    return {
      baselineOD: round2(p.coveredOnDemand / x),
      recommendedX: x,
      usageFactors,
      discount: (p.recommended.discountPct || 0) / 100,
    };
  }

  /**
   * Monthly result of committing `x` × baseline (on-demand equivalent) at discount d.
   * Each month: covered usage saves d; commitment above that month's usage is paid but unused.
   */
  function simulate(p, x) {
    const B = p.baselineOD; const d = p.discount;
    const C = B * x;
    const months = p.usageFactors.map((f) => {
      const usage = B * f;
      const used = Math.min(C, usage);
      const unused = Math.max(0, C - usage);
      return { savings: used * d - unused * (1 - d), unused: unused * (1 - d), utilization: C > 0 ? used / C : 1 };
    });
    const avg = (k) => months.reduce((s, m) => s + m[k], 0) / months.length;
    return {
      x, coveredOD: round2(C),
      hourly: round2((C * (1 - d)) / HOURS_PER_MONTH),
      monthlySavings: round2(avg('savings')),
      worstMonth: round2(Math.min(...months.map((m) => m.savings))),
      wasted: round2(avg('unused')),
      utilizationPct: round2(avg('utilization') * 100),
    };
  }

  // ---------------------------------------------------------------------------
  // AWS Cost Explorer recommendations (replace estimates when available)
  // ---------------------------------------------------------------------------

  const okData = (v) => v && !v.error;

  /** Split an AWS plan's savings/commitment across our buckets by steady usage, for per-service attribution. */
  function splitByBuckets(keys, buckets, amount) {
    const w = keys.map((k) => (buckets[k] ? (buckets[k].baseline || buckets[k].onDemand) : 0));
    const total = w.reduce((a, b) => a + b, 0);
    const out = {};
    keys.forEach((k, i) => {
      const share = total > 0 ? w[i] / total : (i === 0 ? 1 : 0);
      if (share > 0) out[k] = amount * share;
    });
    return out;
  }

  /** Actual Savings Plans coverage from Cost Explorer (last full month), with the projected value after the SP purchases. */
  function awsCoverage(aws, plans) {
    const c = aws && aws.coverage;
    if (!okData(c) || !(c.total > 0)) return null;
    const spCovered = plans.filter((p) => p.source === 'aws' && /SP$/.test(p.planType)).reduce((s, p) => s + p.coveredOnDemand, 0);
    return {
      eligibleOnDemand: round2(c.onDemand), covered: round2(c.covered), source: 'aws', month: c.month,
      currentPct: round2(c.coveragePct),
      projectedPct: round2(Math.min(100, ((c.covered + spCovered) / c.total) * 100)),
      utilizationPct: okData(aws.utilization) ? aws.utilization.utilizationPct : null,
    };
  }

  function awsPlan(planType, a, keys, buckets, term, extra) {
    const t = TERM_OPTIONS.find((x) => x.key === term) || TERM_OPTIONS[0];
    const pct = a.savingsPct || 0;
    const monthly = a.monthlySavings || 0;
    const covered = pct > 0 ? monthly / (pct / 100) : 0; // on-demand equivalent of the usage covered
    const option = {
      key: t.key, label: t.label, discountPct: round2(pct), hourlyCommitment: round2(a.hourly || 0),
      monthlySavings: round2(monthly), upfront: round2(a.upfront || 0),
      totalTermSavings: round2(monthly * 12 * t.years),
      byBucket: splitByBuckets(keys, buckets, monthly),
      byBucketCommit: splitByBuckets(keys, buckets, a.hourly || 0),
    };
    return Object.assign({
      planType, source: 'aws', coveredOnDemand: round2(covered), options: [option], recommended: option,
      generatedAt: a.generatedAt, lookbackDays: a.lookbackDays, details: a.details || [],
    }, extra);
  }

  /**
   * Replace estimated plans with AWS recommendations where AWS returned data.
   * AWS sizes each plan type independently, so overlapping types are not added together:
   * Compute SP is used for EC2/Fargate/Lambda (EC2 Instance SP shown as an alternative),
   * and databases use Database SP (1-yr) or Reserved Instances (3-yr / no Database SP data).
   */
  function applyAwsPlans(plans, aws, buckets, term) {
    const notes = [];
    const sp = aws.savingsPlans || {};
    const ri = aws.reservations || {};
    const drop = (...types) => { for (let i = plans.length - 1; i >= 0; i--) if (types.includes(plans[i].planType)) plans.splice(i, 1); };
    const util = (a) => {
      const d = (a.details || []).filter((x) => x.utilizationPct);
      return d.length ? d.reduce((s, x) => s + x.utilizationPct, 0) / d.length : 0;
    };
    const lookback = (a) => `${a.lookbackDays || 30} days`;

    if (okData(sp.COMPUTE_SP)) {
      drop('computeSP', 'ec2InstanceSP');
      const a = sp.COMPUTE_SP;
      const alt = okData(sp.EC2_INSTANCE_SP) && sp.EC2_INSTANCE_SP.monthlySavings > 0 ? sp.EC2_INSTANCE_SP : null;
      if (a.monthlySavings > 0) {
        plans.push(awsPlan('computeSP', a, ['ec2', 'fargate', 'lambda'], buckets, term, {
          scope: 'EC2 + Fargate + Lambda (account-wide)', appliesTo: 'Any EC2 family/size/region/OS, Fargate and Lambda',
          rationale: `AWS Cost Explorer recommendation based on your last ${lookback(a)} of usage${util(a) ? `, expected utilization ${util(a).toFixed(0)}%` : ''}. It already accounts for Savings Plans and RIs you own.`
            + (alt ? ` Alternative: EC2 Instance SP${alt.details[0] && alt.details[0].family ? ` (${alt.details[0].family} in ${alt.details[0].region})` : ''} at ${alt.hourly.toFixed(3)}/hr would save ${alt.monthlySavings.toFixed(2)}/mo but locks family and region. Do not buy both for the same usage.` : ''),
          alternative: alt,
        }));
      } else notes.push('AWS recommends no new Compute Savings Plan: current coverage already matches your steady usage.');
    } else if (okData(sp.EC2_INSTANCE_SP)) {
      drop('ec2InstanceSP');
      if (sp.EC2_INSTANCE_SP.monthlySavings > 0) {
        const a = sp.EC2_INSTANCE_SP;
        plans.push(awsPlan('ec2InstanceSP', a, ['ec2'], buckets, term, {
          scope: a.details.map((d) => `${d.family} in ${d.region}`).slice(0, 3).join(', ') || 'EC2',
          appliesTo: 'Specific EC2 instance families in specific regions',
          rationale: `AWS Cost Explorer recommendation based on your last ${lookback(a)} of usage.`,
        }));
      }
    }

    if (okData(sp.SAGEMAKER_SP)) {
      drop('sagemakerSP');
      if (sp.SAGEMAKER_SP.monthlySavings > 0) {
        plans.push(awsPlan('sagemakerSP', sp.SAGEMAKER_SP, ['sagemaker'], buckets, term, {
          scope: 'SageMaker', appliesTo: 'SageMaker training, inference, notebooks and processing',
          rationale: `AWS Cost Explorer recommendation based on your last ${lookback(sp.SAGEMAKER_SP)} of usage.`,
        }));
      }
    }

    // Databases: one source only, to avoid counting the same usage twice
    const dbRis = ['rds', 'elasticache', 'opensearch'].map((k) => ri[k]).filter(okData);
    const riSum = dbRis.reduce((acc, r) => ({
      monthlySavings: acc.monthlySavings + r.monthlySavings, hourly: acc.hourly + r.hourly, upfront: acc.upfront + r.upfront,
      onDemand: acc.onDemand + r.onDemandMonthly, details: acc.details.concat(r.details || []), lookbackDays: r.lookbackDays,
    }), { monthlySavings: 0, hourly: 0, upfront: 0, onDemand: 0, details: [], lookbackDays: 30 });
    riSum.savingsPct = riSum.onDemand > 0 ? (riSum.monthlySavings / riSum.onDemand) * 100 : 0;
    const dbSp = okData(sp.DATABASE_SP) ? sp.DATABASE_SP : null;
    const useDbSp = dbSp && term.startsWith('1y') && dbSp.monthlySavings >= riSum.monthlySavings * 0.6;
    if (useDbSp || dbRis.length) drop('databaseSP', 'dbRI');
    if (useDbSp && dbSp.monthlySavings > 0) {
      plans.push(awsPlan('databaseSP', dbSp, ['database'], buckets, term, {
        scope: 'Managed databases (account-wide)', appliesTo: 'Aurora, RDS, DynamoDB, ElastiCache, DocumentDB, Neptune, Keyspaces, Timestream, DMS, OpenSearch',
        rationale: `AWS Cost Explorer recommendation based on your last ${lookback(dbSp)} of usage. Database Savings Plans are 1-year only.`
          + (riSum.monthlySavings > 0 ? ` Reserved Instances would save ${riSum.monthlySavings.toFixed(2)}/mo instead; they are less flexible.` : ''),
      }));
    } else if (riSum.monthlySavings > 0) {
      plans.push(awsPlan('dbRI', riSum, ['database'], buckets, term, {
        scope: riSum.details.slice(0, 3).map((d) => `${d.count}× ${d.instanceType}`).join(', ') || 'Database instances',
        appliesTo: 'Specific engine, instance family and region',
        rationale: `AWS Cost Explorer Reserved Instance recommendation based on your last ${lookback(riSum)} of usage.`
          + (dbSp && !term.startsWith('1y') ? ' Database Savings Plans have no 3-year option, so RIs are used for this term.' : ''),
      }));
    } else if (dbSp && dbSp.monthlySavings === 0) {
      notes.push('AWS recommends no new database commitment.');
    }

    if (okData(ri.redshift)) {
      drop('redshiftRN');
      if (ri.redshift.monthlySavings > 0) {
        plans.push(awsPlan('redshiftRN', ri.redshift, ['redshift'], buckets, term, {
          scope: ri.redshift.details.slice(0, 3).map((d) => `${d.count}× ${d.instanceType}`).join(', ') || 'Redshift nodes',
          appliesTo: 'Redshift node type in a region',
          rationale: `AWS Cost Explorer Reserved Node recommendation based on your last ${lookback(ri.redshift)} of usage.`,
        }));
      }
    }
    return notes;
  }

  // ---------------------------------------------------------------------------
  // Main
  // ---------------------------------------------------------------------------

  /**
   * @param {object[]} resources  normalized resources
   * @param {Map<string, number>} optimizationSavings  resourceId -> monthly savings from non-commitment recs
   * @param {object} helpers  { isNonProd }
   * @param {object} opts     { term: '1y-nu', targetCoverage: 0.8 }
   */
  function analyzeCommitments(resources, optimizationSavings, helpers, opts = {}) {
    const term = opts.term || '1y-nu';
    const hasSeries = resources.some((r) => r.monthly && r.monthly.length >= 2);
    const target = opts.targetCoverage != null ? opts.targetCoverage : (hasSeries ? 0.8 : 0.7);

    const buckets = {};
    const services = new Map();
    const ensureBucket = (k) => (buckets[k] = buckets[k] || { key: k, label: BUCKET_LABELS[k], onDemand: 0, covered: 0, spot: 0, baseline: 0, items: [] });

    for (const r of resources) {
      if (r.cost <= 0 && !r.costCovered) continue;
      const b = bucketFor(r);
      const bucket = ensureBucket(b.bucket);

      // Line-item detail tells us exactly which share is commitment-eligible (e.g. Lambda duration, not requests)
      const share = r.eligibleShare != null && b.bucket !== 'excluded' ? r.eligibleShare : (b.share || 1);
      const od = Math.max(0, r.costOD) * share;
      const optSave = optimizationSavings.get(r.id) || 0;
      const optRatio = r.cost > 0 ? Math.max(0, 1 - optSave / r.cost) : 1;
      // Use the lowest recent month as the steady-state floor so commitments survive seasonal dips.
      let floorRatio = 1;
      if (r.monthly && r.monthly.length >= 2) {
        const latest = r.monthly[r.monthly.length - 1];
        const recent = r.monthly.slice(-3).filter((v) => v != null);
        if (latest > 0 && recent.length) floorRatio = Math.min(1, Math.min(...recent) / latest);
      }
      const nonProd = helpers.isNonProd(r.environment);
      // Non-prod without a scheduling rec is still assumed to be only half steady-state
      const nonProdFactor = nonProd && optSave === 0 ? 0.5 : 1;
      const baseline = b.bucket === 'excluded' ? 0 : od * optRatio * floorRatio * nonProdFactor;

      bucket.onDemand += od;
      bucket.covered += r.costCovered || 0;
      bucket.spot += r.costSpot || 0;
      bucket.baseline += baseline;
      bucket.items.push({ r, od, baseline, b });

      // Service eligibility table
      const sKey = r.service || BUCKET_LABELS[b.bucket];
      const s = services.get(sKey) || { service: sKey, cost: 0, onDemand: 0, covered: 0, bucket: b.bucket, plan: BUCKET_PLAN[b.bucket], notes: new Set() };
      s.cost += r.cost;
      s.onDemand += r.costOD;
      s.covered += r.costCovered || 0;
      if (b.reason) s.notes.add(b.reason);
      if (r.eligibleShare != null && r.eligibleShare < 0.995 && b.bucket !== 'excluded') {
        s.notes.add(/windows/i.test(r.usageType)
          ? 'Windows license (~44% of the hourly rate) is not discounted by Savings Plans; sized on the compute portion only.'
          : `Only ${Math.round(r.eligibleShare * 100)}% of this cost is commitment-eligible (compute duration / throughput); storage, requests and backups are not.`);
      }
      if (b.mixed) s.notes.add('Service total includes EBS, NAT and data transfer; ~70% assumed to be instance usage. Upload EC2-Instances or usage-type detail for precision.');
      if (nonProd && b.bucket !== 'excluded') s.notes.add('Non-production usage counted at 50% (should be scheduled off-hours)');
      services.set(sKey, s);
    }

    const plans = [];
    const cov = (x) => x * target;

    // ---- EC2: EC2 Instance SP for concentrated, current-gen family/region; Compute SP for the rest ----
    const ec2 = buckets.ec2;
    let ec2Remainder = ec2 ? ec2.baseline : 0;
    const ec2Groups = [];
    // Where each instance is heading (rightsizing / newer generation), so EC2 Instance SPs are bought
    // for the family you will run on, not the one you are leaving.
    const targets = helpers.targets || new Map();
    // Only instance-level rows have a meaningful target (service totals can hold many instances)
    const targetOfRow = (r) => (r.instanceType ? targets.get(r.id) : null);
    const typeAfter = (it) => {
      const t = targetOfRow(it.r);
      return t && t.to ? t.to : it.r.instanceType;
    };
    if (ec2 && ec2.baseline > 0) {
      const groups = new Map();
      for (const it of ec2.items) {
        const t = targetOfRow(it.r);
        if (t && t.remove) continue;
        const g = awsGen(typeAfter(it));
        if (!g || g.gen < 5 || !it.r.region || helpers.isNonProd(it.r.environment)) continue;
        const key = `${g.family}|${it.r.region}`;
        const e = groups.get(key) || { base: 0, from: new Set() };
        e.base += it.baseline;
        const fg = awsGen(it.r.instanceType);
        if (fg && fg.family !== g.family) e.from.add(fg.family);
        groups.set(key, e);
      }
      for (const [key, e] of [...groups.entries()].sort((a, b) => b[1].base - a[1].base)) {
        const [family, region] = key.split('|');
        const base = e.base;
        if (base <= 0) continue; // fully covered already
        const qualifies = base / ec2.baseline >= 0.3 && base >= 50;
        const from = [...e.from];
        ec2Groups.push({ family, region, from, baseline: round2(base), sharePct: round2((base / ec2.baseline) * 100), instanceSP: qualifies });
        if (!qualifies) continue;
        const od = cov(base);
        const options = buildOptions([{ rateKey: 'ec2InstanceSP', od }], termsOf('ec2InstanceSP'));
        plans.push({
          planType: 'ec2InstanceSP', scope: `${family} family in ${region}`, appliesTo: `EC2 ${family} (any size, OS, AZ) in ${region}`,
          family, region, fromFamilies: from,
          coveredOnDemand: round2(od), options, recommended: pickOption(options, term),
          rationale: `${Math.round((base / ec2.baseline) * 100)}% of steady EC2 spend will run on ${family} in ${region}`
            + `${from.length ? ` after moving ${from.join(', ')} → ${family}. Make that move first, then buy the plan for ${family}` : ''}.`
            + ' Committing this slice to an EC2 Instance SP earns ~9 points more discount than a Compute SP. Only do this if you do not plan to change family or region during the term.',
        });
        ec2Remainder -= base;
      }
    }

    // ---- Compute SP: remaining EC2 + Fargate + Lambda ----
    const comp = [];
    if (ec2Remainder > 0) comp.push({ rateKey: 'computeSP_ec2', od: cov(ec2Remainder), label: 'EC2' });
    if (buckets.fargate && buckets.fargate.baseline > 0) comp.push({ rateKey: 'computeSP_fargate', od: cov(buckets.fargate.baseline), label: 'Fargate' });
    if (buckets.lambda && buckets.lambda.baseline > 0) comp.push({ rateKey: 'computeSP_lambda', od: cov(buckets.lambda.baseline), label: 'Lambda' });
    if (comp.length) {
      const options = buildOptions(comp, termsOf('computeSP_ec2'));
      plans.push({
        planType: 'computeSP', scope: comp.map((c) => c.label).join(' + '), appliesTo: 'Any EC2 family/size/region/OS, Fargate and Lambda',
        coveredOnDemand: round2(comp.reduce((s, c) => s + c.od, 0)), options, recommended: pickOption(options, term),
        rationale: `Covers ${Math.round(target * 100)}% of your steady-state ${comp.map((c) => c.label).join(', ')} on-demand spend after rightsizing and waste removal. The most flexible plan: it follows workloads across instance families, regions and services.`,
      });
    }

    // ---- SageMaker ----
    if (buckets.sagemaker && buckets.sagemaker.baseline > 0) {
      const od = cov(buckets.sagemaker.baseline);
      const options = buildOptions([{ rateKey: 'sagemakerSP', od }], termsOf('sagemakerSP'));
      plans.push({
        planType: 'sagemakerSP', scope: 'SageMaker', appliesTo: 'SageMaker training, real-time inference, notebooks, Studio, processing',
        coveredOnDemand: round2(od), options, recommended: pickOption(options, term),
        rationale: 'SageMaker usage is not covered by Compute Savings Plans. A SageMaker SP applies across instance family, size, region and component.',
      });
    }

    // ---- Databases: Database SP (1-yr) for flexible/serverless/current-gen, RIs for older-gen or 3-yr preference ----
    const db = buckets.database;
    if (db && db.baseline > 0) {
      let dspProv = 0; let dspServerless = 0; let riBase = 0;
      const want3y = term.startsWith('3y');
      for (const it of db.items) {
        const g = awsGen(it.r.instanceType);
        const b = it.b;
        if (b.serverless) dspServerless += it.baseline;
        else if (want3y || (g && g.gen < 7)) riBase += it.baseline;
        else dspProv += it.baseline;
      }
      if (dspProv + dspServerless > 0) {
        const comps = [];
        if (dspProv > 0) comps.push({ rateKey: 'databaseSP_provisioned', od: cov(dspProv) });
        if (dspServerless > 0) comps.push({ rateKey: 'databaseSP_serverless', od: cov(dspServerless) });
        const options = buildOptions(comps, ['1y-nu']);
        plans.push({
          planType: 'databaseSP', scope: 'Managed databases', appliesTo: 'Aurora, RDS, DynamoDB, ElastiCache, DocumentDB, Neptune, Keyspaces, Timestream, DMS, OpenSearch',
          coveredOnDemand: round2(comps.reduce((s, c) => s + c.od, 0)), options, recommended: options[0],
          rationale: `Database Savings Plans apply across engines and regions, including serverless (~35% max) and latest-generation provisioned instances (~20%). Only offered as 1-yr No Upfront.${want3y ? ' Serverless usage stays here because RIs do not cover it.' : ''}`,
        });
      }
      if (riBase > 0) {
        const od = cov(riBase);
        const options = buildOptions([{ rateKey: 'dbRI', od }], termsOf('dbRI'));
        plans.push({
          planType: 'dbRI', scope: 'RDS / ElastiCache / OpenSearch instances', appliesTo: 'Specific engine + instance family + region (size-flexible within family for most engines)',
          coveredOnDemand: round2(od), options, recommended: pickOption(options, term),
          rationale: want3y
            ? 'For a 3-year horizon, Reserved Instances beat the 35% Database SP ceiling (up to ~60-69% off).'
            : 'These run older-generation instances that Database Savings Plans do not cover. Buy RIs, or upgrade to Graviton gen-7+ first and use a Database SP.',
        });
      }
    }

    // ---- Redshift ----
    if (buckets.redshift && buckets.redshift.baseline > 0) {
      const od = cov(buckets.redshift.baseline);
      const options = buildOptions([{ rateKey: 'redshiftRN', od }], termsOf('redshiftRN'));
      plans.push({
        planType: 'redshiftRN', scope: 'Redshift provisioned clusters', appliesTo: 'Redshift node type in a region',
        coveredOnDemand: round2(od), options, recommended: pickOption(options, term),
        rationale: 'Redshift is not covered by Savings Plans. Reserved Nodes are the commitment option for steady provisioned clusters.',
      });
    }

    // ---- Azure / GCP ----
    if (buckets.azure && buckets.azure.baseline > 0) {
      const od = cov(buckets.azure.baseline);
      const options = buildOptions([{ rateKey: 'azureSP', od }], termsOf('azureSP'));
      plans.push({
        planType: 'azureSP', scope: 'Azure compute', appliesTo: 'VMs, App Service, Functions Premium, Container Instances across regions',
        coveredOnDemand: round2(od), options, recommended: pickOption(options, term),
        rationale: 'Pay-as-you-go Azure compute with steady usage. Use Reservations for VMs whose size will not change.',
      });
    }
    if (buckets.gcp && buckets.gcp.baseline > 0) {
      const od = cov(buckets.gcp.baseline);
      const options = buildOptions([{ rateKey: 'gcpFlexCUD', od }], termsOf('gcpFlexCUD'));
      plans.push({
        planType: 'gcpFlexCUD', scope: 'GCP compute', appliesTo: 'Compute Engine vCPU/memory, GKE, Cloud Run across regions and families',
        coveredOnDemand: round2(od), options, recommended: pickOption(options, term),
        rationale: 'Steady Compute Engine usage. Note sustained-use discounts already apply to N1/N2; CUDs replace them on covered usage.',
      });
    }

    const awsNotes = opts.aws ? applyAwsPlans(plans, opts.aws, buckets, term) : [];

    plans.forEach((p) => Object.assign(p, PLAN_INFO[p.planType]));
    plans.sort((a, b) => b.recommended.monthlySavings - a.recommended.monthlySavings);
    plans.forEach((p) => Object.assign(p, simulationInputs(p, buckets, target)));

    // ---- Attribute plan savings back to resources, pro rata to their steady-state baseline ----
    const bucketSavings = {};
    const bucketCommit = {};
    const bucketCovered = {};
    const bucketPlans = {};
    for (const p of plans) {
      const o = p.recommended;
      for (const [bk, s] of Object.entries(o.byBucket || {})) {
        bucketSavings[bk] = (bucketSavings[bk] || 0) + s;
        bucketCommit[bk] = (bucketCommit[bk] || 0) + (o.byBucketCommit[bk] || 0);
        (bucketPlans[bk] = bucketPlans[bk] || new Set()).add(p.label);
      }
    }
    for (const [bk, b] of Object.entries(buckets)) bucketCovered[bk] = bk === 'excluded' ? 0 : b.baseline * target;

    const byResource = {};
    for (const b of Object.values(buckets)) {
      if (!bucketSavings[b.key] || b.baseline <= 0) continue;
      for (const it of b.items) {
        if (it.baseline <= 0) continue;
        const share = it.baseline / b.baseline;
        const e = byResource[it.r.id] || (byResource[it.r.id] = { savings: 0, hourly: 0, coveredOnDemand: 0, plans: new Set(), bucket: b.key });
        e.savings += bucketSavings[b.key] * share;
        e.hourly += bucketCommit[b.key] * share;
        e.coveredOnDemand += bucketCovered[b.key] * share;
        bucketPlans[b.key].forEach((l) => e.plans.add(l));
      }
    }
    Object.values(byResource).forEach((e) => {
      e.savings = round2(e.savings); e.hourly = round2(e.hourly); e.coveredOnDemand = round2(e.coveredOnDemand); e.plans = [...e.plans];
    });

    // ---- Dedicated EC2 Savings Plan analysis: Compute SP vs EC2 Instance SP on the same EC2 baseline ----
    let ec2Analysis = null;
    if (ec2 && (ec2.onDemand > 0 || ec2.covered > 0)) {
      const commitOD = ec2.baseline * target;
      const computeOptions = buildOptions([{ rateKey: 'computeSP_ec2', od: commitOD }], termsOf('computeSP_ec2'));
      const instanceOptions = buildOptions([{ rateKey: 'ec2InstanceSP', od: commitOD }], termsOf('ec2InstanceSP'));
      const recPlans = plans.filter((p) => p.recommended.byBucket && p.recommended.byBucket.ec2);
      const totalEC2 = ec2.onDemand + ec2.covered;
      const optimizationCut = ec2.items.reduce((s, it) => s + (optimizationSavings.get(it.r.id) || 0), 0);
      const hasFamilyData = ec2Groups.length > 0;
      const recommendedType = ec2Groups.some((g) => g.instanceSP) ? 'mixed' : 'computeSP';

      // ---- Instance family plan: from → to for every instance, and which plan covers it ----
      const planFor = (family, region) => plans.find((p) => p.planType === 'ec2InstanceSP' && p.family === family && p.region === region)
        || plans.find((p) => p.planType === 'computeSP');
      const familyPlan = [];
      for (const it of ec2.items) {
        const r = it.r;
        if (!r.instanceType) continue;
        const t = targets.get(r.id) || {};
        const toType = t.remove ? '' : (t.to || r.instanceType);
        const fromG = awsGen(r.instanceType);
        const toG = awsGen(toType);
        const plan = t.remove || it.baseline <= 0 ? null : planFor(toG ? toG.family : '', r.region);
        const d = plan ? (plan.recommended.discountPct || 0) / 100 : 0;
        const commitOD = plan ? it.baseline * (plan.source === 'aws' ? 1 : target) : 0;
        const windows = /windows/i.test(`${r.usageType} ${r.pricingModel}`);
        familyPlan.push({
          id: r.id, region: r.region, environment: r.environment, os: windows ? 'Windows' : '',
          from: { type: r.instanceType, family: fromG ? fromG.family : '' },
          to: t.remove ? null : { type: toType, family: toG ? toG.family : '' },
          change: t.remove ? 'remove' : !t.to || t.to === r.instanceType ? 'keep' : fromG && toG && fromG.family !== toG.family ? (fromG.size !== toG.size ? 'family+size' : 'family') : 'size',
          reason: t.reason || (r.costCovered > 0 && it.od === 0 ? 'Already covered by a Savings Plan / RI' : ''),
          graviton: windows || t.remove ? '' : gravitonOf(toType),
          costNow: round2(r.cost),
          steadyAfter: round2(it.baseline),
          coveredBy: plan ? (plan.planType === 'ec2InstanceSP' ? `EC2 Instance SP · ${plan.family} in ${plan.region}` : plan.label) : t.remove ? 'Nothing (remove it)' : it.baseline <= 0 ? (r.costCovered > 0 ? 'Already covered' : 'Not covered') : '—',
          commitHourly: round2((commitOD * (1 - d)) / HOURS_PER_MONTH),
          planSavings: round2(commitOD * d),
        });
      }
      // AWS Cost Optimization Hub results when the data has no instance-level rows (e.g. connected via Cost Explorer)
      if (!familyPlan.length && opts.aws && opts.aws.optimization && Array.isArray(opts.aws.optimization.items)) {
        const cp = plans.find((p) => p.planType === 'computeSP');
        for (const h of opts.aws.optimization.items) {
          if (!/^Ec2Instance/.test(h.resourceType || '') || !awsGen(h.currentSummary)) continue;
          const toType = h.actionType === 'Stop' || h.actionType === 'Delete' ? '' : (awsGen(h.recommendedSummary) ? h.recommendedSummary : h.currentSummary);
          const fromG = awsGen(h.currentSummary); const toG = awsGen(toType);
          familyPlan.push({
            id: h.resourceId, region: h.region, environment: '', os: '',
            from: { type: h.currentSummary, family: fromG.family },
            to: toType ? { type: toType, family: toG ? toG.family : '' } : null,
            change: !toType ? 'remove' : toType === h.currentSummary ? 'keep' : fromG && toG && fromG.family !== toG.family ? 'family' : 'size',
            reason: `AWS ${h.actionType || 'recommendation'}`,
            graviton: toType ? gravitonOf(toType) : '',
            costNow: round2(h.monthlyCost || 0),
            steadyAfter: round2(Math.max(0, (h.monthlyCost || 0) - (h.monthlySavings || 0))),
            coveredBy: toType && cp ? `${cp.label} (account-wide)` : toType ? '—' : 'Nothing (remove it)',
            commitHourly: 0, planSavings: 0,
          });
        }
      }
      familyPlan.sort((a, b) => b.costNow - a.costNow);

      ec2Analysis = {
        familyPlan,
        awsFamilies: opts.aws && opts.aws.savingsPlans && okData(opts.aws.savingsPlans.EC2_INSTANCE_SP)
          ? (opts.aws.savingsPlans.EC2_INSTANCE_SP.details || []).filter((x) => x.family).map((x) => ({ family: x.family, region: x.region, hourly: x.hourly, monthlySavings: x.monthlySavings }))
          : [],
        onDemand: round2(ec2.onDemand),
        covered: round2(ec2.covered),
        spot: round2(ec2.spot),
        currentCoveragePct: totalEC2 > 0 ? round2((ec2.covered / totalEC2) * 100) : 0,
        optimizationCut: round2(optimizationCut),
        baseline: round2(ec2.baseline),
        commitOnDemand: round2(commitOD),
        projectedCoveragePct: totalEC2 > 0 ? round2(Math.min(100, ((ec2.covered + commitOD) / totalEC2) * 100)) : 0,
        hourlyCommitment: round2(bucketCommit.ec2 || 0),
        monthlySavings: round2(bucketSavings.ec2 || 0),
        plans: recPlans.map((p) => ({ label: p.label, scope: p.scope, savings: round2(p.recommended.byBucket.ec2), hourly: round2(p.recommended.byBucketCommit.ec2) })),
        recommendedType,
        hasFamilyData,
        aws: opts.aws && opts.aws.savingsPlans ? {
          computeSP: okData(opts.aws.savingsPlans.COMPUTE_SP) ? opts.aws.savingsPlans.COMPUTE_SP : null,
          ec2InstanceSP: okData(opts.aws.savingsPlans.EC2_INSTANCE_SP) ? opts.aws.savingsPlans.EC2_INSTANCE_SP : null,
        } : null,
        families: ec2Groups,
        comparison: computeOptions.map((c) => {
          const i = instanceOptions.find((x) => x.key === c.key);
          return { key: c.key, label: c.label, computeSP: c, ec2InstanceSP: i };
        }),
        guidance: [
          optimizationCut > 0
            ? `Rightsize/clean up first: ${round2(optimizationCut)}/mo of EC2 spend is already flagged for removal and is excluded from the commitment.`
            : 'Run AWS Compute Optimizer before purchasing so you do not commit to idle or oversized instances.',
          recommendedType === 'mixed'
            ? 'Buy EC2 Instance Savings Plans only for the family/region slices marked below; cover the rest with a Compute Savings Plan.'
            : hasFamilyData
              ? 'No single instance family/region holds 30%+ of steady EC2 spend, so a Compute Savings Plan is the safer choice.'
              : 'This sheet has no instance family/region detail, so a Compute Savings Plan is recommended. If most EC2 runs on one family in one region (check Cost Explorer grouped by Instance type), an EC2 Instance SP adds ~9 points of discount.',
          'Buy in stages: commit to ~70-80% of steady usage now, then top up after 1-3 months as coverage and utilization data comes in.',
          'Savings Plans apply automatically; check Savings Plans utilization (target ~100%) and coverage reports in Cost Explorer each month.',
        ],
      };
    }

    // ---- Coverage ----
    const eligibleKeys = Object.keys(buckets).filter((k) => k !== 'excluded');
    const eligibleOD = eligibleKeys.reduce((s, k) => s + buckets[k].onDemand, 0);
    const covered = eligibleKeys.reduce((s, k) => s + buckets[k].covered, 0);
    const recommendedCover = plans.reduce((s, p) => s + p.coveredOnDemand, 0);
    const denom = eligibleOD + covered;

    return {
      term, targetCoverage: target, hasSeries,
      byResource,
      ec2: ec2Analysis,
      termOptions: TERM_OPTIONS,
      plans,
      buckets: Object.values(buckets).map((b) => ({
        key: b.key, label: b.label, onDemand: round2(b.onDemand), covered: round2(b.covered), spot: round2(b.spot), baseline: round2(b.baseline),
      })).sort((a, b) => (b.onDemand + b.covered) - (a.onDemand + a.covered)),
      services: [...services.values()].map((s) => ({
        service: s.service, cost: round2(s.cost), onDemand: round2(s.onDemand), covered: round2(s.covered), bucket: s.bucket,
        eligible: s.bucket !== 'excluded', plan: s.plan,
        coveragePct: s.onDemand + s.covered > 0 ? round2((s.covered / (s.onDemand + s.covered)) * 100) : 0,
        notes: [...s.notes].join(' '),
      })).sort((a, b) => b.cost - a.cost),
      coverage: awsCoverage(opts.aws, plans) || {
        eligibleOnDemand: round2(eligibleOD),
        covered: round2(covered),
        currentPct: denom > 0 ? round2((covered / denom) * 100) : 0,
        projectedPct: denom > 0 ? round2(Math.min(100, ((covered + recommendedCover) / denom) * 100)) : 0,
      },
      awsNotes,
      source: plans.some((p) => p.source === 'aws') ? (plans.every((p) => p.source === 'aws') ? 'aws' : 'mixed') : 'estimate',
      totals: {
        hourlyCommitment: round2(plans.reduce((s, p) => s + p.recommended.hourlyCommitment, 0)),
        monthlySavings: round2(plans.reduce((s, p) => s + p.recommended.monthlySavings, 0)),
        upfront: round2(plans.reduce((s, p) => s + p.recommended.upfront, 0)),
      },
    };
  }

  return { analyzeCommitments, bucketFor, simulate, TERM_OPTIONS, RATES, PLAN_INFO };
});
