/**
 * FinOps recommendation engine.
 * Pure logic, no DOM access, so it can run in the browser or in Node for testing.
 *
 * Input:  headers (string[]) + rows (objects keyed by header)
 * Output: normalized resources, recommendations, summary, breakdowns, insights
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FinOpsEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Column detection
  // ---------------------------------------------------------------------------

  /** Known header aliases per field (normalized: lowercase, alphanumerics only). */
  const FIELD_ALIASES = {
    id: ['resourceid', 'lineitemresourceid', 'resourcename', 'resource', 'instanceid', 'instancename', 'name', 'id', 'assetid', 'arn', 'resourcearn'],
    service: ['service', 'servicename', 'product', 'productname', 'productproductname', 'lineitemproductcode', 'productservicecode', 'servicecode', 'resourcetype', 'type', 'category', 'metercategory', 'servicetype'],
    cost: ['monthlycost', 'cost', 'totalcost', 'costusd', 'monthlycostusd', 'amount', 'spend', 'monthlyspend', 'unblendedcost', 'lineitemunblendedcost', 'lineitemnetunblendedcost', 'blendedcost', 'lineitemblendedcost', 'pretaxcost', 'costinbillingcurrency', 'charges', 'totalcosts'],
    eligibleCost: ['commitmenteligiblecost', 'speligiblecost', 'eligiblecost'],
    usageType: ['usagetype', 'lineitemusagetype', 'usagetypegroup', 'meter', 'metername', 'skudescription'],
    lineItemType: ['lineitemlineitemtype', 'lineitemtype', 'chargetype', 'recordtype'],
    cpu: ['cpuutilization', 'cpu', 'avgcpu', 'cpuutil', 'cpuusage', 'averagecpu', 'avgcpuutilization', 'cpuavg'],
    memory: ['memoryutilization', 'memory', 'avgmemory', 'memutil', 'memoryusage', 'mem', 'ram', 'ramutilization', 'memutilization', 'avgmemoryutilization'],
    region: ['region', 'productregion', 'productregioncode', 'regioncode', 'location', 'zone', 'availabilityzone', 'az', 'resourcelocation'],
    environment: ['environment', 'env', 'stage'],
    owner: ['owner', 'team', 'costcenter', 'department', 'businessunit', 'ownerteam', 'owneremail'],
    tags: ['tags', 'tag', 'labels'],
    instanceType: ['instancetype', 'productinstancetype', 'size', 'vmsize', 'machinetype', 'sku', 'instancesize', 'skuname', 'nodetype', 'dbinstanceclass', 'instanceclass'],
    status: ['status', 'state', 'resourcestate', 'instancestate', 'attachmentstatus'],
    usageHours: ['usagehours', 'hours', 'runninghours', 'uptimehours', 'uptime', 'hoursrun', 'runhours'],
    pricingModel: ['pricingmodel', 'pricingterm', 'purchaseoption', 'billingtype', 'commitment', 'pricingtype', 'purchasetype', 'lifecycle', 'pricing'],
    storageType: ['storagetype', 'volumetype', 'disktype', 'storageclass', 'accesstier'],
    lastUsed: ['lastused', 'lastaccessed', 'lastactivity', 'lastaccessdate', 'lastuseddate', 'lastaccesstime'],
    created: ['createddate', 'creationdate', 'created', 'launchtime', 'launchdate', 'createdon', 'createdat'],
    // Billing period for long-format exports (one row per service/resource per month or day)
    period: ['month', 'billingmonth', 'billingperiod', 'period', 'date', 'usagedate', 'invoicemonth', 'lineitemusagestartdate', 'billbillingperiodstartdate', 'usagestartdate', 'chargeperiodstart', 'billingperiodstartdate', 'startdate', 'timeperiod'],
  };
  // Fields whose short aliases are too generic for partial matching
  const MIN_CONTAINS_LEN = { period: 12 };

  const FIELD_LABELS = {
    id: 'Resource ID / Name', service: 'Service / Type', cost: 'Monthly Cost',
    usageType: 'Usage Type', lineItemType: 'Line Item / Charge Type', cpu: 'CPU Utilization %',
    memory: 'Memory Utilization %', region: 'Region', environment: 'Environment', owner: 'Owner / Team',
    tags: 'Tags', instanceType: 'Instance Type / Size', status: 'Status / State', usageHours: 'Usage Hours (monthly)',
    pricingModel: 'Pricing Model', storageType: 'Storage / Volume Type', lastUsed: 'Last Used Date', created: 'Created Date',
    period: 'Billing Month / Date', eligibleCost: 'Commitment-Eligible Cost',
  };

  function normalizeHeader(h) {
    return String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /** Map each field to a header. Exact alias matches win over partial matches. */
  function detectColumns(headers) {
    const norm = headers.map(normalizeHeader);
    const mapping = {};
    const used = new Set();

    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      for (const alias of aliases) {
        const idx = norm.findIndex((h, i) => h === alias && !used.has(i));
        if (idx !== -1) { mapping[field] = headers[idx]; used.add(idx); break; }
      }
    }
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (mapping[field]) continue;
      for (const alias of aliases) {
        if (alias.length < (MIN_CONTAINS_LEN[field] || 4)) continue; // short aliases are too ambiguous for partial matching
        const idx = norm.findIndex((h, i) => !used.has(i) && h.includes(alias));
        if (idx !== -1) { mapping[field] = headers[idx]; used.add(idx); break; }
      }
    }
    return mapping;
  }

  // ---------------------------------------------------------------------------
  // Value parsing
  // ---------------------------------------------------------------------------

  function toNumber(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v).replace(/[^0-9.\-]/g, '');
    if (s === '' || s === '-' || s === '.') return null;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }

  // Realm-safe Date check (works for Dates created by other scripts/frames)
  const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]';

  function toText(v) {
    if (v == null) return '';
    if (isDate(v)) return isNaN(v) ? '' : `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
    return String(v).trim();
  }

  function toDate(v) {
    if (v == null || v === '') return null;
    if (isDate(v)) return isNaN(v) ? null : v;
    if (typeof v === 'number') {
      // Excel serial date (days since 1899-12-30)
      if (v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000));
      return null;
    }
    const t = Date.parse(String(v));
    return isNaN(t) ? null : new Date(t);
  }

  const DAY_MS = 86400000;
  const daysBetween = (a, b) => Math.floor((b - a) / DAY_MS);
  const round2 = (n) => Math.round(n * 100) / 100;

  // ---------------------------------------------------------------------------
  // Normalization
  // ---------------------------------------------------------------------------

  const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const pad2 = (n) => String(n).padStart(2, '0');

  /** Returns 'YYYY-MM' for anything that looks like a month/date, else null. */
  function monthKeyOf(v) {
    if (v == null || v === '') return null;
    // SheetJS creates Date cells at local midnight, so read local parts (UTC would shift 1 Sep to 31 Aug in UTC+ zones)
    if (isDate(v)) return isNaN(v) ? null : `${v.getFullYear()}-${pad2(v.getMonth() + 1)}`;
    if (typeof v === 'number') {
      const d = toDate(v); // serial dates are built in UTC
      return d ? `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}` : null;
    }
    const s = String(v).replace(/\(\s*[$€£₹]?\s*\w*\s*\)\s*$/, '').trim().toLowerCase();
    let m = /^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?(?:[t\s].*)?$/.exec(s);
    if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${pad2(m[2])}`;
    m = /^(\d{1,2})[-/](\d{4})$/.exec(s);
    if (m && +m[1] >= 1 && +m[1] <= 12) return `${m[2]}-${pad2(m[1])}`;
    m = /^([a-z]{3})[a-z]*[\s\-'.,]*(\d{2}|\d{4})$/.exec(s);
    if (m && MONTH_NAMES.includes(m[1])) return `${m[2].length === 2 ? `20${m[2]}` : m[2]}-${pad2(MONTH_NAMES.indexOf(m[1]) + 1)}`;
    m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s); // MM/DD/YYYY or DD/MM/YYYY
    if (m) { const mm = +m[1] > 12 ? +m[2] : +m[1]; if (mm >= 1 && mm <= 12) return `${m[3]}-${pad2(mm)}`; }
    return null;
  }

  function isMonthHeader(h) {
    return monthKeyOf(h) != null && !/cost|spend|total|usage|created|launch|last/i.test(String(h));
  }

  const SUMMARY_ROW = /^(grand\s*)?total$|^service\s*total$|^total\s*costs?\b|^sum$/i;
  // CUR line item types that are not usage (fees, credits, SP/RI accounting entries)
  const SKIP_LINE_TYPES = /credit|refund|negation|recurringfee|upfrontfee|rifee|^fee$|discount|edp|bundleddiscount|privaterate/i;
  const COVERED = /reserved|savings\s*plan|savingsplan|commit|\bri\b|\bcud\b|discountedusage|savingsplancoveredusage/i;

  /**
   * Cost Explorer "wide" export (months as rows, services as "Name($)" columns) → services as rows, months as columns.
   * Other layouts are returned unchanged.
   */
  function prepare(headers, rows) {
    const moneyCols = headers.filter((h) => /\(\s*[$€£₹]|\(\s*usd\s*\)/i.test(h));
    if (moneyCols.length < 2 || moneyCols.length < headers.length - 2) return { headers, rows, reshaped: false };

    const first = headers[0];
    const serviceCols = moneyCols.filter((h) => !/^total\s*cost/i.test(h));
    const dateRows = rows.filter((r) => monthKeyOf(r[first]));
    const totalRow = rows.find((r) => /total/i.test(String(r[first] || '')));
    const months = [...new Set(dateRows.map((r) => monthKeyOf(r[first])))].sort();

    const newHeaders = ['Service', ...(months.length ? months : ['Monthly Cost'])];
    const newRows = serviceCols.map((c) => {
      const o = { Service: c.replace(/\(\s*[^)]*\)\s*$/, '').trim() };
      if (months.length) {
        months.forEach((m) => { o[m] = 0; });
        dateRows.forEach((r) => { o[monthKeyOf(r[first])] += toNumber(r[c]) || 0; });
      } else {
        o['Monthly Cost'] = totalRow ? toNumber(totalRow[c]) : null;
      }
      return o;
    });
    return { headers: newHeaders, rows: newRows, reshaped: true };
  }

  function normalizeRows(rows, mapping, monthCols, now) {
    const get = (row, field) => (mapping[field] ? row[mapping[field]] : null);
    const list = [];

    rows.forEach((row, i) => {
      const lineType = toText(get(row, 'lineItemType'));
      if (lineType && SKIP_LINE_TYPES.test(lineType)) return;

      const service = toText(get(row, 'service'));
      const instanceType = toText(get(row, 'instanceType'));
      const usageType = toText(get(row, 'usageType'));
      const region = toText(get(row, 'region'));
      const environment = toText(get(row, 'environment'));
      const rawId = toText(get(row, 'id'));
      const synthetic = !rawId;
      const id = rawId || [service, instanceType, usageType, region, environment].filter(Boolean).join(' · ') || `Row ${i + 2}`;

      if (SUMMARY_ROW.test(rawId) || SUMMARY_ROW.test(service)) return;

      // Cost entries per month ('_' = no period information)
      let entries;
      if (monthCols.length) entries = monthCols.map((h) => [monthKeyOf(h), toNumber(row[h])]);
      else if (mapping.period) entries = [[monthKeyOf(get(row, 'period')) || '_', toNumber(get(row, 'cost'))]];
      else entries = [['_', toNumber(get(row, 'cost'))]];
      entries = entries.filter(([, v]) => v != null && v >= 0);
      if (!entries.length && !service && !instanceType) return;

      const pricingModel = toText(get(row, 'pricingModel'));
      const covered = COVERED.test(lineType) || COVERED.test(pricingModel);
      const spot = /spot/i.test(pricingModel) || /spot/i.test(usageType);
      const byMonth = {};
      for (const [m, v] of entries) {
        const b = byMonth[m] || (byMonth[m] = { cost: 0, od: 0, cov: 0, spot: 0 });
        b.cost += v;
        if (covered) b.cov += v; else if (spot) b.spot += v; else b.od += v;
      }

      const eligible = toNumber(get(row, 'eligibleCost'));
      list.push({
        id, _synthId: synthetic, _byMonth: byMonth,
        _rowCost: entries.reduce((s, [, v]) => s + v, 0),
        eligibleCost: eligible,
        service, instanceType, usageType, region, environment, pricingModel,
        cpu: toNumber(get(row, 'cpu')),
        memory: toNumber(get(row, 'memory')),
        owner: toText(get(row, 'owner')),
        tags: toText(get(row, 'tags')),
        status: toText(get(row, 'status')),
        usageHours: toNumber(get(row, 'usageHours')),
        storageType: toText(get(row, 'storageType')),
        lastUsed: toDate(get(row, 'lastUsed')),
        created: toDate(get(row, 'created')),
      });
    });

    // Utilization given as fractions (0-1) instead of percentages
    ['cpu', 'memory'].forEach((k) => {
      const vals = list.map((r) => r[k]).filter((v) => v != null);
      if (vals.length && Math.max(...vals) <= 1) list.forEach((r) => { if (r[k] != null) r[k] *= 100; });
    });

    return finalizeMonths(aggregateById(list), now);
  }

  /** Billing exports often have multiple line items per resource; merge them. */
  function aggregateById(list) {
    const map = new Map();
    for (const r of list) {
      const existing = map.get(r.id);
      if (!existing) { map.set(r.id, Object.assign({ _cpuN: r.cpu != null ? 1 : 0, _memN: r.memory != null ? 1 : 0 }, r)); continue; }
      for (const [m, b] of Object.entries(r._byMonth)) {
        const e = existing._byMonth[m] || (existing._byMonth[m] = { cost: 0, od: 0, cov: 0, spot: 0 });
        e.cost += b.cost; e.od += b.od; e.cov += b.cov; e.spot += b.spot;
      }
      if (r.cpu != null) { existing.cpu = ((existing.cpu || 0) * existing._cpuN + r.cpu) / (existing._cpuN + 1); existing._cpuN++; }
      if (r.memory != null) { existing.memory = ((existing.memory || 0) * existing._memN + r.memory) / (existing._memN + 1); existing._memN++; }
      if (r.usageHours != null) existing.usageHours = Math.max(existing.usageHours || 0, r.usageHours);
      existing._rowCost += r._rowCost;
      if (r.eligibleCost != null) existing.eligibleCost = (existing.eligibleCost || 0) + r.eligibleCost;
      for (const k of ['service', 'region', 'environment', 'owner', 'tags', 'instanceType', 'usageType', 'status', 'pricingModel', 'storageType']) {
        if (!existing[k] && r[k]) existing[k] = r[k];
      }
      if (r.lastUsed && (!existing.lastUsed || r.lastUsed > existing.lastUsed)) existing.lastUsed = r.lastUsed;
      if (r.created && (!existing.created || r.created < existing.created)) existing.created = r.created;
    }
    return [...map.values()].map((r) => { delete r._cpuN; delete r._memN; return r; });
  }

  /**
   * Turn per-month buckets into the analysis month (latest full month) plus a monthly series.
   * The current calendar month is treated as partial (month-to-date) and ignored when older months exist.
   */
  function finalizeMonths(resources, now) {
    let months = [...new Set(resources.flatMap((r) => Object.keys(r._byMonth)).filter((m) => m !== '_'))].sort();
    let droppedPartial = null;
    const currentMonth = now ? `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}` : null;
    if (months.length >= 2 && months[months.length - 1] === currentMonth) droppedPartial = months.pop();
    const latest = months[months.length - 1];

    const out = [];
    for (const r of resources) {
      const bm = r._byMonth;
      const pick = (b) => b || { cost: 0, od: 0, cov: 0, spot: 0 };
      let cur;
      if (latest) {
        // Rows without a period (e.g. inventory rows mixed in) still count
        const a = pick(bm[latest]); const u = pick(bm._);
        cur = { cost: a.cost + u.cost, od: a.od + u.od, cov: a.cov + u.cov, spot: a.spot + u.spot };
        r.monthly = months.map((m) => round2(pick(bm[m]).cost));
      } else {
        cur = pick(bm._);
        r.monthly = null;
      }
      delete r._byMonth;
      // Share of cost that commitments can cover (e.g. Lambda duration, DynamoDB throughput), from line-item detail
      r.eligibleShare = r.eligibleCost != null && r._rowCost > 0 ? Math.max(0, Math.min(1, r.eligibleCost / r._rowCost)) : null;
      delete r._rowCost; delete r.eligibleCost;
      if (latest && cur.cost <= 0) continue; // resource no longer billed in the latest month
      r.cost = round2(cur.cost);
      r.costOD = round2(cur.od);
      r.costCovered = round2(cur.cov);
      r.costSpot = round2(cur.spot);
      out.push(r);
    }
    return { resources: out, months, latestMonth: latest || null, droppedPartial };
  }

  // ---------------------------------------------------------------------------
  // Classification helpers
  // ---------------------------------------------------------------------------

  function classify(r) {
    const t = `${r.service} ${r.instanceType} ${r.storageType} ${r.usageType || ''}`.toLowerCase();
    if (/elastic\s*ip|public\s*ip|\beip\b|ip\s*address|idleaddress/.test(t)) return 'ip';
    if (/ec2[\s-]*other/.test(t)) return 'ec2Other';
    if (/simple\s*storage\s*service|amazons3/.test(t)) return 'objectStorage';
    if (/snapshot/.test(t)) return 'snapshot';
    if (/load\s*balancer|\belb\b|\balb\b|\bnlb\b|application gateway/.test(t)) return 'loadBalancer';
    if (/^db\./.test(r.instanceType.toLowerCase()) || /\brds\b|database|\bsql\b|aurora|cosmos|dynamo|\bdb\b|redshift|elasticache|redis|bigquery/.test(t)) return 'database';
    if (/\bebs\b|volume|managed\s*disk|\bdisk\b|persistent\s*disk|\bgp[23]\b|\bio[12]\b/.test(t)) return 'volume';
    if (/\bs3\b|blob|object\s*storage|cloud\s*storage|bucket|\bgcs\b/.test(t)) return 'objectStorage';
    if (/lambda|fargate|sagemaker|cloudwatch|cloudfront|nat\s*gateway|data\s*transfer/.test(t)) return 'other';
    if (/ec2|elastic\s*compute|compute|virtual\s*machine|\bvms?\b|instance|server|\bgce\b|kubernetes|\beks\b|\baks\b|\bgke\b|node|app\s*service|boxusage/.test(t)) return 'compute';
    if (r.instanceType) return 'compute';
    return 'other';
  }

  const isNonProd = (env) => /\b(dev|development|test|testing|qa|stag|staging|sandbox|uat|demo|poc|non-?prod|lab)\b/i.test(env);
  const isProd = (env) => /\bprod(uction)?\b/i.test(env) && !isNonProd(env);

  const AWS_SIZES = ['nano', 'micro', 'small', 'medium', 'large', 'xlarge', '2xlarge', '4xlarge', '8xlarge', '12xlarge', '16xlarge', '24xlarge', '32xlarge', '48xlarge'];
  const AWS_OLD_GEN = { t1: 't3', t2: 't3', m1: 'm6i', m2: 'r6i', m3: 'm6i', m4: 'm6i', c1: 'c6i', c3: 'c6i', c4: 'c6i', r3: 'r6i', r4: 'r6i', i2: 'i4i', i3: 'i4i', d2: 'd3', g2: 'g5', g3: 'g5', p2: 'p3', x1: 'x2idn' };

  function parseAwsType(type) {
    const m = /^(db\.|cache\.)?([a-z]+)(\d+)([a-z-]*)\.(\w+)$/i.exec(type.trim());
    if (!m) return null;
    return { prefix: m[1] || '', family: m[2].toLowerCase(), gen: m[3], attrs: m[4].toLowerCase(), size: m[5].toLowerCase() };
  }

  /** Suggest one size smaller across AWS / Azure / GCP naming styles. */
  function smallerSize(type) {
    if (!type) return null;
    const aws = parseAwsType(type);
    if (aws) {
      const i = AWS_SIZES.indexOf(aws.size);
      if (i > 0) return `${aws.prefix}${aws.family}${aws.gen}${aws.attrs}.${AWS_SIZES[i - 1]}`;
      return null;
    }
    const az = /^(standard_[a-z]+)(\d+)(.*)$/i.exec(type);
    if (az) { const n = parseInt(az[2], 10); if (n >= 2 && n % 2 === 0) return `${az[1]}${n / 2}${az[3]}`; return null; }
    const gcp = /^(.+-)(\d+)$/.exec(type);
    if (gcp) { const n = parseInt(gcp[2], 10); if (n >= 2 && n % 2 === 0) return `${gcp[1]}${n / 2}`; }
    return null;
  }

  /** Returns a suggested modern replacement for previous-generation types, or null. */
  function modernType(type) {
    if (!type) return null;
    const aws = parseAwsType(type);
    if (aws) {
      const key = `${aws.family}${aws.gen}`;
      if (AWS_OLD_GEN[key]) return `${aws.prefix}${AWS_OLD_GEN[key]}.${aws.size}`;
      return null;
    }
    if (/^standard_[a-z]+\d+[a-z]*(_v[12])?$/i.test(type) && !/_v[3-9]$/i.test(type)) {
      return type.replace(/(_v[12])?$/i, '_v5');
    }
    if (/^n1-/i.test(type)) return type.replace(/^n1-/i, 'n2-');
    return null;
  }

  function gravitonHint(type) {
    const aws = parseAwsType(type || '');
    if (aws && ['m', 'c', 'r', 't'].includes(aws.family) && !aws.attrs.includes('g')) {
      return ` For Linux workloads, Graviton (${aws.family}7g / ${aws.family}${aws.family === 't' ? '4' : '7'}g) typically costs ~20% less for similar performance.`;
    }
    return '';
  }

  // ---------------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------------

  const DEFAULTS = {
    idleCpu: 5,          // % avg CPU below which a resource is considered idle
    rightsizeCpu: 40,    // % avg CPU below which rightsizing is suggested
    staleDays: 90,       // days since last use before suggesting decommission
    snapshotDays: 180,   // snapshot age before suggesting cleanup
    steadyHours: 500,    // monthly hours above which a commitment makes sense (~70% of 730)
  };

  /**
   * Advice for service-level rows (Cost Explorer "group by service" exports), matched on the service name.
   * savingsPct values are conservative, typical outcomes, not guarantees.
   * Commitment discounts (Savings Plans / RIs) are handled separately in commitments.js.
   */
  const SERVICE_RULES = [
    { match: /dynamodb/, minCost: 50, category: 'Rightsizing', priority: 'High', effort: 'Medium', savingsPct: 0.15,
      title: 'Optimize DynamoDB capacity mode and table class',
      detail: 'Tables with steady, predictable traffic are usually cheaper on provisioned capacity with auto scaling than on-demand. Move rarely read tables to the Standard-IA table class (~60% cheaper storage), set TTL to expire old items, and drop unused GSIs. Remaining steady usage is covered by the Database Savings Plan below.' },
    { match: /secrets\s*manager/, minCost: 20, category: 'Waste Elimination', priority: 'High', effort: 'Low', savingsPct: 0.4,
      title: 'Cut Secrets Manager API calls and unused secrets',
      detail: 'You pay per secret per month plus per 10,000 API calls. High bills usually come from apps fetching secrets on every request. Use the Secrets Manager caching libraries or the Lambda Parameters & Secrets extension, delete secrets nobody reads, and keep non-rotating config in SSM Parameter Store standard parameters (no charge).' },
    { match: /lambda/, minCost: 20, category: 'Modernization', priority: 'Medium', effort: 'Low', savingsPct: 0.15,
      title: 'Move Lambda to arm64 and right-size memory',
      detail: 'arm64 (Graviton) Lambda is ~20% cheaper per GB-second. Use AWS Lambda Power Tuning to find the cheapest memory setting, cut timeouts and retries, and batch SQS/Kinesis events. Steady Lambda usage is also included in the Compute Savings Plan below.' },
    { match: /ec2[\s-]*instances|elastic\s*compute\s*cloud(?![\s-]*other)/, minCost: 20, category: 'Rightsizing', priority: 'Medium', effort: 'Medium', savingsPct: 0.15,
      title: 'Rightsize EC2 with Compute Optimizer, Graviton and Spot',
      detail: 'Enable AWS Compute Optimizer (free) to find over-provisioned and idle instances, stop dev/test instances out of hours, move Linux workloads to Graviton (~20% cheaper) and use Spot for fault-tolerant jobs. Do this before buying the Compute Savings Plan below so you do not commit to waste.' },
    { match: /ec2[\s-]*other/, minCost: 20, category: 'Storage Optimization', priority: 'Medium', effort: 'Low', savingsPct: 0.2,
      title: 'Reduce EC2-Other (EBS, snapshots, NAT, public IPs)',
      detail: 'EC2-Other is not covered by Savings Plans. Migrate gp2 → gp3 (~20% cheaper), delete unattached volumes and old snapshots, release idle public IPv4 addresses, and use free S3/DynamoDB gateway endpoints instead of NAT Gateway for that traffic.' },
    { match: /nat\s*gateway|data\s*transfer/, minCost: 50, category: 'Waste Elimination', priority: 'Medium', effort: 'Medium', savingsPct: 0.1,
      title: 'Cut NAT Gateway and data-transfer charges',
      detail: 'Add free S3/DynamoDB gateway endpoints, keep chatty services in the same AZ, and serve public content through CloudFront to reduce internet egress.' },
    { match: /cloudwatch/, minCost: 20, category: 'Waste Elimination', priority: 'Medium', effort: 'Low', savingsPct: 0.25,
      title: 'Set CloudWatch log retention and trim metrics',
      detail: 'Log groups default to "never expire". Set retention (e.g. 30-90 days), use the Infrequent Access log class for logs you rarely query, lower Lambda/app log levels in production, and remove unused custom metrics, alarms and dashboards.' },
    { match: /cloudfront/, minCost: 50, category: 'Commitment Discounts', priority: 'Medium', effort: 'Low', savingsPct: 0.2,
      title: 'Use the CloudFront Security Savings Bundle and improve caching',
      detail: 'CloudFront is not covered by Savings Plans. The CloudFront Security Savings Bundle gives up to 30% off CloudFront for a 1-year monthly commitment and includes AWS WAF credit. Raise cache-hit ratio (longer TTLs, fewer cache-key headers/cookies) and enable compression.' },
    { match: /\bbackup\b/, minCost: 20, category: 'Storage Optimization', priority: 'Medium', effort: 'Low', savingsPct: 0.3,
      title: 'Tune AWS Backup retention and cold storage',
      detail: 'Review backup plans: shorten retention where policy allows, transition long-term recovery points to cold storage, avoid daily backups of non-production, and delete recovery points of resources that no longer exist.' },
    { match: /api\s*gateway/, minCost: 20, category: 'Modernization', priority: 'Medium', effort: 'Medium', savingsPct: 0.3,
      title: 'Move REST APIs to HTTP APIs where possible',
      detail: 'API Gateway HTTP APIs cost roughly 70% less per request than REST APIs. Migrate APIs that do not need REST-only features (usage plans, request validation, edge caching), and disable API caching clusters that are not needed.' },
    { match: /\bses\b|simple\s*email/, minCost: 50, category: 'Waste Elimination', priority: 'Low', effort: 'Low', savingsPct: 0.1,
      title: 'Review SES dedicated IPs and sending volume',
      detail: 'Dedicated IPs and Virtual Deliverability Manager add fixed monthly fees. Use shared IPs if volume is low, keep the suppression list on to avoid paying for bounces, and remove duplicate notification emails.' },
    { match: /\bwaf\b/, minCost: 20, category: 'Waste Elimination', priority: 'Low', effort: 'Low', savingsPct: 0.2,
      title: 'Consolidate AWS WAF web ACLs and rules',
      detail: 'WAF bills per web ACL and per rule each month, plus requests. Share one web ACL across resources where possible, remove unused rules and rule groups, and check whether the CloudFront Security Savings Bundle can cover WAF usage.' },
    { match: /\bs3\b|simple\s*storage\s*service/, minCost: 20, category: 'Storage Optimization', priority: 'Low', effort: 'Low', savingsPct: 0.15,
      title: 'Add S3 lifecycle rules and Intelligent-Tiering',
      detail: 'Enable S3 Intelligent-Tiering for data with unknown access patterns, expire old object versions, abort incomplete multipart uploads after 7 days, and use S3 Storage Lens to find the largest buckets.' },
    { match: /quicksight/, minCost: 50, category: 'Waste Elimination', priority: 'Low', effort: 'Low', savingsPct: 0.2,
      title: 'Remove inactive QuickSight users',
      detail: 'Remove authors and readers who have not logged in recently and review SPICE capacity you are not using.' },
    { match: /\bvpc\b|virtual\s*private\s*cloud|public\s*ipv4/, minCost: 5, category: 'Waste Elimination', priority: 'Low', effort: 'Low', savingsPct: 0.5,
      title: 'Release unused public IPv4 addresses',
      detail: 'VPC charges are often public IPv4 addresses (~3.65/month each, attached or not) and idle VPC endpoints. Release unused Elastic IPs, put instances behind a load balancer or NAT, and remove interface endpoints with no traffic.' },
    { match: /cloudtrail/, minCost: 20, category: 'Waste Elimination', priority: 'Low', effort: 'Low', savingsPct: 0.3,
      title: 'Remove duplicate CloudTrail trails',
      detail: 'The first copy of management events is free. Additional trails that log the same events, and data events on busy buckets, are charged. Keep one organization trail and scope data events tightly.' },
    { match: /key\s*management|\bkms\b/, minCost: 20, category: 'Waste Elimination', priority: 'Low', effort: 'Low', savingsPct: 0.3,
      title: 'Enable S3 Bucket Keys to cut KMS requests',
      detail: 'S3 Bucket Keys reduce KMS request costs for SSE-KMS buckets by up to 99%. Also schedule deletion of unused customer-managed keys.' },
    { match: /\bglue\b/, minCost: 50, category: 'Rightsizing', priority: 'Low', effort: 'Low', savingsPct: 0.2,
      title: 'Use Glue Flex execution and auto scaling',
      detail: 'Flex execution runs non-urgent jobs on spare capacity at a lower DPU rate. Turn on auto scaling and lower worker counts for small jobs, and stop idle interactive sessions.' },
    { match: /relational\s*database|\brds\b|aurora/, minCost: 100, category: 'Rightsizing', priority: 'Medium', effort: 'Medium', savingsPct: 0.1,
      title: 'Rightsize RDS and move to Graviton / gp3',
      detail: 'Use Performance Insights and Compute Optimizer to downsize idle databases, move to Graviton (r7g/m7g) instances, migrate gp2 storage to gp3 and stop non-production databases out of hours.' },
    { match: /elastic\s*container\s*service|\becs\b|fargate|elastic\s*kubernetes|\beks\b/, minCost: 50, category: 'Rightsizing', priority: 'Medium', effort: 'Medium', savingsPct: 0.15,
      title: 'Right-size containers and use Fargate Spot / Graviton',
      detail: 'Match task/pod CPU and memory to real usage, use Fargate Spot (up to 70% off) for interruption-tolerant tasks, run on ARM64, and upgrade EKS clusters before they enter paid extended support.' },
    { match: /sagemaker/, minCost: 50, category: 'Waste Elimination', priority: 'Medium', effort: 'Low', savingsPct: 0.15,
      title: 'Stop idle SageMaker notebooks and endpoints',
      detail: 'Enable idle auto-shutdown for Studio and notebook instances, delete unused endpoints, and use Serverless or asynchronous inference for spiky traffic.' },
    { match: /redshift/, minCost: 100, category: 'Scheduling', priority: 'Medium', effort: 'Low', savingsPct: 0.1,
      title: 'Pause idle Redshift clusters',
      detail: 'Pause/resume dev and reporting clusters on a schedule, or move spiky workloads to Redshift Serverless.' },
    { match: /elasticache|opensearch|elasticsearch/, minCost: 100, category: 'Modernization', priority: 'Low', effort: 'Medium', savingsPct: 0.1,
      title: 'Move cache/search clusters to Graviton and right-size nodes',
      detail: 'Graviton node types are typically 5-20% cheaper. For OpenSearch, move older indices to UltraWarm or cold storage.' },
  ];

  function buildRecommendations(r, opts, ctx) {
    const recs = [];
    const kind = classify(r);
    const status = r.status.toLowerCase();
    const env = r.environment;
    const nonProd = isNonProd(env);
    const pricing = r.pricingModel.toLowerCase();
    const isComputeLike = kind === 'compute' || kind === 'database';
    const isStopped = /stopped|deallocated|stopping|shut\s*down|suspended|paused/.test(status);
    const now = opts.now;

    const add = (rec) => recs.push(rec);

    // ---- Terminal rules: if any match, the resource should go away entirely ----
    const orphan = /unattached|detached|orphan|unused|not\s*in\s*use|unassociated|unassigned|\bidle\b/.test(status)
      || (status === 'available' && (kind === 'volume' || kind === 'ip'));

    if (orphan) {
      add({
        category: 'Waste Elimination', priority: 'High', effort: 'Low', savingsPct: 1,
        title: kind === 'ip' ? 'Release unassociated IP address' : kind === 'volume' ? 'Delete unattached volume' : 'Remove unused resource',
        detail: `Status is "${r.status}". It is billed without serving any workload.${kind === 'volume' ? ' Take a final snapshot if the data may be needed, then delete the volume.' : ''}`,
      });
      return recs;
    }

    if (isStopped && isComputeLike) {
      add({
        category: 'Waste Elimination', priority: 'Medium', effort: 'Low', savingsPct: 0.8,
        title: 'Terminate long-stopped resource',
        detail: `Resource is "${r.status}" but still incurs charges for attached storage, IPs or licences. If it is no longer needed, snapshot the disks and terminate it.`,
      });
      return recs;
    }

    if (r.lastUsed && now) {
      const days = daysBetween(r.lastUsed, now);
      if (days >= opts.staleDays) {
        const archive = kind === 'objectStorage' || kind === 'snapshot';
        add({
          category: 'Waste Elimination', priority: 'High', effort: archive ? 'Low' : 'Medium', savingsPct: archive ? 0.7 : 0.9,
          title: archive ? 'Move stale data to archive tier' : 'Decommission stale resource',
          detail: `Not used for ${days} days. ${archive ? 'Move to an archive tier (S3 Glacier / Azure Archive / GCS Archive) or delete it.' : 'Confirm with the owner and decommission it, keeping a backup if required.'}`,
        });
        return recs;
      }
    }

    if (kind === 'snapshot' && r.created && now) {
      const age = daysBetween(r.created, now);
      if (age >= opts.snapshotDays) {
        add({
          category: 'Waste Elimination', priority: 'Medium', effort: 'Low', savingsPct: 1,
          title: 'Delete old snapshot',
          detail: `Snapshot is ${age} days old. Apply a retention policy (e.g. AWS Data Lifecycle Manager) and remove snapshots outside it.`,
        });
        return recs;
      }
    }

    if ((isComputeLike || r.instanceType) && r.cpu != null && r.cpu < opts.idleCpu && (r.memory == null || r.memory < 20)) {
      add({
        category: 'Waste Elimination', priority: 'High', effort: 'Low', savingsPct: 0.9,
        title: 'Stop or terminate idle resource',
        detail: `Avg CPU is ${r.cpu.toFixed(1)}%${r.memory != null ? ` and memory is ${r.memory.toFixed(1)}%` : ''}. It is effectively idle. Stop it, or terminate it if no one claims it.`,
      });
      return recs;
    }

    // ---- Optimization rules (stackable) ----

    // Rightsizing
    if (isComputeLike && r.cpu != null && r.cpu < opts.rightsizeCpu && (r.memory == null || r.memory < 60)) {
      // If the type is also previous-gen, suggest the smaller size on the modern family directly
      const target = smallerSize(modernType(r.instanceType) || r.instanceType);
      const strong = r.cpu < 25;
      add({
        category: 'Rightsizing', priority: strong ? 'High' : 'Medium', effort: 'Medium', savingsPct: strong ? 0.5 : 0.3,
        title: target ? `Rightsize ${r.instanceType} → ${target}` : 'Rightsize to a smaller instance',
        detail: `Avg CPU is ${r.cpu.toFixed(1)}%${r.memory != null ? `, memory ${r.memory.toFixed(1)}%` : ''}. ${strong ? 'One size smaller should comfortably fit this workload.' : 'Validate peak usage, then move to a smaller or burstable size.'}`,
      });
    }

    // Workload / family mismatch
    if (isComputeLike && r.memory != null && r.cpu != null && r.memory < 30 && r.cpu >= 40) {
      add({
        category: 'Rightsizing', priority: 'Low', effort: 'Medium', savingsPct: 0.1,
        title: 'Switch to a compute-optimized family',
        detail: `CPU is ${r.cpu.toFixed(1)}% while memory is only ${r.memory.toFixed(1)}%. A compute-optimized family (e.g. AWS C-series, Azure F-series) gives the same vCPUs for less.`,
      });
    }

    // Scheduling non-production
    if (isComputeLike && nonProd && (r.usageHours == null || r.usageHours > 360)) {
      add({
        category: 'Scheduling', priority: 'High', effort: 'Low', savingsPct: 0.6,
        title: 'Schedule non-production off-hours',
        detail: `"${env}" resource ${r.usageHours != null ? `runs ${Math.round(r.usageHours)} hrs/month` : 'appears to run 24/7'}. Running 12h × 5 days cuts runtime by ~64% (AWS Instance Scheduler, Azure Automation, GCP schedules). For stateless dev workloads, Spot/preemptible can save up to 70-90%.`,
      });
    }

    // Commitment discounts (Savings Plans / RIs) are sized at portfolio level in commitments.js,
    // after these per-resource savings are removed, so they are not added here.

    // ---- Service-level rules: rows that are service totals rather than individual resources ----
    const aggregate = r._synthId && r.cpu == null;
    const svcText = `${r.service} ${r.usageType}`.toLowerCase();
    if (aggregate && !ctx.serviceDone.has(r.service)) {
      ctx.serviceDone.add(r.service); // service advice once per service, even if it has several rows
      // Line-item detail (e.g. from a PDF bill) gives precise, usage-type based advice
      const items = ctx.lineItemsByService.get(r.service);
      const LR = getLineRules();
      const lineRecs = items && items.length && LR ? LR.run(r.service, items, ctx) : [];
      if (lineRecs.length) {
        lineRecs.forEach(add);
      } else {
        // First matching rule only, so one service never gets overlapping advice
        const rule = SERVICE_RULES.find((x) => x.match.test(svcText));
        if (rule && r.cost >= rule.minCost) {
          add({ category: rule.category, priority: rule.priority, effort: rule.effort, savingsPct: rule.savingsPct, title: rule.title, detail: rule.detail });
        }
      }
    }

    // Modernization
    const modern = modernType(r.instanceType);
    if (modern) {
      add({
        category: 'Modernization', priority: 'Medium', effort: 'Medium', savingsPct: 0.1,
        title: `Upgrade previous-gen ${r.instanceType} → ${modern}`,
        detail: `Older generations cost more per unit of performance. Newer types are usually 10-20% cheaper for the same capacity.${gravitonHint(modern)}`,
      });
    } else if (kind === 'compute' && gravitonHint(r.instanceType) && !/windows/i.test(`${r.usageType} ${r.pricingModel}`)) {
      // Only hint, no savings counted, to keep estimates conservative
      add({
        category: 'Modernization', priority: 'Low', effort: 'High', savingsPct: 0,
        title: 'Evaluate ARM-based (Graviton) instances',
        detail: gravitonHint(r.instanceType).trim(),
      });
    }

    // Storage optimization
    const storageText = `${r.storageType} ${r.instanceType} ${r.service}`.toLowerCase();
    if (/\bgp2\b/.test(storageText)) {
      add({
        category: 'Storage Optimization', priority: 'Medium', effort: 'Low', savingsPct: 0.2,
        title: 'Migrate gp2 volume to gp3',
        detail: 'gp3 is ~20% cheaper than gp2 with a 3,000 IOPS baseline. Migration is online with no downtime.',
      });
    } else if (/\bio1\b/.test(storageText)) {
      add({
        category: 'Storage Optimization', priority: 'Low', effort: 'Medium', savingsPct: 0.25,
        title: 'Evaluate io1 → gp3 / io2',
        detail: 'If provisioned IOPS stay below 16,000, gp3 is significantly cheaper. Otherwise io2 offers better durability at the same price.',
      });
    } else if (kind === 'volume' && /premium/.test(storageText) && nonProd) {
      add({
        category: 'Storage Optimization', priority: 'Medium', effort: 'Low', savingsPct: 0.4,
        title: 'Use standard SSD for non-production disk',
        detail: `Premium disks in "${env}" are rarely justified. Standard SSD costs roughly 40-50% less.`,
      });
    }

    if (kind === 'objectStorage' && (!r.storageType || /standard|hot/i.test(r.storageType))) {
      const days = r.lastUsed && now ? daysBetween(r.lastUsed, now) : null;
      if (days != null && days >= 30) {
        add({
          category: 'Storage Optimization', priority: 'Medium', effort: 'Low', savingsPct: 0.4,
          title: 'Move infrequently accessed data to a cooler tier',
          detail: `Last accessed ${days} days ago. Infrequent-access / Cool tiers cost ~40-50% less. Add a lifecycle rule.`,
        });
      } else if (r.cost >= 100 && !aggregate) { // service totals get the S3 rule from SERVICE_RULES
        add({
          category: 'Storage Optimization', priority: 'Low', effort: 'Low', savingsPct: 0.15,
          title: 'Enable Intelligent-Tiering / lifecycle policies',
          detail: 'Automatic tiering moves cold objects to cheaper classes with no retrieval fees for frequent access.',
        });
      }
    }

    // Governance (no direct savings)
    if (ctx.hasOwnershipColumns && !r.owner && !r.tags) {
      add({
        category: 'Governance', priority: 'Low', effort: 'Low', savingsPct: 0,
        title: 'Add owner / cost-allocation tags',
        detail: 'Untagged resources cannot be charged back and are the first to become orphaned. Enforce tagging with AWS Tag Policies, Azure Policy or GCP Org Policy.',
      });
    }

    return recs;
  }

  // ---------------------------------------------------------------------------
  // Aggregations
  // ---------------------------------------------------------------------------

  function groupSum(resources, key) {
    const m = new Map();
    for (const r of resources) {
      const k = r[key] || 'Unspecified';
      m.set(k, (m.get(k) || 0) + r.cost);
    }
    return [...m.entries()].map(([label, value]) => ({ label, value: round2(value) })).sort((a, b) => b.value - a.value);
  }

  const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);

  function buildInsights(resources, recs, mapping, totalCost, totalSavings, commitments, period) {
    const insights = [];
    const fmtPct = (n) => `${n.toFixed(1)}%`;

    if (resources.length >= 5) {
      const top5 = [...resources].sort((a, b) => b.cost - a.cost).slice(0, 5).reduce((s, r) => s + r.cost, 0);
      insights.push({ level: 'info', text: `Top 5 ${mapping.id ? 'resources' : 'services'} account for ${fmtPct(pct(top5, totalCost))} of spend. Review these first for the biggest impact.` });
    }

    if (mapping.service) {
      const svc = groupSum(resources, 'service')[0];
      if (svc) insights.push({ level: 'info', text: `${svc.label} is the largest cost driver at ${fmtPct(pct(svc.value, totalCost))} of total spend.` });
    }

    if (mapping.environment) {
      const np = resources.filter((r) => isNonProd(r.environment)).reduce((s, r) => s + r.cost, 0);
      const share = pct(np, totalCost);
      insights.push({
        level: share > 30 ? 'warn' : 'info',
        text: `Non-production environments make up ${fmtPct(share)} of spend.${share > 30 ? ' That is high. A typical target is under 25-30%.' : ''}`,
      });
    }

    if (mapping.owner || mapping.tags) {
      const untagged = resources.filter((r) => !r.owner && !r.tags).reduce((s, r) => s + r.cost, 0);
      const share = pct(untagged, totalCost);
      if (share > 0) insights.push({ level: share > 10 ? 'warn' : 'info', text: `${fmtPct(share)} of spend has no owner or tags, so it cannot be allocated to a team.` });
    } else {
      insights.push({ level: 'warn', text: 'No owner/team or tags column found. Add one to enable cost allocation and accountability.' });
    }

    if (commitments && commitments.coverage.eligibleOnDemand + commitments.coverage.covered > 0) {
      const c = commitments.coverage;
      insights.push({
        level: c.currentPct < 60 ? 'warn' : 'good',
        text: `Savings Plan / RI coverage of eligible spend is ${fmtPct(c.currentPct)}${commitments.plans.length ? `, rising to ~${fmtPct(c.projectedPct)} with the recommended plans` : ''}. Mature FinOps teams usually target 70-80%.`,
      });
    }
    if (!mapping.pricingModel && !mapping.lineItemType) {
      const recommendsPlans = commitments && commitments.plans.some((p) => p.recommended && p.recommended.monthlySavings > 0 && p.source !== 'aws');
      insights.push(recommendsPlans
        ? { level: 'warn', text: 'This file does not show which usage is already covered by Reserved Instances or Savings Plans (Cost Explorer\'s default export does not), so all spend is treated as on-demand. If you own any, the Savings Plans below are too large. Upload the bill PDF of the same month or connect AWS for the real coverage.' }
        : { level: 'info', text: 'No pricing-model column found, so all spend is treated as on-demand. If you already own Savings Plans or RIs, add a "Pricing Model" column so they are not double-counted.' });
    }
    if (period && period.months.length) {
      insights.push({
        level: 'info',
        text: `Using ${period.latestMonth} as the analysis month (${period.months.length} month${period.months.length > 1 ? 's' : ''} of history).${period.droppedPartial ? ` ${period.droppedPartial} was excluded as a partial month.` : ''}${period.months.length >= 2 ? ' Commitments are sized on the lowest of the last 3 months.' : ''}`,
      });
    }

    if (!mapping.cpu && mapping.id) {
      insights.push({ level: 'warn', text: 'No CPU utilization column found. Add CPU (and memory) % to unlock idle detection and rightsizing.' });
    }

    const quick = recs.filter((r) => r.effort === 'Low' && r.monthlySavings > 0);
    if (quick.length) {
      const s = quick.reduce((a, r) => a + r.monthlySavings, 0);
      insights.push({ level: 'good', text: `${quick.length} low-effort quick wins could save ${fmtPct(pct(s, totalCost))} of monthly spend.` });
    }

    if (totalSavings > 0) {
      insights.push({ level: 'good', text: `Acting on all recommendations could cut spend by ${fmtPct(pct(totalSavings, totalCost))}.` });
    }

    return insights;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };

  /**
   * @param {string[]} headers
   * @param {object[]} rows - objects keyed by header
   * @param {object} [options] - { mapping, now, ...thresholds }
   */
  function analyze(headers, rows, options = {}) {
    const opts = Object.assign({}, DEFAULTS, options);
    opts.now = options.now || new Date();
    const mapping = options.mapping || detectColumns(headers);
    const mappedHeaders = new Set(Object.values(mapping));
    // Month columns (e.g. "2026-07", "Aug 2026") in service × month layouts
    const monthCols = headers.filter((h) => !mappedHeaders.has(h) && isMonthHeader(h))
      .sort((a, b) => monthKeyOf(a).localeCompare(monthKeyOf(b)));

    if (!mapping.cost && !monthCols.length) {
      throw new Error('Could not find a cost column. Add a column named "Monthly Cost" or month columns like "2026-08" (or map one manually).');
    }

    const period = normalizeRows(rows, mapping, monthCols, opts.now);
    const resources = period.resources;
    if (!resources.length) throw new Error('No data rows with cost values were found in this sheet.');

    const lineItems = Array.isArray(options.lineItems) ? options.lineItems : [];
    const lineItemsByService = new Map();
    for (const li of lineItems) {
      if (!lineItemsByService.has(li.service)) lineItemsByService.set(li.service, []);
      lineItemsByService.get(li.service).push(li);
    }
    const regionTotals = groupSum(lineItems.map((li) => ({ region: li.region, cost: li.cost || 0 })), 'region');
    const ctx = {
      hasOwnershipColumns: Boolean(mapping.owner || mapping.tags),
      serviceDone: new Set(),
      lineItemsByService,
      itemsFor: (re) => lineItems.filter((li) => re.test(li.service)),
      topRegion: regionTotals.length && regionTotals[0].label !== 'Unspecified' ? regionTotals[0].label : '',
    };
    const recommendations = [];
    let seq = 0;

    // AWS-sourced resource recommendations (Cost Optimization Hub / Cost Explorer), attached to matching rows
    const awsMatch = attachAwsRecommendations(resources, options.aws, resources.reduce((s, r) => s + r.cost, 0));

    for (const r of resources) {
      // Apply savings sequentially on the remaining cost so stacked actions never double count.
      let remaining = r.cost;
      let recsFor = buildRecommendations(r, opts, ctx);
      const awsRecs = awsMatch.byRow.get(r.id);
      if (awsRecs) {
        // AWS measured this service's resources: drop our generic rightsizing/modernization guesses for it
        const awsEbs = awsRecs.some((x) => /\bEBS\b/.test(x.title));
        recsFor = awsRecs.concat(recsFor.filter((x) => !['Rightsizing', 'Modernization', 'Scheduling'].includes(x.category)
          && !(awsEbs && /gp2|gp3/i.test(x.title))));
      }
      for (const rec of recsFor) {
        // Line-item rules give exact dollar savings; others give a percentage
        const saving = rec.fixedSavings != null ? Math.min(remaining, Math.max(0, rec.fixedSavings)) : remaining * rec.savingsPct;
        remaining -= saving;
        recommendations.push(Object.assign({
          id: ++seq,
          resourceId: r.id,
          service: r.service || classify(r),
          region: r.region,
          environment: r.environment,
          instanceType: r.instanceType,
          currentCost: round2(r.cost),
          monthlySavings: round2(saving),
        }, rec));
      }
    }

    const totalCost = round2(resources.reduce((s, r) => s + r.cost, 0));
    const optimizationRecs = recommendations.slice(); // before plan-level recs are appended

    // ---- Commitments: sized on what remains after the optimizations above ----
    const optimizationSavings = new Map();
    for (const rec of recommendations) optimizationSavings.set(rec.resourceId, (optimizationSavings.get(rec.resourceId) || 0) + rec.monthlySavings);
    const C = getCommitments();
    // Where each instance ends up after the actions above: a new type ("→ m6i.xlarge") or removed
    const targets = new Map();
    const REMOVE = /terminate|stop or terminate|decommission|remove unused|delete unused|stop idle/i;
    for (const rec of optimizationRecs) {
      const cur = targets.get(rec.resourceId) || {};
      if (rec.category === 'Waste Elimination' && REMOVE.test(rec.title)) {
        targets.set(rec.resourceId, { remove: true, reason: rec.title });
        continue;
      }
      if (cur.remove || !['Rightsizing', 'Modernization'].includes(rec.category)) continue;
      const m = /→\s*([a-z][a-z0-9-]*\d[a-z0-9-]*\.[a-z0-9]+)/i.exec(rec.title);
      if (!m) continue;
      // Rightsizing targets already include the newer generation, so they win over a plain upgrade
      const why = `${rec.source === 'aws' ? 'AWS: ' : ''}${rec.category === 'Rightsizing' ? 'rightsize' : /graviton/i.test(rec.title) ? 'move to Graviton' : 'newer generation'}`;
      if (!cur.to || rec.category === 'Rightsizing') targets.set(rec.resourceId, { to: m[1], reason: why });
    }
    const commitments = C ? C.analyzeCommitments(resources, optimizationSavings, { isNonProd, targets }, { term: opts.term, targetCoverage: opts.targetCoverage, aws: options.aws }) : null;

    if (commitments) {
      // One Savings Plan / RI recommendation per service, using each service's share of the recommended plans.
      // (The purchase itself is shown per plan in the Savings Plans panel.)
      const planTerm = new Map(commitments.plans.map((p) => [p.label, p.recommended.label]));
      const awsPlanLabels = new Set(commitments.plans.filter((p) => p.source === 'aws').map((p) => p.label));
      const perService = new Map();
      for (const r of resources) {
        const c = commitments.byResource[r.id];
        if (!c || c.savings <= 0) continue;
        const key = r.service || SERVICE_KIND_LABELS[classify(r)] || 'Other';
        const s = perService.get(key) || { service: key, cost: 0, covered: 0, savings: 0, hourly: 0, plans: new Set(), bucket: c.bucket, regions: new Set(), count: 0 };
        s.cost += r.cost; s.covered += c.coveredOnDemand; s.savings += c.savings; s.hourly += c.hourly; s.count++;
        c.plans.forEach((p) => s.plans.add(p));
        if (r.region) s.regions.add(r.region);
        perService.set(key, s);
      }
      const ec2Info = commitments.ec2;
      for (const s of perService.values()) {
        const planNames = [...s.plans].join(' + ');
        const termLabel = [...new Set([...s.plans].map((p) => planTerm.get(p)).filter(Boolean))].join(' / ');
        const isEC2 = s.bucket === 'ec2';
        const pct = s.covered > 0 ? (s.savings / s.covered) * 100 : 0;
        let detail = `Commit ~${s.hourly.toFixed(2)}/hr to cover ${s.covered.toFixed(2)}/mo of steady on-demand ${s.service} usage at ~${pct.toFixed(0)}% off.`;
        if (isEC2 && ec2Info) {
          const cmp = ec2Info.comparison.find((x) => x.key === (opts.term || '1y-nu')) || ec2Info.comparison[0];
          detail += ` Steady baseline is ${ec2Info.baseline.toFixed(2)}/mo after excluding ${ec2Info.optimizationCut.toFixed(2)}/mo of rightsizing/waste savings.`;
          if (cmp && cmp.ec2InstanceSP) {
            detail += ` For the same commitment, an EC2 Instance SP would save ~${cmp.ec2InstanceSP.monthlySavings.toFixed(2)}/mo vs ${cmp.computeSP.monthlySavings.toFixed(2)}/mo for a Compute SP, but locks you to one instance family and region.`;
          }
          detail += ' See the EC2 Savings Plan section for all terms.';
        } else {
          detail += ` Part of the ${planNames} purchase shown in the Savings Plans panel.`;
        }
        const fromAws = [...s.plans].every((p) => awsPlanLabels.has(p));
        if (fromAws) detail = `${detail} Figures from AWS Cost Explorer (this service's share of the account-wide recommendation).`;
        recommendations.push({
          id: ++seq,
          resourceId: s.service,
          service: s.service,
          region: [...s.regions].slice(0, 3).join(', '), environment: '', instanceType: '',
          category: [...s.plans].every((p) => /reserved/i.test(p)) ? 'Reserved Instances' : 'Savings Plans',
          priority: s.savings >= totalCost * 0.02 ? 'High' : 'Medium',
          effort: 'Low',
          savingsPct: pct / 100,
          title: `${isEC2 ? 'EC2 Savings Plan' : `Savings Plan for ${s.service}`}: ${planNames}${termLabel ? ` · ${termLabel}` : ''} · ${s.hourly.toFixed(2)}/hr`,
          detail,
          currentCost: round2(s.cost),
          monthlySavings: round2(s.savings),
          hourlyCommitment: round2(s.hourly),
          source: fromAws ? 'aws' : undefined,
        });
      }
    }

    recommendations.sort((a, b) => (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) || (b.monthlySavings - a.monthlySavings));
    const totalSavings = round2(recommendations.reduce((s, r) => s + r.monthlySavings, 0));

    const byCategory = {};
    for (const rec of recommendations) {
      byCategory[rec.category] = byCategory[rec.category] || { count: 0, savings: 0 };
      byCategory[rec.category].count++;
      byCategory[rec.category].savings = round2(byCategory[rec.category].savings + rec.monthlySavings);
    }

    return {
      mapping,
      resources,
      recommendations,
      summary: {
        level: mapping.id ? 'resource' : 'service',
        totalCost,
        totalSavings,
        annualSavings: round2(totalSavings * 12),
        savingsPct: round2(pct(totalSavings, totalCost)),
        resourceCount: resources.length,
        // Distinct services (EC2 can be split into one row per instance type / pricing model)
        serviceCount: new Set(resources.map((r) => r.service || r.id)).size,
        recommendationCount: recommendations.length,
        affectedResources: new Set(recommendations.filter((r) => r.monthlySavings > 0).map((r) => r.resourceId)).size,
        byPriority: {
          High: recommendations.filter((r) => r.priority === 'High').length,
          Medium: recommendations.filter((r) => r.priority === 'Medium').length,
          Low: recommendations.filter((r) => r.priority === 'Low').length,
        },
        byCategory,
      },
      breakdowns: {
        service: mapping.service ? groupSum(resources, 'service') : [],
        region: lineItems.length ? regionTotals : mapping.region ? groupSum(resources, 'region') : [],
        environment: mapping.environment ? groupSum(resources, 'environment') : [],
      },
      insights: withAwsInsights(buildInsights(resources, recommendations, mapping, totalCost, totalSavings, commitments, period), options.aws, awsMatch, commitments),
      awsInfo: options.aws ? { matched: awsMatch.total - awsMatch.unmatched, unmatched: awsMatch.unmatched, total: awsMatch.total } : null,
      commitments,
      serviceSavings: buildServiceSavings(resources, optimizationRecs, commitments),
      period: { months: period.months, latestMonth: period.latestMonth, droppedPartial: period.droppedPartial, monthColumns: monthCols },
    };
  }

  const SERVICE_KIND_LABELS = {
    compute: 'Compute', database: 'Database', volume: 'Block storage', objectStorage: 'Object storage', snapshot: 'Snapshots',
    ip: 'Public IPs', loadBalancer: 'Load balancers', ec2Other: 'EC2-Other', other: 'Other',
  };

  /**
   * Roll optimization and commitment savings up to service level.
   * Commitment savings come from commitments.byResource (plan savings attributed pro rata to steady usage).
   */
  function buildServiceSavings(resources, optimizationRecs, commitments) {
    const byRes = (commitments && commitments.byResource) || {};
    const recsByRes = new Map();
    for (const rec of optimizationRecs) {
      if (!recsByRes.has(rec.resourceId)) recsByRes.set(rec.resourceId, []);
      recsByRes.get(rec.resourceId).push(rec);
    }

    const map = new Map();
    for (const r of resources) {
      const key = r.service || SERVICE_KIND_LABELS[classify(r)] || 'Other';
      const s = map.get(key) || {
        service: key, cost: 0, optimizationSavings: 0, commitmentSavings: 0, resourceCount: 0,
        _actions: new Map(), _plans: new Set(), _byCat: {},
      };
      s.cost += r.cost;
      s.resourceCount++;
      for (const rec of recsByRes.get(r.id) || []) {
        s.optimizationSavings += rec.monthlySavings;
        s._byCat[rec.category] = (s._byCat[rec.category] || 0) + rec.monthlySavings;
        const a = s._actions.get(rec.title) || { title: rec.title, category: rec.category, savings: 0, count: 0 };
        a.savings += rec.monthlySavings; a.count++;
        s._actions.set(rec.title, a);
      }
      const c = byRes[r.id];
      if (c) { s.commitmentSavings += c.savings; c.plans.forEach((p) => s._plans.add(p)); }
      map.set(key, s);
    }

    return [...map.values()].map((s) => {
      const total = s.optimizationSavings + s.commitmentSavings;
      const actions = [...s._actions.values()].sort((a, b) => b.savings - a.savings)
        .map((a) => ({ title: a.title, category: a.category, savings: round2(a.savings), count: a.count }));
      if (s._plans.size && s.commitmentSavings > 0) {
        actions.push({ title: `Cover steady usage with ${[...s._plans].join(' + ')}`, category: 'Savings Plans', savings: round2(s.commitmentSavings), count: 1 });
        actions.sort((a, b) => b.savings - a.savings);
      }
      if (s.commitmentSavings > 0) s._byCat['Savings Plans / RIs'] = s.commitmentSavings;
      return {
        service: s.service,
        resourceCount: s.resourceCount,
        cost: round2(s.cost),
        optimizationSavings: round2(s.optimizationSavings),
        commitmentSavings: round2(s.commitmentSavings),
        totalSavings: round2(total),
        savingsPct: s.cost > 0 ? round2(Math.min(100, (total / s.cost) * 100)) : 0,
        optimizedCost: round2(Math.max(0, s.cost - total)),
        byCategory: Object.fromEntries(Object.entries(s._byCat).map(([k, v]) => [k, round2(v)])),
        actions,
      };
    }).sort((a, b) => (b.totalSavings - a.totalSavings) || (b.cost - a.cost));
  }

  // ---------------------------------------------------------------------------
  // AWS recommendations (from the local connector)
  // ---------------------------------------------------------------------------

  /** Which uploaded/fetched service row an AWS resource type belongs to. */
  const AWS_TYPE_SERVICE = [
    [/^Ec2(Instance|AutoScalingGroup)/, /ec2[\s-]*instances|elastic\s*compute\s*cloud(?![\s-]*other)|^ec2$|amazonec2/i],
    [/^EbsVolume/, /ec2[\s-]*other|\bebs\b|elastic\s*block/i],
    [/^LambdaFunction/, /lambda/i],
    [/^(RdsDb|AuroraDb)/, /relational\s*database|\brds\b|aurora/i],
    [/^EcsService/, /elastic\s*container|\becs\b|fargate/i],
    [/^ElastiCache/, /elasticache/i],
    [/^OpenSearch/, /opensearch|elasticsearch/i],
    [/^Redshift/, /redshift/i],
    [/^DynamoDb/, /dynamodb/i],
    [/^Nat/, /ec2[\s-]*other|nat/i],
  ];
  const AWS_ACTION = {
    Rightsize: ['Rightsizing', 'Rightsize'], Stop: ['Waste Elimination', 'Stop idle'], Delete: ['Waste Elimination', 'Delete unused'],
    ScaleIn: ['Rightsizing', 'Scale in'], Upgrade: ['Modernization', 'Upgrade'], MigrateToGraviton: ['Modernization', 'Move to Graviton'],
  };
  const AWS_EFFORT = { VeryLow: 'Low', Low: 'Low', Medium: 'Medium', High: 'High', VeryHigh: 'High' };
  const AWS_TYPE_LABEL = (t) => String(t || 'resource').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^Ec2/, 'EC2').replace(/^Ebs/, 'EBS').replace(/^Rds/, 'RDS').replace(/^Ecs/, 'ECS');

  function attachAwsRecommendations(resources, aws, totalCost) {
    const byRow = new Map();
    const items = aws && aws.optimization && Array.isArray(aws.optimization.items) ? aws.optimization.items : [];
    let unmatched = 0;
    for (const it of items) {
      if (!(it.monthlySavings > 0)) continue;
      const pair = AWS_TYPE_SERVICE.find(([t]) => t.test(it.resourceType || ''));
      const row = resources.find((r) => r.id === it.resourceId)
        || (pair && resources.find((r) => pair[1].test(r.service)));
      if (!row) { unmatched++; continue; }
      const [category, verb] = AWS_ACTION[it.actionType] || ['Rightsizing', it.actionType || 'Optimize'];
      const change = it.currentSummary && it.recommendedSummary && it.currentSummary !== it.recommendedSummary
        ? `: ${it.currentSummary} → ${it.recommendedSummary}` : it.currentSummary ? ` (${it.currentSummary})` : '';
      const share = totalCost > 0 ? it.monthlySavings / totalCost : 0;
      const rec = {
        source: 'aws',
        category,
        priority: share >= 0.02 ? 'High' : share >= 0.005 ? 'Medium' : 'Low',
        effort: AWS_EFFORT[it.effort] || 'Medium',
        savingsPct: 0,
        fixedSavings: it.monthlySavings,
        title: `${verb} ${AWS_TYPE_LABEL(it.resourceType)} ${it.resourceId || ''}${change}`.replace(/\s+/g, ' ').trim(),
        detail: [
          `AWS ${it.source === 'CostExplorer' ? 'Cost Explorer' : 'Cost Optimization Hub'} estimate: saves ${it.monthlySavings.toFixed(2)}/mo`
            + `${it.monthlyCost ? ` of ${it.monthlyCost.toFixed(2)}/mo` : ''}${it.lookbackDays ? `, based on ${it.lookbackDays} days of usage` : ''}.`,
          it.maxCpuPct ? `Peak CPU was ${it.maxCpuPct.toFixed(0)}%.` : '',
          it.restartNeeded === true ? 'Needs a restart.' : it.restartNeeded === false ? 'No restart needed.' : '',
          it.rollbackPossible ? 'Can be rolled back.' : '',
          it.region ? `Region ${it.region}.` : '',
          it.accountId ? `Account ${it.accountId}.` : '',
        ].filter(Boolean).join(' '),
        awsResourceId: it.resourceId,
        region: it.region || row.region,
      };
      if (!byRow.has(row.id)) byRow.set(row.id, []);
      byRow.get(row.id).push(rec);
    }
    for (const list of byRow.values()) list.sort((a, b) => b.fixedSavings - a.fixedSavings);
    return { byRow, unmatched, total: items.length };
  }

  function withAwsInsights(insights, aws, match, commitments) {
    if (!aws) return insights;
    const out = [];
    const awsPlans = commitments ? commitments.plans.filter((p) => p.source === 'aws') : [];
    if (awsPlans.length) out.push({ level: 'good', text: `Savings Plan and Reserved Instance figures for ${awsPlans.map((p) => p.label).join(', ')} come from AWS Cost Explorer, based on your last ${aws.lookbackDays || 30} days of usage.` });
    if (match.total) {
      out.push({ level: 'good', text: `${match.total - match.unmatched} resource recommendation(s) come from AWS${aws.optimization && aws.optimization.source === 'CostExplorerRightsizing' ? ' Cost Explorer rightsizing' : ' Cost Optimization Hub'}, measured on your actual utilization.${match.unmatched ? ` ${match.unmatched} did not match a service in this data.` : ''}` });
    }
    if (aws.optimization && aws.optimization.hubError) {
      out.push({ level: 'warn', text: 'Cost Optimization Hub is not enabled, so only EC2 rightsizing came from AWS. Enable it (free) in the Billing console for Lambda, EBS, RDS, ECS and idle-resource recommendations.' });
    }
    if (aws.utilization && !aws.utilization.error && aws.utilization.utilizationPct > 0 && aws.utilization.utilizationPct < 95) {
      out.push({ level: 'warn', text: `Your existing Savings Plans were only ${aws.utilization.utilizationPct.toFixed(0)}% used in ${aws.utilization.month} (${aws.utilization.unusedCommitment.toFixed(2)} unused). Fix this before buying more.` });
    }
    return out.concat(insights);
  }

  function getLineRules() {
    if (typeof globalThis !== 'undefined' && globalThis.FinOpsLineRules) return globalThis.FinOpsLineRules;
    if (typeof require === 'function') { try { return require('./line-rules.js'); } catch (_) { /* not available */ } }
    return null;
  }

  function getCommitments() {
    if (typeof globalThis !== 'undefined' && globalThis.FinOpsCommitments) return globalThis.FinOpsCommitments;
    if (typeof require === 'function') { try { return require('./commitments.js'); } catch (_) { /* not available */ } }
    return null;
  }

  return { analyze, prepare, detectColumns, normalizeHeader, monthKeyOf, smallerSize, modernType, classify, FIELD_ALIASES, FIELD_LABELS, DEFAULTS };
});
