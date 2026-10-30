/**
 * PDF bill reader.
 *
 * Reads an AWS bill / annexure PDF (Billing console "Bills" page export) in the browser with pdf.js,
 * rebuilds text lines from glyph positions, then walks the "Charges by service" hierarchy:
 *
 *   Service header        "Secrets Manager                                  USD 1,701.78"
 *     Region              "Asia Pacific (Mumbai)                            USD 1,701.78"
 *       Usage type group  "AWS Secrets Manager APS3-AWSSecretsManagerAPIRequest  USD 1,701.23"
 *         Rate line       "$0.05 per 10000 API Requests   340,246,885 API Requests   USD 1,701.23"
 *
 * Output is a dataset the FinOps engine already understands (service rows) plus line items
 * for usage-type level recommendations. Other PDF layouts fall back to "description … amount" rows.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FinOpsPdf = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  // Pinned pdf.js build (loaded only when a PDF is uploaded)
  const PDFJS_VERSION = '4.10.38';
  const PDFJS_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`;
  const PDFJS_WORKER_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  // [uU]{0,2}[sS][dD] tolerates OCR variants such as "UsD", "usD", "uUsD"
  const CUR = '(US\\$|[uU]{0,2}[sS][dD]|INR|EUR|GBP|JPY|AUD|CAD|SGD|\\$|₹|€|£)';
  const AMOUNT_END = new RegExp(`${CUR}\\s?(-?[\\d,]*\\d(?:\\.\\d+)?)\\s*$`);
  const REGION_LINE = /^(Any|No Region|Global)$|^(US|EU|Europe|Asia Pacific|Africa|Canada|Middle East|South America|Mexico|Israel|AWS GovCloud)\b.{0,40}\)$/;
  const INSTANCE_TYPE = /\b([a-z][a-z0-9-]*\d[a-z0-9-]*\.\d*x?(?:nano|micro|small|medium|large|xlarge|metal))\b/i;

  const toNum = (s) => {
    const n = parseFloat(String(s).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const r2 = (n) => Math.round(n * 100) / 100;

  // ---------------------------------------------------------------------------
  // pdf.js loading and text extraction
  // ---------------------------------------------------------------------------

  let loading = null;
  function loadPdfJs() {
    if (globalThis.pdfjsLib) return Promise.resolve(globalThis.pdfjsLib);
    if (!loading) {
      loading = import(/* webpackIgnore: true */ PDFJS_URL).then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        return lib;
      }).catch((err) => {
        loading = null;
        throw new Error(`Could not load the PDF reader (pdf.js). Check your internet connection. ${err.message || ''}`.trim());
      });
    }
    return loading;
  }

  function joinItems(items) {
    let s = '';
    let prevEnd = null;
    for (const it of items) {
      if (prevEnd != null && it.x - prevEnd > it.h * 0.15 && !s.endsWith(' ') && !it.str.startsWith(' ')) s += ' ';
      s += it.str;
      prevEnd = it.x + it.w;
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  /** Group positioned words into lines (PDF coordinates: y grows upwards). */
  function buildLines(items, page, width) {
    items.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    const pageLines = [];
    for (const it of items) {
      // Look at the last few lines only; items of one line have near-identical baselines
      let line = null;
      for (let k = pageLines.length - 1; k >= Math.max(0, pageLines.length - 3); k--) {
        const l = pageLines[k];
        if (Math.abs(l.y - it.y) <= Math.max(1.5, Math.min(l.h, it.h) * 0.45)) { line = l; break; }
      }
      if (line) line.items.push(it); else pageLines.push({ y: it.y, h: it.h, items: [it] });
    }
    return pageLines.map((l) => {
      l.items.sort((a, b) => a.x - b.x);
      return { page, y: l.y, h: l.h, width, items: l.items, text: joinItems(l.items) };
    });
  }

  async function textLines(doc, onProgress) {
    const lines = [];
    for (let p = 1; p <= doc.numPages; p++) {
      if (onProgress) onProgress(`Reading PDF page ${p} of ${doc.numPages}…`);
      const page = await doc.getPage(p);
      const width = page.getViewport({ scale: 1 }).width;
      const content = await page.getTextContent();
      const items = content.items
        .filter((i) => i.str && i.str.trim())
        .map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0, h: Math.abs(i.transform[3]) || i.height || 8 }));
      lines.push(...buildLines(items, p, width));
      page.cleanup();
    }
    return lines;
  }

  // ---------------------------------------------------------------------------
  // OCR fallback for PDFs whose text is drawn as vector outlines or images
  // ---------------------------------------------------------------------------

  const TESSERACT_VERSION = '5.1.1';
  const TESSERACT_URL = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js`;
  const OCR_SCALE = 3; // ~216 dpi: small grey bill text needs it

  let tessLoading = null;
  function loadTesseract() {
    if (globalThis.Tesseract) return Promise.resolve(globalThis.Tesseract);
    if (!tessLoading) {
      tessLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = TESSERACT_URL;
        s.async = true;
        s.onload = () => (globalThis.Tesseract ? resolve(globalThis.Tesseract) : reject(new Error('Tesseract did not initialise')));
        s.onerror = () => { tessLoading = null; reject(new Error('Could not load the OCR engine (Tesseract.js). Check your internet connection.')); };
        document.head.appendChild(s);
      });
    }
    return tessLoading;
  }

  const browserCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

  /** Render each page and OCR it; returns lines in the same shape as textLines(). */
  /** How many pages to OCR at the same time (one Tesseract worker each). */
  function ocrConcurrency(env, pages) {
    const cores = env.cores || (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    return Math.max(1, Math.min(pages, env.workers || Math.min(6, Math.max(2, cores - 1))));
  }

  /** Text after the charges (invoices, taxes) is not needed; pages after it can be skipped. */
  const END_OF_CHARGES = /charges by account|taxes by service|tax invoices and additional/i;

  /** Render pages and OCR them in parallel; returns lines in the same shape as textLines(). */
  async function ocrLines(doc, onProgress, env) {
    const Tesseract = env.tesseract || await loadTesseract();
    const createCanvas = env.createCanvas || browserCanvas;
    const toImage = env.toImage || ((c) => c);
    const S = env.scale || OCR_SCALE;
    const n = doc.numPages;
    const nWorkers = ocrConcurrency(env, n);
    if (onProgress) onProgress(`This PDF has no text layer; starting ${nWorkers} OCR workers…`);
    const workers = await Promise.all(Array.from({ length: nWorkers }, async () => {
      const w = await Tesseract.createWorker('eng');
      await w.setParameters({ preserve_interword_spaces: '1' });
      return w;
    }));

    const perPage = new Array(n + 1);
    let next = 1; let done = 0; let stopAfter = n;
    const t0 = Date.now();

    // Render one page to an image (main thread). Started ahead of time so a worker never waits.
    const render = async (p) => {
      const page = await doc.getPage(p);
      const width = page.getViewport({ scale: 1 }).width;
      const vp = page.getViewport({ scale: S });
      const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const image = toImage(canvas);
      const height = canvas.height;
      page.cleanup();
      return { image, height, width, free: () => { canvas.width = canvas.height = 0; } };
    };

    const ocrPage = async (worker, p, img) => {
      const { data } = await worker.recognize(img.image);
      img.free();
      const items = [];
      for (const line of data.lines || []) {
        const lh = (line.bbox.y1 - line.bbox.y0) / S;
        const base = line.baseline ? (line.baseline.y0 + line.baseline.y1) / 2 : line.bbox.y1;
        for (const w of line.words || []) {
          const str = (w.text || '').trim().replace(/\|/g, 'I'); // OCR often reads "I" as "|"
          if (!str || w.confidence < 10) continue;
          items.push({
            str, x: w.bbox.x0 / S, y: (img.height - base) / S,
            w: (w.bbox.x1 - w.bbox.x0) / S, h: Math.max(4, lh),
          });
        }
      }
      perPage[p] = buildLines(items, p, img.width);
      if (perPage[p].some((l) => END_OF_CHARGES.test(l.text))) stopAfter = Math.min(stopAfter, p);
      done++;
      if (onProgress) {
        const secs = (Date.now() - t0) / 1000;
        const left = Math.max(0, Math.round((secs / done) * (Math.min(stopAfter, n) - done) / Math.min(nWorkers, n)));
        onProgress(`Reading page ${done} of ${n} with OCR (${nWorkers} at a time)…${done < n && left ? ` about ${left}s left` : ''}`);
      }
    };

    try {
      await Promise.all(workers.map(async (worker) => {
        let pending = null; // next page already rendering while this one is recognized
        const take = () => (next <= Math.min(n, stopAfter) ? next++ : 0);
        let p = take();
        let img = p ? await render(p) : null;
        while (p) {
          const q = take();
          pending = q ? render(q) : null;
          await ocrPage(worker, p, img);
          p = q && q <= stopAfter ? q : 0;
          img = pending ? await pending : null;
          if (img && !p) img.free();
        }
      }));
    } finally {
      await Promise.all(workers.map((w) => w.terminate()));
    }
    const lines = [];
    for (let p = 1; p <= n; p++) if (perPage[p]) lines.push(...perPage[p]);
    return lines;
  }

  // ---------------------------------------------------------------------------
  // Cache: the same PDF uploaded again skips OCR completely (stored in this browser only)
  // ---------------------------------------------------------------------------

  const CACHE_VERSION = 2; // bump when the line format or OCR settings change
  function fingerprint(bytes) {
    let h = 0x811c9dc5; // FNV-1a over the whole file
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
    return `v${CACHE_VERSION}-${bytes.length}-${(h >>> 0).toString(16)}`;
  }
  function idb() {
    return new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      try {
        const req = indexedDB.open('finops-pdf-cache', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('lines');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }
  async function cacheGet(key) {
    const db = await idb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const r = db.transaction('lines').objectStore('lines').get(key);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }
  async function cachePut(key, value) {
    const db = await idb();
    if (!db) return;
    try {
      const store = db.transaction('lines', 'readwrite').objectStore('lines');
      store.put(value, key);
    } catch (_) { /* storage full or blocked: ignore */ }
  }

  /** Returns { lines, pages, ocr } in reading order. Falls back to OCR when there is no text layer. */
  async function extractLines(data, lib, onProgress, env = {}) {
    const doc = await lib.getDocument({ data, isEvalSupported: false }).promise;
    try {
      let lines = await textLines(doc, onProgress);
      let ocr = false;
      if (lines.length < doc.numPages * 3 && env.ocr !== false) {
        lines = await ocrLines(doc, onProgress, env);
        ocr = true;
      }
      return { lines, pages: doc.numPages, ocr };
    } finally {
      await doc.destroy();
    }
  }

  // ---------------------------------------------------------------------------
  // Line → cells (description | quantity | amount)
  // ---------------------------------------------------------------------------

  function cellsOf(line, cols) {
    let desc; let right;
    if (cols && cols.qtyX) {
      desc = joinItems(line.items.filter((i) => i.x < cols.qtyX - 4));
      right = joinItems(line.items.filter((i) => i.x >= cols.qtyX - 4));
    } else {
      desc = line.text; right = '';
    }
    let amount = null; let currency = null; let qty = right;
    let m = AMOUNT_END.exec(right);
    if (m) { amount = toNum(m[2]); currency = m[1]; qty = right.slice(0, m.index).trim(); }
    else if ((m = AMOUNT_END.exec(desc))) { amount = toNum(m[2]); currency = m[1]; desc = desc.slice(0, m.index).trim(); }
    return { desc, qty: qty.trim(), amount, currency };
  }

  function parseQty(text) {
    const m = /^(-?[\d,]*\d(?:\.\d+)?)\s*(.*)$/.exec((text || '').trim());
    if (!m) return { quantity: null, unit: (text || '').trim() };
    return { quantity: toNum(m[1]), unit: m[2].trim() };
  }

  // ---------------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------------

  function parseMeta(lines) {
    const all = lines.map((l) => l.text).join('\n');
    const meta = { period: '', month: null, accountId: '', grandTotal: null, preTaxTotal: null, totalTax: null, currency: 'USD', provider: '' };

    const p = /([A-Z][a-z]{2,8})\.?\s*(\d{1,2})(?:,\s*(\d{4}))?\s*[-–]\s*([A-Z][a-z]{2,8})\.?\s*(\d{1,2}),?\s*(\d{4})/.exec(all);
    if (p) {
      const mi = MONTHS.indexOf(p[1].slice(0, 3).toLowerCase());
      if (mi >= 0) {
        const year = p[3] || p[6];
        meta.month = `${year}-${String(mi + 1).padStart(2, '0')}`;
        meta.period = `${p[1]} ${p[2]} - ${p[4]} ${p[5]}, ${p[6]}`;
      }
    }
    if (!meta.month) {
      const iso = /(20\d{2})-(\d{2})-01\s*(?:to|-)\s*20\d{2}-\d{2}-\d{2}/.exec(all);
      if (iso) { meta.month = `${iso[1]}-${iso[2]}`; meta.period = iso[0]; }
    }
    const acct = /Account\s*ID[\s\S]{0,120}?\b(\d{12})\b/i.exec(all);
    if (acct) meta.accountId = acct[1];

    // Several seller sections each have their own "Total pre-tax" / "Total tax": add them up
    const sellers = [];
    for (const l of lines) {
      const m = AMOUNT_END.exec(l.text);
      if (!m) continue;
      if (/grand\s*total/i.test(l.text) && meta.grandTotal == null) meta.grandTotal = toNum(m[2]);
      else if (/total\s*pre-?tax/i.test(l.text)) {
        meta.preTaxTotal = r2((meta.preTaxTotal || 0) + toNum(m[2]));
        const name = l.text.replace(/\(\d+\)[\s\S]*$/, '').trim();
        if (name) sellers.push({ name, total: toNum(m[2]) });
      } else if (/^total\s*tax\b/i.test(l.text)) meta.totalTax = r2((meta.totalTax || 0) + toNum(m[2]));
      else if (/total\s*post-?tax/i.test(l.text) && meta.postTaxTotal == null) meta.postTaxTotal = toNum(m[2]);
      if (/^[uU]{0,2}[sS][dD]$/.test(m[1])) meta.currency = 'USD';
      else if (/^(INR|EUR|GBP|JPY|AUD|CAD|SGD)$/.test(m[1])) meta.currency = m[1];
    }
    meta.sellers = sellers;
    if (sellers.length) meta.provider = sellers.map((s) => s.name).join(' + ');
    else {
      const prov = lines.find((l) => /Amazon Web Services[^()]*?(Private Limited|Inc\.?|EMEA SARL|LLC|Ltd)/i.test(l.text));
      if (prov) meta.provider = (/(Amazon Web Services[^()]*?(?:Private Limited|Inc\.?|EMEA SARL|LLC|Ltd))/i.exec(prov.text) || [])[1] || '';
    }
    return meta;
  }

  // ---------------------------------------------------------------------------
  // AWS "Charges by service" parser
  // ---------------------------------------------------------------------------

  function parseAwsCharges(lines) {
    const start = lines.findIndex((l) => /^charges by service\b/i.test(l.text));
    if (start < 0) return null;

    let cols = null;
    const recs = [];
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      const t = l.text;
      // Bills can have several seller sections (e.g. "AWS Inc. - Marketplace" and "AWS India"), each ending
      // with its own "Total tax" line, so only the sections after all charges end the parse.
      if (/^(charges by account|invoices\b|taxes by service|savings\s*\(|tax invoices)/i.test(t)) break;
      if (/^total tax\b/i.test(t)) { recs.push({ type: 'break' }); continue; }
      // Seller header with its own pre-tax total, e.g. "Amazon Web Services India Private Limited (32) Total pre-tax USD 8,474.66"
      if (/\(\d+\)\s*total\s*pre-?tax/i.test(t)) { recs.push({ type: 'break' }); continue; }
      if (/\bdescription\b/i.test(t) && /usage\s*quantity/i.test(t)) {
        // Column starts at "Usage" (OCR splits "Usage Quantity" into two words)
        const qi = l.items.findIndex((it) => /quantity/i.test(it.str));
        let q = qi >= 0 ? l.items[qi] : l.items.find((it) => /usage/i.test(it.str));
        if (qi > 0 && /^usage$/i.test(l.items[qi - 1].str.trim())) q = l.items[qi - 1];
        if (q) cols = { qtyX: q.x };
        continue;
      }
      if (/total\s*pre-?tax/i.test(t)) continue;
      const c = Object.assign(cellsOf(l, cols), { page: l.page, y: l.y, h: l.h || 8 });
      if (c.amount == null) { recs.push({ type: 'cont', ...c }); continue; }
      if (REGION_LINE.test(c.desc)) recs.push({ type: 'region', ...c });
      else if (c.qty) recs.push({ type: 'rate', ...c });
      else recs.push({ type: 'node', ...c });
    }

    // A node whose next structural line is a region header is a service; otherwise a usage-type group.
    for (let i = 0; i < recs.length; i++) {
      if (recs[i].type !== 'node') continue;
      let j = i + 1;
      while (j < recs.length && (recs[j].type === 'cont' || recs[j].type === 'break')) j++;
      recs[i].type = j < recs.length && recs[j].type === 'region' ? 'service' : 'group';
    }

    const services = [];
    let svc = null; let region = ''; let group = null; let last = null;
    const ensureSvc = () => { if (!svc) { svc = { name: 'Other', total: 0, items: [] }; services.push(svc); } return svc; };
    const flushGroup = () => {
      if (group && group.children === 0 && group.cost !== 0) {
        ensureSvc().items.push({ service: svc.name, region, usageType: group.usageType, description: '', quantity: null, unit: '', cost: group.cost });
      }
      group = null;
    };

    for (const r of recs) {
      if (r.type === 'break') { flushGroup(); svc = null; region = ''; last = null; continue; }
      if (r.type === 'cont') {
        // Only a wrapped line directly below the previous row (ignores page headers/footers)
        if (!last || last.page !== r.page || last.y - r.y > r.h * 2.6 || last.y <= r.y) continue;
        last.y = r.y;
        if (r.desc) {
          if (last.kind === 'group') last.ref.usageType += ` ${r.desc}`;
          else if (last.kind === 'item') last.ref.description += ` ${r.desc}`;
        }
        if (r.qty && last.kind === 'item') {
          last.ref._qty = last.ref._qty.endsWith('-') ? last.ref._qty + r.qty : `${last.ref._qty} ${r.qty}`;
        }
        continue;
      }
      if (r.type === 'service') {
        flushGroup();
        svc = { name: r.desc, total: r.amount, items: [] };
        services.push(svc);
        region = ''; last = null;
      } else if (r.type === 'region') {
        flushGroup();
        region = r.desc; last = null;
      } else if (r.type === 'group') {
        flushGroup();
        group = { usageType: r.desc, cost: r.amount, children: 0 };
        last = { kind: 'group', ref: group, page: r.page, y: r.y };
      } else {
        const item = { service: ensureSvc().name, region, usageType: group ? group.usageType : '', description: r.desc, _qty: r.qty, cost: r.amount };
        svc.items.push(item);
        if (group) group.children++;
        last = { kind: 'item', ref: item, page: r.page, y: r.y };
      }
    }
    flushGroup();

    for (const s of services) {
      for (const it of s.items) {
        Object.assign(it, parseQty(it._qty));
        delete it._qty;
        it.description = it.description.trim();
        it.usageType = it.usageType.trim();
      }
      if (!s.total) s.total = r2(s.items.reduce((a, it) => a + it.cost, 0));
    }
    return services.length ? services : null;
  }

  /** Fallback for other invoice/annexure layouts: every "description … amount" line that is not a total. */
  function parseGeneric(lines) {
    const skip = /total|subtotal|sub-total|tax|gst|vat|igst|cgst|sgst|balance|payment|amount due|grand|credit|invoice|page \d|round/i;
    const map = new Map();
    for (const l of lines) {
      const m = AMOUNT_END.exec(l.text);
      if (!m) continue;
      const desc = l.text.slice(0, m.index).replace(/[\s:.-]+$/, '').trim();
      if (desc.length < 3 || skip.test(desc) || /^\d[\d\s,./-]*$/.test(desc)) continue;
      const amt = toNum(m[2]);
      if (amt == null) continue;
      map.set(desc, (map.get(desc) || 0) + amt);
    }
    return [...map.entries()].map(([name, total]) => ({ name, total: r2(total), items: [] }));
  }

  // ---------------------------------------------------------------------------
  // Dataset for the engine
  // ---------------------------------------------------------------------------

  const isInstanceHour = (it) => (/instance[\s-]*hour/i.test(it.description)
    // Reserved Instance recurring fee: "USD 0.20676 hourly fee per Linux/UNIX (Amazon VPC), r6a.2xlarge instance"
    || /hourly fee per .*\binstance\b/i.test(it.description)) && !/mbps|ebs|per gb/i.test(it.description);
  const isRiFee = (it) => /hourly fee per|reserved instances?/i.test(`${it.usageType} ${it.description}`);
  // OCR sometimes reads the "6" in r6a/m6i/c6g as "é"
  const fixOcrType = (s) => String(s || '').replace(/\b([a-z]{1,3})[éè]([a-z-]*\.\d*x?(?:nano|micro|small|medium|large|xlarge|metal))/gi, '$16$2');
  const osOf = (t) => (/windows/i.test(t) ? 'Windows' : /rhel|red hat/i.test(t) ? 'RHEL' : /suse/i.test(t) ? 'SUSE' : 'Linux');
  const pricingOf = (t) => (/savings\s*plan/i.test(t) ? 'Savings Plan' : /reserved/i.test(t) ? 'Reserved' : /spot/i.test(t) ? 'Spot' : 'On-Demand');
  const LINUX_SHARE_OF_WINDOWS = 0.56; // Savings Plans discount compute, not the Windows license

  /** Cost of the usage a Savings Plan / RI could cover, from line items. undefined = let the engine decide. */
  function eligibleCostOf(name, items) {
    const sum = (re, not) => r2(items.filter((i) => re.test(`${i.usageType} ${i.description}`) && !(not && not.test(`${i.usageType} ${i.description}`))).reduce((s, i) => s + i.cost, 0));
    if (!items.length) return undefined;
    if (/lambda/i.test(name)) return sum(/GB-?Second|Duration|Provisioned/i, /request/i);
    if (/dynamodb/i.test(name)) return sum(/RequestUnits|request units|PayPerRequest|ReadCapacity|WriteCapacity/i);
    if (/relational\s*database|\brds\b|aurora|elasticache|documentdb|neptune|opensearch|redshift/i.test(name)) return sum(/instance|InstanceUsage|NodeUsage|hour/i, /storage|backup|i\/o|iops/i);
    if (/sagemaker/i.test(name)) return sum(/ml\.|instance|hour/i, /storage/i);
    if (/fargate|elastic container/i.test(name)) return sum(/vCPU|GB-?Hours|Fargate/i, /storage/i);
    return undefined;
  }

  function toDataset(services, meta) {
    const month = meta.month || '';
    const rows = [];
    const lineItems = [];

    for (const s of services) {
      if (/elastic\s*compute\s*cloud|^ec2$|amazon\s*ec2/i.test(s.name)) {
        // Split like Cost Explorer: instance hours (commitment-eligible) vs EC2-Other (NAT, EBS, IPs…)
        const groups = new Map();
        let instCost = 0;
        for (const it of s.items) {
          it.description = fixOcrType(it.description);
          const t = `${it.usageType} ${it.description}`;
          if (isInstanceHour(it) && it.cost > 0) {
            const type = (INSTANCE_TYPE.exec(it.description) || [])[1] || '';
            const os = osOf(t); const pricing = isRiFee(it) ? 'Reserved' : pricingOf(t);
            const key = [type, it.region, os, pricing].join('|');
            const g = groups.get(key) || { type, region: it.region, os, pricing, cost: 0, hours: 0 };
            g.cost += it.cost; g.hours += it.quantity || 0;
            groups.set(key, g);
            instCost += it.cost;
            lineItems.push(Object.assign({}, it, { service: 'EC2-Instances' }));
          } else {
            lineItems.push(Object.assign({}, it, { service: 'EC2-Other' }));
          }
        }
        for (const g of groups.values()) {
          rows.push({
            Service: 'EC2-Instances', 'Instance Type': g.type, Region: g.region,
            'Usage Type': `${g.os} ${g.pricing} instance hours`, 'Usage Hours': r2(g.hours), 'Pricing Model': g.pricing,
            'Monthly Cost': r2(g.cost),
            // Spot and Reserved hours are not on-demand, so nothing to commit
            'Commitment Eligible Cost': g.pricing !== 'On-Demand' ? 0 : g.os === 'Windows' ? r2(g.cost * LINUX_SHARE_OF_WINDOWS) : r2(g.cost),
            'Billing Month': month,
          });
        }
        const other = r2(s.total - instCost);
        if (other > 0.004) rows.push({ Service: 'EC2-Other', 'Monthly Cost': other, 'Billing Month': month });
        continue;
      }
      const row = { Service: s.name, 'Monthly Cost': r2(s.total), 'Billing Month': month };
      const elig = eligibleCostOf(s.name, s.items);
      if (elig !== undefined) row['Commitment Eligible Cost'] = elig;
      rows.push(row);
      s.items.forEach((it) => lineItems.push(Object.assign({}, it)));
    }
    if (meta.totalTax > 0) rows.push({ Service: 'Tax', 'Monthly Cost': meta.totalTax, 'Billing Month': month });

    const headers = ['Service', 'Instance Type', 'Region', 'Usage Type', 'Usage Hours', 'Pricing Model', 'Monthly Cost', 'Commitment Eligible Cost', 'Billing Month']
      .filter((h) => rows.some((r) => r[h] !== undefined && r[h] !== ''));
    return { headers, rows, lineItems };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Parse already-extracted lines (pure, testable). */
  function parse(lines, pages) {
    if (!lines.length) {
      throw new Error('No readable text was found in this PDF, even with OCR. Try a sharper copy, or upload the CSV/Excel export instead.');
    }
    const meta = parseMeta(lines);
    let services = parseAwsCharges(lines);
    const layout = services ? 'aws-bill' : 'generic';
    if (!services) services = parseGeneric(lines);
    if (!services.length) throw new Error('No service charges were found in this PDF. Expected an AWS bill with a "Charges by service" section, or lines with a description and an amount.');

    const servicesTotal = r2(services.reduce((s, x) => s + (x.total || 0), 0));
    const expected = meta.preTaxTotal != null ? meta.preTaxTotal
      : meta.grandTotal != null ? r2(meta.grandTotal - (meta.totalTax || 0)) : null;
    const reconciled = expected != null ? Math.abs(expected - servicesTotal) <= Math.max(0.05, expected * 0.001) : null;

    const ds = toDataset(services, meta);
    return Object.assign(ds, {
      meta: Object.assign(meta, {
        layout, pages: pages || null, servicesTotal, expectedTotal: expected, reconciled,
        serviceCount: services.length, lineItemCount: ds.lineItems.length,
      }),
    });
  }

  /** Read a PDF ArrayBuffer/Uint8Array. `lib` can be injected (tests); otherwise pdf.js is loaded from the CDN. */
  async function read(data, onProgress, lib, env) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const key = fingerprint(bytes);
    const t0 = Date.now();
    let extracted = env && env.noCache ? null : await cacheGet(key);
    const cached = Boolean(extracted);
    if (cached && onProgress) onProgress('Same PDF as before: using the saved reading (no OCR needed)…');
    if (!extracted) {
      const pdfjs = lib || await loadPdfJs();
      try {
        // pdf.js may detach the buffer, so give it a copy and keep ours for the fingerprint
        extracted = await extractLines(new Uint8Array(bytes), pdfjs, onProgress, env || {});
      } catch (err) {
        if (err && err.name === 'PasswordException') throw new Error('This PDF is password-protected. Remove the password and upload it again.');
        throw err;
      }
      if (extracted.lines.length) cachePut(key, extracted);
    }
    const result = parse(extracted.lines, extracted.pages);
    result.meta.ocr = extracted.ocr;
    result.meta.cached = cached;
    result.meta.readSeconds = Math.round((Date.now() - t0) / 100) / 10;
    return result;
  }

  return { read, parse, extractLines, loadPdfJs, PDFJS_VERSION };
});
