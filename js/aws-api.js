/**
 * Client for the local connector (server/server.js).
 * The page talks to its own origin only; AWS credentials stay in the connector.
 */
(function (root) {
  'use strict';

  const TIMEOUT_MS = 15000; // first AWS sign-in check can take several seconds

  async function getJson(url, timeout) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl && timeout ? setTimeout(() => ctrl.abort(), timeout) : null;
    try {
      const res = await fetch(url, { signal: ctrl ? ctrl.signal : undefined, headers: { Accept: 'application/json' } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || `Connector returned HTTP ${res.status}`);
      return body;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** null = connector not reachable (page opened as a file, or server not started). */
  async function status() {
    if (!/^https?:$/.test(location.protocol)) return null;
    try { return await getJson('/api/status', TIMEOUT_MS); } catch (_) { return null; }
  }

  function analysis({ term = '1y-nu', lookback = 30, months = 3, refresh = false, account = '', mode = 'auto', role = '', externalId = '' } = {}) {
    const q = new URLSearchParams({ term, lookback: String(lookback), months: String(months), mode });
    if (account) q.set('account', account);
    if (role) q.set('role', role);
    if (externalId) q.set('externalId', externalId);
    if (refresh) q.set('refresh', '1');
    return getJson(`/api/aws/analysis?${q}`, 0); // no timeout: Cost Explorer can take a while
  }

  /** Exact on-demand, Savings Plan and RI rates per instance type. items: [{type, region, os, hours}] */
  function pricing(items, term) {
    const enc = items.map((i) => [i.type, i.region, i.os || 'linux', Math.round(i.hours || 0)].join('~')).join(';');
    return getJson(`/api/aws/pricing?${new URLSearchParams({ items: enc, term })}`, 0);
  }

  /** Savings Plans Purchase Analyzer: start, then poll until SUCCEEDED / FAILED. */
  async function purchaseAnalysis(params, onProgress) {
    const q = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== '')));
    const start = await getJson(`/api/aws/purchase-analysis/start?${q}`, 0);
    const t0 = Date.now();
    for (let i = 0; i < 40; i++) { // at most ~10 minutes of polling
      await new Promise((r) => setTimeout(r, i === 0 ? 5000 : 15000));
      const res = await getJson(`/api/aws/purchase-analysis/result?id=${encodeURIComponent(start.analysisId)}`, 0);
      if (onProgress) onProgress(res, Math.round((Date.now() - t0) / 1000), start);
      if (res.status !== 'PROCESSING') return Object.assign(res, { request: start });
    }
    throw new Error(`AWS is still processing analysis ${start.analysisId}. Check it later in the console (Savings Plans → Purchase Analyzer).`);
  }

  /** Public on-demand + Compute SP rates through the connector (no AWS login needed). */
  function publicPricing(items, term) {
    const enc = items.map((i) => [i.type, i.region, i.os || 'linux', Math.round(i.hours || 0)].join('~')).join(';');
    return getJson(`/api/public-pricing?${new URLSearchParams({ items: enc, term })}`, 0);
  }

  /** Organization member accounts (empty if not signed in to the management account). */
  async function accounts() {
    try { return (await getJson('/api/aws/accounts', 8000)).accounts || []; } catch (_) { return []; }
  }

  /** Cost Explorer costs → the "service × month" dataset the engine already understands. */
  function toDataset(data) {
    const c = data.costs;
    if (!c || c.error) throw new Error(`Could not read costs from Cost Explorer: ${(c && c.message) || 'no data'}`);
    const headers = ['Service', ...c.months];
    const rows = c.services
      .map((s) => Object.assign({ Service: s.service }, Object.fromEntries(c.months.map((m) => [m, s.monthly[m] || 0]))))
      .filter((r) => c.months.some((m) => Math.abs(r[m]) >= 0.01));
    const LR = root.FinOpsLineRules;
    const lineItems = (c.lineItems || []).map((li) => Object.assign({}, li, {
      region: li.region || (LR ? LR.regionFromUsageType(li.usageType) : ''),
    }));
    return { headers, rows, lineItems };
  }

  /** Human-readable status of each AWS data source, for the UI. */
  function sources(data) {
    const out = [];
    const ok = (v) => v && !v.error;
    if (data.target) {
      const how = { self: 'your signed-in account', linked: `Organization view from payer ${data.target.signedInAs}`, role: `role ${data.target.role}` }[data.target.mode] || data.target.mode;
      out.push({ name: `Account ${data.target.account}`, ok: true, note: `via ${how}` });
    }
    out.push({ name: 'Costs by service (Cost Explorer)', ok: ok(data.costs), note: ok(data.costs) ? `${data.costs.months.length} months, ${data.costs.services.length} services` : data.costs && data.costs.message });
    const sp = data.savingsPlans || {};
    const spNames = { COMPUTE_SP: 'Compute SP', EC2_INSTANCE_SP: 'EC2 Instance SP', SAGEMAKER_SP: 'SageMaker SP', DATABASE_SP: 'Database SP' };
    for (const [k, v] of Object.entries(sp)) {
      out.push({ name: `${spNames[k] || k} recommendation`, ok: ok(v), note: ok(v) ? (v.monthlySavings > 0 ? `AWS suggests ${v.hourly.toFixed(3)}/hr` : 'AWS suggests no purchase') : v.message });
    }
    for (const [k, v] of Object.entries(data.reservations || {})) {
      out.push({ name: `${k.toUpperCase()} Reserved Instances`, ok: ok(v), note: ok(v) ? (v.count ? `${v.count} recommendation(s)` : 'AWS suggests no purchase') : v.message });
    }
    out.push({ name: 'Savings Plans coverage', ok: ok(data.coverage), note: ok(data.coverage) ? `${data.coverage.coveragePct.toFixed(0)}% in ${data.coverage.month}` : data.coverage && data.coverage.message });
    const o = data.optimization || {};
    out.push({
      name: o.source === 'CostExplorerRightsizing' ? 'EC2 rightsizing (Cost Explorer)' : 'Resource recommendations (Cost Optimization Hub)',
      ok: ok(o),
      note: ok(o) ? `${o.items.length} recommendation(s)${o.hubError ? '. Enable Cost Optimization Hub for Lambda, EBS, RDS and ECS too.' : ''}` : o.message,
    });
    return out;
  }

  root.FinOpsAws = { status, analysis, accounts, pricing, publicPricing, purchaseAnalysis, toDataset, sources };
})(typeof globalThis !== 'undefined' ? globalThis : self);
