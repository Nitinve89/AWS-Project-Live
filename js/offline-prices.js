/**
 * Offline AWS EC2 prices (works when index.html is opened as a file).
 * Loads js/prices/<region>-<os>.js on demand with a <script> tag, which browsers allow from file://.
 * Built by server/build-prices.js from AWS's public price files; re-run it to refresh.
 */
(function (root) {
  'use strict';

  const NAMES = {
    'us east (n. virginia)': 'us-east-1', 'us east (ohio)': 'us-east-2', 'us west (n. california)': 'us-west-1', 'us west (oregon)': 'us-west-2',
    'asia pacific (mumbai)': 'ap-south-1', 'asia pacific (hyderabad)': 'ap-south-2', 'asia pacific (singapore)': 'ap-southeast-1',
    'asia pacific (sydney)': 'ap-southeast-2', 'asia pacific (jakarta)': 'ap-southeast-3', 'asia pacific (tokyo)': 'ap-northeast-1',
    'asia pacific (seoul)': 'ap-northeast-2', 'asia pacific (osaka)': 'ap-northeast-3', 'asia pacific (hong kong)': 'ap-east-1',
    'canada (central)': 'ca-central-1', 'eu (ireland)': 'eu-west-1', 'eu (london)': 'eu-west-2', 'eu (paris)': 'eu-west-3',
    'eu (frankfurt)': 'eu-central-1', 'eu (stockholm)': 'eu-north-1', 'eu (milan)': 'eu-south-1', 'eu (spain)': 'eu-south-2',
    'south america (sao paulo)': 'sa-east-1', 'middle east (bahrain)': 'me-south-1', 'middle east (uae)': 'me-central-1', 'africa (cape town)': 'af-south-1',
  };
  const code = (r) => {
    const s = String(r || '').trim();
    return /^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(s) ? s : NAMES[s.toLowerCase()] || '';
  };

  const loading = new Map();
  function load(key) {
    root.FINOPS_PRICES = root.FINOPS_PRICES || {};
    if (root.FINOPS_PRICES[key]) return Promise.resolve(root.FINOPS_PRICES[key]);
    if (!loading.has(key)) {
      loading.set(key, new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = `js/prices/${key.replace('|', '-')}.js`;
        s.onload = () => resolve(root.FINOPS_PRICES[key] || null);
        s.onerror = () => { loading.delete(key); resolve(null); };
        document.head.appendChild(s);
      }));
    }
    return loading.get(key);
  }

  /** Same result shape as the connector's pricing endpoints. */
  async function priceCheck(items, termKey) {
    const errors = [];
    let built = '';
    const rows = await Promise.all(items.map(async (i) => {
      const c = code(i.region);
      const os = i.os === 'windows' ? 'windows' : 'linux';
      const base = { type: i.type, region: c || i.region, os, hours: i.hours, onDemand: null, computeSP: null, ec2InstanceSP: null, reservedInstance: null };
      if (!c) { errors.push(`Unknown region "${i.region}"`); return base; }
      if (i.os && !['linux', 'windows'].includes(i.os)) errors.push(`Offline prices cover Linux and Windows only (${i.type} is ${i.os}).`);
      const data = await load(`${c}|${os}`);
      if (!data) { errors.push(`No offline prices for ${c} ${os}. Run: node server/build-prices.js ${c}`); return base; }
      built = data.built;
      const t = data.types[i.type];
      if (!t) { errors.push(`${i.type} not found in ${c}`); return base; }
      return Object.assign(base, { onDemand: t.o, computeSP: t.c[termKey] || null });
    }));
    return {
      term: termKey, rows, errors: [...new Set(errors)].slice(0, 5), partial: true,
      source: `AWS public price list, saved ${built || 'locally'} (refresh: node server/build-prices.js)`,
    };
  }

  root.FinOpsOfflinePricing = { priceCheck };
})(window);
