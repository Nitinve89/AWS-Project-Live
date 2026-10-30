/**
 * Public AWS EC2 prices, no AWS account or login needed.
 *
 * Reads the same public price files the AWS pricing pages and Pricing Calculator load
 * (b0.p.awsstatic.com). Browsers block these files for other sites, so this runs inside the
 * local connector (/api/public-pricing), which needs no AWS login. Gives on-demand and Compute Savings Plan rates per
 * instance type, region, OS and term. EC2 Instance SP and Reserved Instance rates are not
 * published this way; those come from the local connector when you are signed in.
 */
(function (root) {
  'use strict';

  const BASE = 'https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps';
  const REGION_NAMES = {
    'us-east-1': 'US East (N. Virginia)', 'us-east-2': 'US East (Ohio)', 'us-west-1': 'US West (N. California)', 'us-west-2': 'US West (Oregon)',
    'ap-south-1': 'Asia Pacific (Mumbai)', 'ap-south-2': 'Asia Pacific (Hyderabad)', 'ap-southeast-1': 'Asia Pacific (Singapore)',
    'ap-southeast-2': 'Asia Pacific (Sydney)', 'ap-southeast-3': 'Asia Pacific (Jakarta)', 'ap-northeast-1': 'Asia Pacific (Tokyo)',
    'ap-northeast-2': 'Asia Pacific (Seoul)', 'ap-northeast-3': 'Asia Pacific (Osaka)', 'ap-east-1': 'Asia Pacific (Hong Kong)',
    'ca-central-1': 'Canada (Central)', 'eu-west-1': 'EU (Ireland)', 'eu-west-2': 'EU (London)', 'eu-west-3': 'EU (Paris)',
    'eu-central-1': 'EU (Frankfurt)', 'eu-north-1': 'EU (Stockholm)', 'eu-south-1': 'EU (Milan)', 'eu-south-2': 'EU (Spain)',
    'sa-east-1': 'South America (Sao Paulo)', 'me-south-1': 'Middle East (Bahrain)', 'me-central-1': 'Middle East (UAE)', 'af-south-1': 'Africa (Cape Town)',
  };
  const NAME_TO_CODE = Object.fromEntries(Object.entries(REGION_NAMES).map(([c, n]) => [n.toLowerCase(), c]));
  const OS_NAME = { linux: 'Linux', windows: 'Windows', rhel: 'RHEL', suse: 'SUSE' };
  const TERM = { '1y': '1 year', '3y': '3 year' };
  const PAY = { nu: 'No Upfront', pu: 'Partial Upfront', au: 'All Upfront' };

  function regionName(r) {
    const s = String(r || '').trim();
    if (REGION_NAMES[s]) return REGION_NAMES[s];
    const hit = Object.values(REGION_NAMES).find((n) => n.toLowerCase() === s.toLowerCase());
    return hit || '';
  }

  const cache = new Map();
  async function getJson(url) {
    if (!cache.has(url)) {
      cache.set(url, fetch(url).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }).catch((e) => { cache.delete(url); throw e; }));
    }
    return cache.get(url);
  }
  const seg = (s) => encodeURIComponent(s);

  /** Map instanceType → { onDemand, computeSP } for one region / OS / term. */
  async function rates(region, os, termKey) {
    const [y, p] = termKey.split('-');
    const osName = OS_NAME[os] || 'Linux';
    const out = new Map();
    // On-demand list (covers types without a Savings Plan rate)
    try {
      const od = await getJson(`${BASE}/ec2/USD/current/ec2-ondemand-without-sec-sel/${seg(region)}/${seg(osName)}/index.json`);
      for (const v of Object.values((od.regions && od.regions[region]) || {})) {
        const t = v['Instance Type']; const price = parseFloat(v.price);
        if (t && price > 0) out.set(t, { onDemand: price, computeSP: null });
      }
    } catch (_) { /* fall back to the SP file's on-demand price */ }
    const sp = await getJson(`${BASE}/computesavingsplan/USD/current/compute-savings-plan-ec2/${seg(TERM[y])}/${seg(PAY[p])}/${seg(region)}/${seg(osName)}/Shared/index.json`);
    for (const v of Object.values((sp.regions && sp.regions[region]) || {})) {
      const t = v['ec2:InstanceType']; const price = parseFloat(v.price); const od = parseFloat(v['ec2:PricePerUnit']);
      if (!t || !(price > 0)) continue;
      const e = out.get(t) || { onDemand: od > 0 ? od : null, computeSP: null };
      e.computeSP = price;
      if (!e.onDemand && od > 0) e.onDemand = od;
      out.set(t, e);
    }
    return out;
  }

  /** Same result shape as the connector's /api/aws/pricing. */
  async function priceCheck(items, termKey) {
    const errors = [];
    const groups = new Map();
    for (const i of items) {
      const name = regionName(i.region);
      if (!name) { errors.push(`Unknown region "${i.region}"`); continue; }
      const k = `${name}|${i.os || 'linux'}`;
      if (!groups.has(k)) groups.set(k, null);
    }
    await Promise.all([...groups.keys()].map(async (k) => {
      const [name, os] = k.split('|');
      try { groups.set(k, await rates(name, os, termKey)); } catch (e) { errors.push(`${name} ${os}: ${e.message}`); groups.set(k, new Map()); }
    }));
    const rows = items.map((i) => {
      const name = regionName(i.region);
      const m = groups.get(`${name}|${i.os || 'linux'}`) || new Map();
      const r = m.get(i.type) || {};
      return {
        type: i.type, region: NAME_TO_CODE[name.toLowerCase()] || i.region, os: i.os || 'linux', hours: i.hours,
        onDemand: r.onDemand || null, computeSP: r.computeSP || null, ec2InstanceSP: null, reservedInstance: null,
      };
    });
    return { term: termKey, rows, errors: [...new Set(errors)].slice(0, 5), source: 'AWS public price files (same as the AWS pricing pages)', partial: true };
  }

  root.FinOpsPublicPricing = { priceCheck, regionName };
  if (typeof module === 'object' && module.exports) module.exports = root.FinOpsPublicPricing;
})(typeof globalThis !== 'undefined' ? globalThis : self);
