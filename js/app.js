/* UI controller: file upload, sheet parsing, rendering and export. */
(function () {
  'use strict';

  const Engine = window.FinOpsEngine;
  const MAX_FILE_BYTES = 25 * 1024 * 1024;
  const ALLOWED_EXT = /\.(xlsx|xls|xlsm|csv|ods|pdf)$/i;

  const state = {
    workbook: null,
    fileName: '',
    sheetName: '',
    headers: [],
    rows: [],
    mapping: {},
    result: null,
    currency: localStorage.getItem('finops.currency') || 'USD',
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    fileInput: $('file-input'), dropzone: $('dropzone'), status: $('status'),
    results: $('results'), fileMeta: $('file-meta'), sheetPicker: $('sheet-picker'), sheetSelect: $('sheet-select'),
    summary: $('summary'), insights: $('insights'),
    chartCategory: $('chart-category'), chartService: $('chart-service'), chartRegion: $('chart-region'), chartEnv: $('chart-environment'),
    recBody: $('rec-body'), recCount: $('rec-count'), recEmpty: $('rec-empty'),
    fSearch: $('f-search'), fPriority: $('f-priority'), fCategory: $('f-category'), fSort: $('f-sort'),
    mapping: $('mapping'), mappingPanel: $('mapping-panel'), currency: $('currency'),
    spTerm: $('sp-term'), spCoverage: $('sp-coverage'), spCards: $('sp-cards'), spBody: $('sp-body'),
    spEmpty: $('sp-empty'), spServices: $('sp-services'), spPanel: $('sp-panel'),
    ec2Sp: $('ec2-sp'), ec2Cards: $('ec2-cards'), ec2Compare: $('ec2-compare'), ec2Guidance: $('ec2-guidance'), ec2Families: $('ec2-families'),
    svcBody: $('svc-body'), svcFoot: $('svc-foot'), svcEmpty: $('svc-empty'), svcShow: $('svc-show'),
    progress: $('progress'), progressBar: $('progress-bar'), statusHelp: $('status-help'),
    startPanel: $('start-panel'), startHeadline: $('start-headline'), startSub: $('start-sub'), quickWins: $('quick-wins'),
    resultTabs: $('result-tabs'), startVisual: $('start-visual'),
    tabFile: $('tab-file'), tabAws: $('tab-aws'), optFile: $('opt-file'), optAws: $('opt-aws'), tabAwsDot: $('tab-aws-dot'), tabAwsSub: $('tab-aws-sub'), doneProgress: $('done-progress'), fHideDone: $('f-hide-done'), toast: $('toast'),
    awsDot: $('aws-dot'), awsMsg: $('aws-connect-msg'), awsActions: $('aws-connect-actions'), awsSetup: $('aws-setup'),
    awsLookback: $('aws-lookback'), btnAwsAnalyze: $('btn-aws-analyze'), btnAwsVerify: $('btn-aws-verify'),
    awsTarget: $('aws-target'), awsAccount: $('aws-account'), awsAccountList: $('aws-account-list'), awsMode: $('aws-mode'),
    awsRole: $('aws-role'), awsExternalId: $('aws-external-id'), awsRoleFields: $('aws-role-fields'), awsExtFields: $('aws-ext-fields'),
    awsAccountHelp: $('aws-account-help'),
    spTools: document.querySelector('.sp-tools'), buySection: document.querySelector('.sp-buy'),
    finderResult: $('finder-result'), simPlan: $('sim-plan'), simX: $('sim-x'), simXOut: $('sim-x-out'),
    simReadout: $('sim-readout'), simChart: $('sim-chart'), buyPlan: $('buy-plan'),
    waterfall: $('waterfall'), roadmap: $('roadmap'), sourceBanner: $('source-banner'),
    famsrcAws: $('famsrc-aws'), famsrcBill: $('famsrc-bill'), priceCheck: $('price-check'), btnPriceCheck: $('btn-price-check'),
    priceManual: $('price-manual-input'), priceManualBox: $('price-manual'),
    spaType: $('spa-type'), spaFamily: $('spa-family'), spaFamilyList: $('spa-family-list'), spaRegion: $('spa-region'),
    spaCommit: $('spa-commit'), spaCommitBox: document.querySelector('.spa-commit'), spaCov: $('spa-cov'), spaCovOut: $('spa-cov-out'),
    spaCovBox: document.querySelector('.spa-cov'), spaLookback: $('spa-lookback'), spaRun: $('spa-run'), spaOut: $('spa-out'), spaTerm: $('spa-term'),
    comparePanel: $('compare-panel'), compareSub: $('compare-sub'), compareVerdict: $('compare-verdict'), compareCards: $('compare-cards'),
    compareReasons: $('compare-reasons'), compareHead: $('compare-head'), compareBody: $('compare-body'),
    familyPlan: $('family-plan'), familySummary: $('family-summary'), familyBody: $('family-body'), familyNotes: $('family-notes'),
    awsSources: $('aws-sources'), awsSourcesList: $('aws-sources-list'), awsSourcesSum: $('aws-sources-sum'),
    pdfPanel: $('pdf-panel'), pdfMeta: $('pdf-meta'), pdfCards: $('pdf-cards'), pdfBody: $('pdf-body'), pdfEmpty: $('pdf-empty'), pdfTop: $('pdf-top'),
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Safe element builder. Children that are strings become text nodes (no HTML injection). */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'style') node.setAttribute('style', v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function money(n, compact) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency', currency: state.currency,
        notation: compact ? 'compact' : 'standard',
        maximumFractionDigits: compact ? 1 : (state.currency === 'JPY' ? 0 : 2),
      }).format(n || 0);
    } catch (_) {
      return `${state.currency} ${(n || 0).toFixed(2)}`;
    }
  }

  function setStatus(msg, type) {
    els.status.textContent = msg || '';
    els.status.className = `status ${type || ''}`;
    if (type !== 'error') els.statusHelp.hidden = true;
    // Progress bar: determinate when the message says "page X of N", otherwise indeterminate while loading
    if (type === 'loading') {
      els.progress.hidden = false;
      const m = /page (\d+) of (\d+)/i.exec(msg || '');
      const ocr = /OCR/i.test(msg || '');
      if (m) {
        // Text pass is quick (first 10%); OCR pass gets the rest
        const frac = +m[1] / +m[2];
        els.progress.classList.remove('indeterminate');
        els.progressBar.style.width = `${Math.round((ocr ? 0.1 + frac * 0.9 : frac * 0.1) * 100)}%`;
      } else {
        els.progress.classList.add('indeterminate');
      }
    } else {
      els.progress.hidden = true;
      els.progressBar.style.width = '0%';
    }
  }

  /** Error with plain-language tips and one-click ways forward. */
  function showError(msg) {
    setStatus(msg, 'error');
    const tips = [];
    if (/cost column/i.test(msg)) tips.push('Your sheet needs a column with the cost of each row, for example "Monthly Cost" or "Unblended Cost". You can also pick it under Column mapping below.');
    else if (/pdf|ocr/i.test(msg)) tips.push('For AWS bills, download the PDF from Billing → Bills. A Cost Explorer CSV (group by Service) also works well.');
    else if (/unsupported/i.test(msg)) tips.push('Supported files: AWS bill PDF, Cost Explorer CSV, Cost and Usage Report, or an Excel list of resources.');
    else tips.push('Check that the file opens normally on your computer and has a header row.');
    const btn = (label, onClick, cls = 'btn btn-secondary btn-sm') => {
      const b = el('button', { type: 'button', class: cls }, label);
      b.addEventListener('click', onClick);
      return b;
    };
    els.statusHelp.replaceChildren(
      el('p', null, tips[0]),
      el('div', { class: 'status-help-actions' },
        btn('Choose another file', () => els.fileInput.click(), 'btn btn-primary btn-sm'),
        btn('Try sample data', loadSample),
        btn('Download template', downloadTemplate),
        state.headers.length ? btn('Open column mapping', () => setTab('data')) : null),
    );
    els.statusHelp.hidden = false;
  }

  let toastTimer;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600);
  }

  // ---- "Done" tracking (saved in this browser per file) ----
  const DONE_KEY = 'finops.done';
  let doneSet = new Set();
  try { doneSet = new Set(JSON.parse(localStorage.getItem(DONE_KEY) || '[]')); } catch (_) { /* ignore */ }
  const recKey = (r) => `${state.fileName}|${r.resourceId}|${r.category}|${r.title.replace(/·.*$/, '').trim()}`;
  const isDone = (r) => doneSet.has(recKey(r));
  function setDone(r, done) {
    if (done) doneSet.add(recKey(r)); else doneSet.delete(recKey(r));
    try { localStorage.setItem(DONE_KEY, JSON.stringify([...doneSet].slice(-2000))); } catch (_) { /* storage full or blocked */ }
  }

  // ---------------------------------------------------------------------------
  // File handling
  // ---------------------------------------------------------------------------

  function ensureXlsx() {
    if (typeof XLSX === 'undefined') {
      setStatus('The Excel parser (SheetJS) failed to load. Check your internet connection and reload the page.', 'error');
      return false;
    }
    return true;
  }

  async function handleFile(file) {
    if (!file) return;
    if (!ALLOWED_EXT.test(file.name)) { showError(`"${file.name}" is an unsupported file type.`); return; }
    if (file.size > MAX_FILE_BYTES) { showError('This file is larger than 25 MB. Filter it to one month or split it, then try again.'); return; }
    const isPdf = /\.pdf$/i.test(file.name);
    if (!isPdf && !ensureXlsx()) return;

    if (document.body.classList.contains('has-results')) window.scrollTo({ top: 0, behavior: 'smooth' });
    setStatus(`Reading ${file.name}…`, 'loading');
    els.dropzone.classList.add('busy');
    try {
      const buf = await file.arrayBuffer();
      if (isPdf) { await loadPdf(file.name, buf); return; }
      const wb = XLSX.read(buf, { type: 'array', cellDates: true });
      state.workbook = wb;
      state.fileName = file.name;

      // Default to the sheet with the most rows
      const best = wb.SheetNames
        .map((name) => ({ name, rows: XLSX.utils.decode_range(wb.Sheets[name]['!ref'] || 'A1:A1').e.r }))
        .sort((a, b) => b.rows - a.rows)[0];

      populateSheetPicker(wb.SheetNames, best.name);
      loadSheet(best.name);
    } catch (err) {
      console.error(err);
      showError(`We couldn't read ${file.name}. ${err.message}`);
    } finally {
      els.fileInput.value = '';
      els.dropzone.classList.remove('busy');
    }
  }

  async function loadPdf(name, buf) {
    if (!window.FinOpsPdf) throw new Error('PDF reader script is missing.');
    const parsed = await window.FinOpsPdf.read(buf, (msg) => setStatus(msg, 'loading'));
    state.workbook = null;
    state.fileName = name;
    state.sheetName = '';
    clearPdf();
    state.pdf = parsed;
    state.lineItems = parsed.lineItems;
    els.sheetPicker.hidden = true;
    setData(parsed.headers, parsed.rows);
    run();
  }

  // ---------------------------------------------------------------------------
  // One answer per month: prefer the most detailed file loaded for that month
  // ---------------------------------------------------------------------------

  /** How much detail a source has: higher = more accurate savings. */
  function sourceRank() {
    if (state.awsSource) return { kind: 'AWS account', rank: 4 };
    if (state.pdf) return { kind: 'Bill PDF', rank: 3 };
    if (state.mapping.lineItemType) return { kind: 'Cost and Usage Report', rank: 3 };
    if (state.reshaped) return { kind: 'Cost Explorer CSV', rank: 1 };
    return state.result && state.result.summary.level === 'resource' ? { kind: 'Resource list', rank: 2 } : { kind: 'Service totals', rank: 1 };
  }

  function captureSource() {
    const { kind, rank } = sourceRank();
    return {
      fileName: state.fileName, kind, rank,
      month: state.result.period.latestMonth, total: state.result.summary.totalCost,
      data: {
        headers: state.headers, rows: state.rows, mapping: Object.assign({}, state.mapping), reshaped: state.reshaped,
        lineItems: state.lineItems, pdf: state.pdf, aws: state.aws, awsSource: state.awsSource, sheetName: state.sheetName,
        workbook: state.workbook,
      },
    };
  }

  function registerSource(src) {
    if (!src.month) return;
    state.sources = state.sources || new Map();
    state.sources.delete(src.fileName);
    state.sources.set(src.fileName, src);
  }

  function bestSourceFor(cur) {
    // Only replace service-level summaries (e.g. Cost Explorer CSV); resource lists carry different detail (CPU etc.)
    if (!cur.month || cur.rank > 1 || !state.sources) return null;
    const same = [...state.sources.values()].filter((s) => s.fileName !== cur.fileName && s.month === cur.month
      && s.rank > cur.rank && Math.abs(s.total - cur.total) <= Math.max(1, cur.total * 0.02));
    // Highest rank wins; among equals the most recently loaded (Map keeps insertion order)
    return same.reverse().sort((a, b) => b.rank - a.rank)[0] || null;
  }

  function applySource(src) {
    const d = src.data;
    state.fileName = src.fileName;
    state.headers = d.headers; state.rows = d.rows; state.mapping = Object.assign({}, d.mapping); state.reshaped = d.reshaped;
    state.lineItems = d.lineItems; state.pdf = d.pdf; state.aws = d.aws; state.awsSource = d.awsSource;
    state.sheetName = d.sheetName; state.workbook = d.workbook;
    els.sheetPicker.hidden = !d.workbook || d.workbook.SheetNames.length < 2;
  }

  function renderSourceBanner() {
    const v = state.viewingInstead;
    const showOwn = state.ownView && state.ownViewOf;
    els.sourceBanner.hidden = !v && !showOwn;
    if (els.sourceBanner.hidden) return;
    const btn = (label, fn) => { const b = el('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, label); b.addEventListener('click', fn); return b; };
    if (v) {
      els.sourceBanner.replaceChildren(
        el('span', { class: 'sb-icon', 'aria-hidden': 'true' }, 'ℹ'),
        el('div', null,
          el('strong', null, `Showing "${v.used.fileName}" (${v.used.kind}) for ${v.used.month}. `),
          `You uploaded "${v.original.fileName}" (${v.original.kind}) for the same month and total. The ${v.used.kind} has more detail (usage line items and existing RI/SP coverage), so both uploads now give the same result.`),
        btn(`Show ${v.original.kind} on its own`, () => {
          state.ownView = true; state.ownViewOf = v; state.viewingInstead = null;
          applySource(v.original);
          run(true);
        }));
    } else {
      const o = state.ownViewOf;
      els.sourceBanner.replaceChildren(
        el('span', { class: 'sb-icon warn', 'aria-hidden': 'true' }, '!'),
        el('div', null,
          el('strong', null, `Showing "${o.original.fileName}" on its own. `),
          `It has less detail than "${o.used.fileName}", so its savings differ (see "Why this differs" below).`),
        btn(`Use ${o.used.kind} instead`, () => {
          state.ownView = false; state.ownViewOf = null;
          applySource(o.original);
          run(true);
        }));
    }
  }

  function clearPdf() {
    state.ownView = false; state.ownViewOf = null; state.viewingInstead = null;
    state.pdf = null;
    state.lineItems = null;
    state.aws = null; // AWS data belongs to the previous source; "Check this file with AWS" fetches it again
    state.awsSource = false;
    state.awsTargetParams = null;
  }

  // ---------------------------------------------------------------------------
  // Live AWS data (local connector)
  // ---------------------------------------------------------------------------

  const Aws = window.FinOpsAws;

  async function checkConnector() {
    const s = Aws ? await Aws.status() : null;
    state.awsStatus = s;
    state.awsChecked = true;
    const set = (cls, msg) => {
      els.awsDot.className = `aws-dot ${cls}`; els.tabAwsDot.className = `aws-dot ${cls}`;
      els.awsMsg.textContent = msg;
      els.tabAwsSub.textContent = cls === 'on' ? `Connected · ${s.account}` : cls === 'warn' ? 'Sign-in needed' : 'Live data · needs a 2-minute setup';
    };
    if (!s) {
      set('off', 'Not connected. You are seeing estimates based on typical AWS discounts. Connect to get AWS\'s own Savings Plan and rightsizing numbers for your account.');
      els.awsActions.hidden = true; els.awsSetup.hidden = false;
    } else if (!s.connected) {
      set('warn', `The connector is running but could not sign in to AWS (profile "${s.profile}"): ${s.message}. Sign in with "aws sso login" or "aws configure", then reload.`);
      els.awsActions.hidden = true; els.awsSetup.hidden = false;
    } else {
      set('on', `Signed in to AWS account ${s.account} (profile "${s.profile}"). Enter another account ID to analyze it instead. A full analysis makes about 10 Cost Explorer requests (about $0.10); results are cached for 6 hours.`);
      els.awsActions.hidden = false; els.awsSetup.hidden = true; els.awsTarget.hidden = false;
      if (!state.result) setStartTab('aws'); // connected: live data is the better starting point
      restoreTarget();
      updateTargetHelp();
      // Organization member accounts for the picker (free; empty unless signed in to the management account)
      Aws.accounts().then((list) => {
        els.awsAccountList.replaceChildren(...list.map((a) => el('option', { value: a.id }, a.name)));
        if (list.length) els.awsAccount.placeholder = `Pick one of ${list.length} Organization accounts or type an ID`;
      });
    }
    updateVerifyButton();
  }

  // ---- Target account (ID, access method, role) ----
  const TARGET_KEY = 'finops.awsTarget';
  function restoreTarget() {
    try {
      const t = JSON.parse(localStorage.getItem(TARGET_KEY) || '{}');
      if (t.account) els.awsAccount.value = t.account;
      if (t.mode) els.awsMode.value = t.mode;
      if (t.role) els.awsRole.value = t.role;
    } catch (_) { /* ignore */ }
  }
  function saveTarget() {
    // The external ID is a shared secret: kept in the field only, never stored
    try { localStorage.setItem(TARGET_KEY, JSON.stringify({ account: els.awsAccount.value.trim(), mode: els.awsMode.value, role: els.awsRole.value.trim() })); } catch (_) { /* ignore */ }
  }
  const cleanAccount = () => els.awsAccount.value.replace(/[\s-]/g, '');

  function updateTargetHelp() {
    const s = state.awsStatus;
    const acct = cleanAccount();
    const other = acct && s && acct !== s.account;
    const mode = els.awsMode.value;
    const useRole = mode === 'role';
    els.awsRoleFields.hidden = !useRole;
    els.awsExtFields.hidden = !useRole;
    let msg;
    if (acct && !/^\d{12}$/.test(acct)) msg = 'An AWS account ID is 12 digits.';
    else if (!other) msg = `Analyzes the account you are signed in to (${s ? s.account : '…'}).`;
    else if (useRole) msg = `Uses the read-only role "${els.awsRole.value || 'CloudLensFinOpsReadOnly'}" in ${acct}. Its owner deploys server/cross-account-role.yaml in CloudFormation with your account ID ${s.account} as the trusted account and the same external ID.`;
    else if (mode === 'linked') msg = `Reads ${acct}'s costs through your Organization. You must be signed in to the management (payer) account, and ${acct} must be a member.`;
    else msg = `Will use the Organization (payer) view for ${acct}. If it is not in your Organization, choose "Cross-account role".`;
    els.awsAccountHelp.textContent = msg;
    els.btnAwsAnalyze.textContent = other ? `Analyze account ${acct}` : 'Analyze my AWS account';
    els.btnAwsAnalyze.disabled = Boolean(acct) && !/^\d{12}$/.test(acct);
  }

  function targetParams() {
    const acct = cleanAccount();
    return {
      account: acct, mode: els.awsMode.value,
      role: els.awsMode.value === 'role' ? els.awsRole.value.trim() : '',
      externalId: els.awsMode.value === 'role' ? els.awsExternalId.value.trim() : '',
    };
  }

  function updateVerifyButton() {
    const connected = state.awsStatus && state.awsStatus.connected;
    els.btnAwsVerify.hidden = !(connected && state.result && !state.awsSource);
    $('btn-verify-top').hidden = els.btnAwsVerify.hidden || Boolean(state.aws);
    if (state.result) renderPriceCheckIdle(); // connection status may arrive after the results
  }

  async function fetchAws(refresh) {
    // Keep asking for the same account that the current results belong to
    const target = state.awsTargetParams || targetParams();
    return Aws.analysis(Object.assign({ term: els.spTerm.value, lookback: parseInt(els.awsLookback.value, 10), months: 3, refresh }, target));
  }

  /** Use Cost Explorer as the data source (no file needed). */
  async function analyzeAwsAccount() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setStatus('Asking AWS Cost Explorer and Cost Optimization Hub… this can take 10-30 seconds.', 'loading');
    els.btnAwsAnalyze.disabled = true;
    saveTarget();
    try {
      state.awsTargetParams = targetParams();
      const data = await fetchAws(false);
      const ds = Aws.toDataset(data);
      state.workbook = null;
      state.fileName = `AWS account ${(data.target && data.target.account) || state.awsStatus.account}`;
      state.sheetName = '';
      state.pdf = null;
      state.ownView = false; state.ownViewOf = null; state.viewingInstead = null;
      state.lineItems = ds.lineItems;
      state.aws = data;
      state.awsSource = true;
      els.sheetPicker.hidden = true;
      setData(ds.headers, ds.rows);
      run();
      toast(`Fetched from AWS with ${data.apiCalls.costExplorerThisRequest} billed Cost Explorer request(s).`);
    } catch (err) {
      state.awsTargetParams = null;
      showError(`AWS request failed. ${err.message}`);
    } finally {
      updateTargetHelp();
    }
  }

  /** Keep the uploaded data, but replace estimates with AWS recommendations. */
  async function verifyWithAws() {
    setStatus('Getting Savings Plan and rightsizing recommendations from AWS…', 'loading');
    els.btnAwsVerify.disabled = true;
    saveTarget();
    try {
      // A bill PDF knows its account: use it if no account was typed
      const billAcct = state.pdf && state.pdf.meta && state.pdf.meta.accountId;
      state.awsTargetParams = targetParams();
      if (!state.awsTargetParams.account && billAcct) state.awsTargetParams.account = billAcct;
      state.aws = await fetchAws(false);
      const analyzed = state.aws.target ? state.aws.target.account : state.awsStatus.account;
      run(false);
      if (billAcct && analyzed !== billAcct) {
        toast(`Note: this bill is for account ${billAcct}, but AWS data is for ${analyzed}.`);
      } else toast('Estimates replaced with AWS recommendations where available.');
    } catch (err) {
      showError(`AWS request failed. ${err.message}`);
    } finally {
      els.btnAwsVerify.disabled = false;
    }
  }

  function renderAwsSources() {
    const data = state.aws;
    els.awsSources.hidden = !data;
    if (!data) return;
    const list = Aws.sources(data);
    const okCount = list.filter((s) => s.ok).length;
    els.awsSourcesSum.textContent = `${okCount} of ${list.length} sources loaded · ${data.apiCalls.costExplorerThisRequest} billed request(s) · ${new Date(data.generatedAt).toLocaleString()}`;
    els.awsSourcesList.replaceChildren(...list.map((s) => el('li', { class: s.ok ? 'ok' : 'fail' },
      el('span', { class: 'src-icon', 'aria-hidden': 'true' }, s.ok ? '✓' : '!'),
      el('span', null, el('strong', null, s.name), s.note ? el('span', { class: 'muted' }, ` · ${s.note}`) : null))));
  }

  function populateSheetPicker(names, selected) {
    els.sheetSelect.replaceChildren(...names.map((n) => el('option', { value: n, selected: n === selected }, n)));
    els.sheetPicker.hidden = names.length < 2;
  }

  /** Find the header row (some exports have title rows above the table). */
  function findHeaderRow(aoa) {
    const limit = Math.min(aoa.length, 20);
    for (let i = 0; i < limit; i++) {
      const cells = (aoa[i] || []).map((c) => (c == null ? '' : String(c)));
      if (cells.filter(Boolean).length < 2) continue;
      if (Engine.detectColumns(cells).cost) return i;
    }
    return aoa.findIndex((r) => (r || []).filter((c) => c != null && c !== '').length >= 2);
  }

  function loadSheet(name) {
    const ws = state.workbook.Sheets[name];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true, blankrows: false });
    const hIdx = findHeaderRow(aoa);
    if (hIdx < 0) { showError(`Sheet "${name}" looks empty. Pick another sheet or file.`); return; }

    // Build unique, non-empty headers
    const seen = {};
    const headers = (aoa[hIdx] || []).map((h, i) => {
      // Date-typed headers (month columns) become YYYY-MM-DD using local date parts
      if (Object.prototype.toString.call(h) === '[object Date]' && !isNaN(h)) h = `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-${String(h.getDate()).padStart(2, '0')}`;
      let label = h == null || String(h).trim() === '' ? `Column ${i + 1}` : String(h).replace(/^\uFEFF/, '').trim();
      if (seen[label]) label = `${label} (${++seen[label]})`; else seen[label] = 1;
      return label;
    });
    const rows = aoa.slice(hIdx + 1).map((arr) => {
      const o = {};
      headers.forEach((h, i) => { o[h] = arr[i] == null ? null : arr[i]; });
      return o;
    });

    state.sheetName = name;
    clearPdf();
    setData(headers, rows);
    run();
  }

  /** Reshape known export layouts (e.g. Cost Explorer wide CSV) and detect columns. */
  function setData(headers, rows) {
    const prepared = Engine.prepare(headers, rows);
    state.headers = prepared.headers;
    state.rows = prepared.rows;
    state.reshaped = prepared.reshaped;
    state.mapping = Engine.detectColumns(prepared.headers);
  }

  function loadSample() {
    const rows = window.FINOPS_SAMPLE.map((r) => Object.assign({}, r));
    const headers = [...new Set(rows.flatMap(Object.keys))];
    state.workbook = null;
    state.fileName = 'Sample data';
    state.sheetName = '';
    clearPdf();
    setData(headers, rows);
    els.sheetPicker.hidden = true;
    run();
  }

  // ---------------------------------------------------------------------------
  // Analysis
  // ---------------------------------------------------------------------------

  function run(scroll = true) {
    els.results.hidden = false;
    renderMapping();
    try {
      state.result = Engine.analyze(state.headers, state.rows, {
        mapping: state.mapping,
        term: els.spTerm.value,
        targetCoverage: els.spCoverage.value ? parseFloat(els.spCoverage.value) : undefined,
        lineItems: state.lineItems || undefined,
        aws: state.aws || undefined,
      });
      const s = state.result.summary;
      const noun = s.level === 'service' ? 'services' : 'resources';
      const pm = state.pdf && state.pdf.meta;
      const checked = s.level === 'service' ? `${s.serviceCount} services` : `${s.resourceCount} ${noun}`;
      let msg = `Done. We checked ${checked} and found ${s.recommendationCount} ways to save.`;
      document.body.classList.add('has-results');
      if (scroll) state.tab = 'overview'; // new data opens on the overview
      rememberForCompare();

      // Same month already loaded from a more detailed file (e.g. the bill PDF)? Use that, so both uploads agree.
      if (scroll && !state.applyingSource) {
        const cur = captureSource();
        registerSource(cur);
        state.viewingInstead = null;
        const better = state.ownView ? null : bestSourceFor(cur);
        if (better) {
          state.viewingInstead = { original: cur, used: better };
          applySource(better);
          state.applyingSource = true;
          try { run(scroll); } finally { state.applyingSource = false; }
          return;
        }
      }
      renderSourceBanner();
      let type = 'ok';
      if (pm) {
        if (pm.cached) msg += ' Read instantly (same PDF as before).';
        else if (pm.readSeconds) msg += ` PDF read in ${pm.readSeconds}s.`;
        if (pm.reconciled === true) msg += ` PDF services total ${money(pm.servicesTotal)} matches the bill total.`;
        else if (pm.reconciled === false) { msg += ` Check: parsed services total ${money(pm.servicesTotal)} differs from the bill total ${money(pm.expectedTotal)}.`; type = 'warn'; }
        if (pm.layout === 'generic') { msg += ' Generic PDF layout: verify the extracted lines below.'; type = 'warn'; }
      }
      setStatus(msg, type);
      const p = state.result.period;
      if (state.aws) msg += state.awsSource ? ' Data and recommendations are from AWS.' : ' Estimates replaced with AWS recommendations where available.';
      els.fileMeta.textContent = [
        state.fileName,
        state.sheetName ? `sheet "${state.sheetName}"` : '',
        pm ? `${pm.layout === 'aws-bill' ? 'AWS bill PDF' : 'PDF'}${pm.period ? ` · ${pm.period}` : ''}${pm.accountId ? ` · account ${pm.accountId}` : ''}`
          : state.reshaped ? 'Cost Explorer export detected' : `${state.rows.length} rows`,
        p.latestMonth ? `month ${p.latestMonth}` : '',
      ].filter(Boolean).join(' · ');
      renderAll();
    } catch (err) {
      state.result = null;
      showError(err.message);
      clearResults();
      state.tab = 'data';
      renderTabs();
      updateVerifyButton();
    }
    if (scroll) els.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function clearResults() {
    [els.summary, els.insights, els.chartCategory, els.chartService, els.chartRegion, els.chartEnv, els.recBody,
      els.spCards, els.spBody, els.spServices, els.svcBody, els.svcFoot,
      els.quickWins, els.startHeadline, els.startSub, els.doneProgress, els.startVisual, els.waterfall, els.roadmap].forEach((n) => n.replaceChildren());
    els.recCount.textContent = '';
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function renderAll() {
    const r = state.result;
    renderSummary(r.summary);
    els.insights.replaceChildren(...r.insights.map((i) => el('li', { class: i.level }, i.text)));

    const cats = Object.entries(r.summary.byCategory)
      .map(([label, v]) => ({ label, value: v.savings, sub: `${v.count}` }))
      .filter((c) => c.value > 0)
      .sort((a, b) => b.value - a.value);
    renderBars(els.chartCategory, cats, 'No savings opportunities found.', true);
    renderBars(els.chartService, r.breakdowns.service, 'Map a Service column to see this.');
    renderBars(els.chartRegion, r.breakdowns.region, 'Map a Region column to see this.');
    renderBars(els.chartEnv, r.breakdowns.environment, 'Map an Environment column to see this.');

    const categories = [...new Set(r.recommendations.map((x) => x.category))].sort();
    const current = els.fCategory.value;
    els.fCategory.replaceChildren(
      el('option', { value: '' }, 'All categories'),
      ...categories.map((c) => el('option', { value: c, selected: c === current }, c)),
    );
    renderTable();
    renderCommitments(r.commitments);
    renderServiceSavings();
    renderPdf();
    renderStart();
    renderCompare();
    renderWaterfall(r);
    renderRoadmap(r);
    renderAwsSources();
    renderTabs();
    updateVerifyButton();
  }

  // ---------------------------------------------------------------------------
  // Compare two files of the same month (e.g. bill PDF vs Cost Explorer CSV)
  // ---------------------------------------------------------------------------

  /** Same service, different names: "S3" vs "Simple Storage Service", "Claude Haiku 4.5 ( Bedrock Edition)" vs "...(Amazon Bedrock Edition)". */
  const SERVICE_ALIASES = {
    s3: 'simplestorageservice', vpc: 'virtualprivatecloud', ses: 'simpleemailservice', sns: 'simplenotificationservice',
    sqs: 'simplequeueservice', rds: 'relationaldatabaseservice', eks: 'elasticcontainerserviceforkubernetes',
    elastickubernetesservice: 'elasticcontainerserviceforkubernetes', ec2containerregistryecr: 'ec2containerregistry',
    elasticcontainerregistry: 'ec2containerregistry', ec2instances: 'ec2instances', elasticcomputecloudcompute: 'ec2instances',
    ec2other: 'ec2other', kms: 'keymanagementservice', elb: 'elasticloadbalancing', cloudwatchevents: 'cloudwatchevents',
  };
  const canon = (name) => {
    const k = String(name || '').toLowerCase().replace(/\(\$\)|amazon|aws/g, '').replace(/[^a-z0-9]/g, '');
    return SERVICE_ALIASES[k] || k;
  };
  const sourceKind = () => (state.pdf ? 'Bill PDF' : state.awsSource ? 'AWS account' : state.reshaped ? 'Cost Explorer CSV' : 'Spreadsheet');

  function snapshot() {
    const r = state.result;
    const bySvc = new Map();
    for (const s of r.serviceSavings) {
      const k = canon(s.service);
      const e = bySvc.get(k) || { name: s.service, cost: 0, savings: 0 };
      e.cost += s.cost; e.savings += s.totalSavings;
      bySvc.set(k, e);
    }
    const c = r.commitments;
    return {
      fileName: state.fileName, kind: sourceKind(), month: r.period.latestMonth,
      total: r.summary.totalCost, savings: r.summary.totalSavings, recs: r.summary.recommendationCount,
      coverage: c ? c.coverage.currentPct : 0, spSavings: c ? c.totals.monthlySavings : 0, spHourly: c ? c.totals.hourlyCommitment : 0,
      lineItems: Boolean(state.lineItems && state.lineItems.length), pricing: Boolean(state.mapping.pricingModel || state.mapping.lineItemType || state.pdf),
      bySvc,
    };
  }

  function rememberForCompare() {
    const now = snapshot();
    state.snaps = state.snaps || new Map();
    state.snaps.delete(now.fileName);
    state.snaps.set(now.fileName, now); // Map order = most recent last
    // Most recent other file for the same month with roughly the same total
    state.compare = [...state.snaps.values()].reverse().find((s) => s.fileName !== now.fileName && s.month === now.month
      && Math.abs(s.total - now.total) <= Math.max(1, now.total * 0.05)) || null;
    if (!state.current || state.current.fileName !== now.fileName) state.compareHidden = false;
    state.current = now;
  }

  function renderCompare() {
    const a = state.compare; const b = state.current;
    els.comparePanel.hidden = !a || !b || state.compareHidden;
    if (els.comparePanel.hidden) return;
    const pdfSide = b.kind === 'Bill PDF' ? b : a.kind === 'Bill PDF' ? a : null;
    const csvSide = pdfSide === b ? a : b;
    els.compareSub.textContent = `${b.kind} "${b.fileName}" vs ${a.kind} "${a.fileName}" · both ${b.month}`;

    const col = (x) => el('div', { class: 'cmp-col' },
      el('div', { class: 'cmp-name' }, el('strong', null, x.kind), el('span', { class: 'muted' }, x.fileName)),
      el('div', { class: 'kv' }, el('span', null, 'Monthly total'), el('strong', null, money(x.total))),
      el('div', { class: 'kv' }, el('span', null, 'Possible savings'), el('strong', { class: 'savings' }, money(x.savings))),
      el('div', { class: 'kv' }, el('span', null, 'Recommendations'), el('strong', null, String(x.recs))),
      el('div', { class: 'kv' }, el('span', null, 'RI / SP coverage seen'), el('strong', null, x.pricing ? `${x.coverage.toFixed(0)}%` : 'not in file')),
      el('div', { class: 'kv' }, el('span', null, 'New Savings Plans'), el('strong', null, `${money(x.spHourly)}/hr · ${money(x.spSavings)}/mo`)),
      el('div', { class: 'kv' }, el('span', null, 'Detail level'), el('strong', null, x.lineItems ? 'Usage line items' : 'Service totals')));
    els.compareCards.replaceChildren(col(b), col(a));

    // Plain-language reasons, largest effect first
    const reasons = [];
    const totalDiff = Math.abs(a.total - b.total);
    reasons.push(totalDiff < Math.max(1, b.total * 0.001)
      ? `Totals match (${money(a.total)} vs ${money(b.total)}); the difference of ${money(totalDiff)} is rounding.`
      : `Totals differ by ${money(totalDiff)}. Check both files are for the same account and month.`);
    if (pdfSide && !csvSide.pricing && pdfSide.coverage > 5) {
      reasons.push(`The bill shows ${pdfSide.coverage.toFixed(0)}% of eligible spend is already covered by Reserved Instances / Savings Plans. The ${csvSide.kind} has no pricing information, so it treats everything as on-demand and suggests ${money(csvSide.spHourly)}/hr of new Savings Plans (${money(csvSide.spSavings)}/mo) versus ${money(pdfSide.spHourly)}/hr from the bill. Buying the larger amount would pay twice for usage your RIs already cover.`);
    }
    const dtA = a.bySvc.get('datatransfer'); const dtB = b.bySvc.get('datatransfer');
    if (Boolean(dtA) !== Boolean(dtB)) {
      const dt = dtA || dtB;
      reasons.push(`The bill lists Data Transfer (${money(dt.cost)}) as its own service; Cost Explorer adds it to EC2-Other, Elastic Load Balancing, S3 and others. Same money, different place, so those services and their recommendations look different (e.g. "Reduce cross-AZ traffic" vs "Reduce EC2-Other").`);
    }
    if (a.lineItems !== b.lineItems) {
      const li = a.lineItems ? a : b;
      reasons.push(`The ${li.kind} has usage line items (quantities and charges per usage type), so savings are calculated from the actual usage (${li.recs} specific actions). The other file only has one total per service, so it uses typical percentages (${(li === a ? b : a).recs} broader actions).`);
    }
    els.compareReasons.replaceChildren(...reasons.map((t) => el('li', null, t)));

    const better = pdfSide || (a.lineItems ? a : b.lineItems ? b : null);
    els.compareVerdict.replaceChildren(better
      ? el('p', null, el('strong', null, `Use the ${better.kind} result (${money(better.savings)}/mo). `),
        'It is based on more detailed data', pdfSide ? ' and knows which usage is already covered by your commitments.' : '.')
      : el('p', null, 'Both files have similar detail; differences come from how each groups services.'));

    // Service table
    const keys = [...new Set([...a.bySvc.keys(), ...b.bySvc.keys()])]
      .map((k) => ({ k, a: a.bySvc.get(k), b: b.bySvc.get(k) }))
      .sort((x, y) => Math.max(y.a ? y.a.cost : 0, y.b ? y.b.cost : 0) - Math.max(x.a ? x.a.cost : 0, x.b ? x.b.cost : 0))
      .filter((x) => Math.max(x.a ? x.a.cost : 0, x.b ? x.b.cost : 0) >= 0.5);
    els.compareHead.replaceChildren(el('tr', null,
      el('th', { scope: 'col' }, 'Service'),
      el('th', { scope: 'col', class: 'num' }, `${b.kind} cost`), el('th', { scope: 'col', class: 'num' }, `${a.kind} cost`),
      el('th', { scope: 'col', class: 'num' }, `${b.kind} savings`), el('th', { scope: 'col', class: 'num' }, `${a.kind} savings`),
      el('th', { scope: 'col' }, 'Why different')));
    const why = (x) => {
      const ca = x.a ? x.a.cost : 0; const cb = x.b ? x.b.cost : 0;
      if (x.k === 'datatransfer') return 'Only the bill shows it separately';
      if (Math.abs(ca - cb) > Math.max(1, Math.max(ca, cb) * 0.02)) {
        if (/ec2other|elasticloadbalancing|simplestorageservice|cloudfront|natgateway/.test(x.k) && (dtA || dtB)) return 'Cost Explorer includes data transfer here';
        if (x.k === 'ec2instances') return 'RI fees are split differently';
        return 'Grouped differently';
      }
      const sa = x.a ? x.a.savings : 0; const sb = x.b ? x.b.savings : 0;
      if (Math.abs(sa - sb) > 1) return x.k === 'ec2instances' ? 'Existing RI coverage / usage detail' : 'Usage detail vs typical %';
      return '';
    };
    els.compareBody.replaceChildren(...keys.map((x) => el('tr', null,
      el('td', null, (x.b || x.a).name),
      el('td', { class: 'num' }, x.b ? money(x.b.cost) : '—'), el('td', { class: 'num' }, x.a ? money(x.a.cost) : '—'),
      el('td', { class: 'num savings' }, x.b && x.b.savings > 0 ? money(x.b.savings) : '—'), el('td', { class: 'num savings' }, x.a && x.a.savings > 0 ? money(x.a.savings) : '—'),
      el('td', { class: 'muted' }, why(x)))));
  }

  /** Plain-language headline and the 3 biggest actions, so users know where to begin. */
  function renderStart() {
    const r = state.result;
    const s = r.summary;
    if (s.totalSavings <= 0) {
      els.startHeadline.textContent = 'Good news: we did not find obvious savings in this file.';
      els.startSub.textContent = 'Adding CPU usage, environment or pricing columns lets us look deeper.';
      els.quickWins.replaceChildren();
      els.startVisual.replaceChildren();
      return;
    }
    renderStartVisual(s);
    els.startHeadline.replaceChildren(
      'You could save ', el('strong', { class: 'savings' }, money(s.totalSavings)), ' a month ',
      el('span', { class: 'muted' }, `(${s.savingsPct.toFixed(0)}% of ${money(s.totalCost)})`),
      ', about ', el('strong', null, money(s.annualSavings)), ' a year.');
    const quick = r.recommendations.filter((x) => x.effort === 'Low' && x.monthlySavings > 0);
    const quickSum = quick.reduce((a, x) => a + x.monthlySavings, 0);
    els.startSub.textContent = quick.length
      ? `${quick.length} of these are quick wins (low effort) worth ${money(quickSum)}/mo. Start with the three below.`
      : 'Start with the three biggest opportunities below.';

    const top = r.recommendations.filter((x) => x.monthlySavings > 0)
      .sort((a, b) => b.monthlySavings - a.monthlySavings).slice(0, 3);
    els.quickWins.replaceChildren(...top.map((x, i) => {
      const btn = el('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, 'See how →');
      btn.addEventListener('click', () => showRec(x));
      return el('li', { class: `quick-win${isDone(x) ? ' done' : ''}` },
        el('span', { class: 'qw-rank', 'aria-hidden': 'true' }, String(i + 1)),
        el('div', { class: 'qw-body' },
          el('div', { class: 'qw-title' }, x.title.replace(/ · \d.*$/, '')),
          el('div', { class: 'res-meta' }, `${x.service || x.resourceId} · ${x.effort} effort`)),
        el('div', { class: 'qw-save' }, el('strong', { class: 'savings' }, money(x.monthlySavings)), el('span', { class: 'muted' }, '/mo')),
        btn);
    }));
  }

  // ---------------------------------------------------------------------------
  // Savings breakdown (waterfall) and roadmap
  // ---------------------------------------------------------------------------

  const CATEGORY_ORDER = ['Waste Elimination', 'Rightsizing', 'Scheduling', 'Storage Optimization', 'Modernization', 'Commitment Discounts', 'Savings Plans', 'Reserved Instances', 'Governance'];

  function renderWaterfall(r) {
    const s = r.summary;
    const cats = Object.entries(s.byCategory).filter(([, v]) => v.savings > 0)
      .sort((a, b) => (CATEGORY_ORDER.indexOf(a[0]) + 1 || 99) - (CATEGORY_ORDER.indexOf(b[0]) + 1 || 99));
    if (!cats.length || s.totalCost <= 0) { els.waterfall.replaceChildren(el('p', { class: 'muted empty' }, 'No savings found.')); return; }
    const pct = (v) => `${Math.max(0, (v / s.totalCost) * 100).toFixed(2)}%`;
    const row = (label, left, width, value, cls, sub) => el('div', { class: `wf-row ${cls}` },
      el('span', { class: 'wf-label' }, label, sub ? el('small', null, sub) : null),
      el('span', { class: 'wf-track' }, el('span', { class: 'wf-bar', style: `left:${pct(left)};width:${pct(width)}` })),
      el('span', { class: 'wf-value' }, value));
    let remaining = s.totalCost;
    const rows = [row('Today', 0, s.totalCost, money(s.totalCost), 'wf-total', 'monthly bill')];
    for (const [cat, v] of cats) {
      remaining -= v.savings;
      rows.push(row(cat, remaining, v.savings, `−${money(v.savings)}`, 'wf-step', `${v.count} action${v.count > 1 ? 's' : ''}`));
    }
    rows.push(row('After', 0, Math.max(0, remaining), money(Math.max(0, remaining)), 'wf-after', `${s.savingsPct.toFixed(0)}% lower`));
    els.waterfall.replaceChildren(...rows);
  }

  function renderRoadmap(r) {
    const recs = r.recommendations.filter((x) => x.monthlySavings > 0);
    const commit = (x) => /Savings Plans|Reserved Instances/.test(x.category);
    const phases = [
      { title: 'Week 1 · Quick wins', sub: 'Settings and cleanup, low risk', pick: (x) => !commit(x) && x.effort === 'Low' },
      { title: 'This month · Test and change', sub: 'Resizing and config changes', pick: (x) => !commit(x) && x.effort === 'Medium' },
      { title: 'Month 2 · Commit', sub: 'Savings Plans / RIs on what is left', pick: commit },
      { title: 'This quarter · Projects', sub: 'Migrations and redesigns', pick: (x) => !commit(x) && x.effort === 'High' },
    ];
    let bill = r.summary.totalCost;
    els.roadmap.replaceChildren(...phases.map((ph, i) => {
      const items = recs.filter(ph.pick).sort((a, b) => b.monthlySavings - a.monthlySavings);
      const sum = items.reduce((a, x) => a + x.monthlySavings, 0);
      const done = items.filter(isDone).length;
      bill -= sum;
      if (!items.length) return null;
      return el('li', { class: 'rm-phase' },
        el('div', { class: 'rm-head' },
          el('span', { class: 'rm-num', 'aria-hidden': 'true' }, String(i + 1)),
          el('div', null, el('strong', null, ph.title), el('div', { class: 'res-meta' }, `${ph.sub} · ${items.length} action${items.length > 1 ? 's' : ''}${done ? ` · ${done} done` : ''}`)),
          el('div', { class: 'rm-save' }, el('strong', { class: 'savings' }, `−${money(sum)}`), el('span', { class: 'res-meta' }, `bill → ${money(Math.max(0, bill))}`))),
        el('ul', { class: 'rm-items' }, ...items.slice(0, 4).map((x) => {
          const b = el('button', { type: 'button', class: `link-btn rm-item${isDone(x) ? ' done' : ''}` }, x.title.replace(/ · \d.*$/, ''));
          b.addEventListener('click', () => showRec(x));
          return el('li', null, b, el('span', { class: 'muted' }, ` ${money(x.monthlySavings)}`));
        }), items.length > 4 ? el('li', { class: 'muted' }, `+ ${items.length - 4} more in the Action plan`) : null));
    }).filter(Boolean));
  }

  // ---------------------------------------------------------------------------
  // Playbook inside an expanded recommendation
  // ---------------------------------------------------------------------------

  const Playbooks = window.FinOpsPlaybooks;

  function ensureMore(tr) {
    if (!tr || !Playbooks || tr.querySelector('.rec-more')) return;
    const rec = state.recByKey && state.recByKey.get(tr.dataset.key);
    if (!rec) return;
    const pb = Playbooks.forRec(rec);
    const ex = Playbooks.explain(rec);
    const kv = (k, v) => el('div', { class: 'kv' }, el('span', null, k), el('strong', null, v));
    const cmds = pb.cli.map((c) => {
      const b = el('button', { type: 'button', class: 'btn btn-ghost btn-sm copy-btn' }, 'Copy');
      b.addEventListener('click', () => copyText(c.cmd, 'command'));
      return el('div', { class: 'cmd' }, el('div', { class: 'cmd-head' }, el('span', null, c.label), b), el('pre', null, el('code', null, c.cmd)));
    });
    const more = el('div', { class: 'rec-more' },
      el('div', { class: 'more-grid' },
        el('section', null, el('h5', null, 'How the saving is worked out'),
          kv('Cost today', `${money(rec.currentCost)}/mo`),
          kv('Saving', rec.monthlySavings > 0 ? `${money(rec.monthlySavings)}/mo (${ex.pct.toFixed(0)}% of this cost)` : 'Not counted (advice only)'),
          kv('Per year', money(ex.annual)),
          kv('Confidence', ex.confidence),
          el('p', { class: 'muted small' }, ex.basis)),
        el('section', null, el('h5', null, 'Effort and risk'),
          kv('Time to do', pb.time),
          kv('Effort', rec.effort),
          el('p', { class: 'small' }, pb.risk))),
      el('section', null, el('h5', null, 'Steps'), el('ol', { class: 'more-steps' }, ...pb.steps.map((s) => el('li', null, s)))),
      cmds.length ? el('section', null, el('h5', null, `AWS CLI${pb.region && pb.region !== '<region>' ? ` (${pb.region})` : ''}`),
        el('p', { class: 'muted small' }, 'Replace values in <angle brackets>. These commands only read data or change the resources you name.'), ...cmds) : null,
      pb.note ? el('p', { class: 'muted small' }, pb.note) : null,
      el('p', { class: 'more-verify' }, el('strong', null, 'Check it worked: '), pb.verify));
    tr.querySelector('td:nth-child(5)').append(more);
  }

  /** Jump to a recommendation in the main table and open it. */
  function showRec(x) {
    els.fSearch.value = x.resourceId;
    els.fPriority.value = ''; els.fCategory.value = ''; els.fHideDone.checked = false;
    setTab('actions', false);
    renderTable();
    const row = [...els.recBody.rows].find((tr) => tr.dataset.key === recKey(x));
    (row || els.recBody).scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (row) {
      ensureMore(row);
      row.tabIndex = 0;
      row.classList.add('expanded', 'highlight');
      row.setAttribute('aria-expanded', 'true');
      row.focus({ preventScroll: true });
      setTimeout(() => row.classList.remove('highlight'), 1800);
    }
  }

  // ---------------------------------------------------------------------------
  // Result tabs: one focused view at a time instead of a very long page
  // ---------------------------------------------------------------------------

  function tabList() {
    const r = state.result;
    const all = r ? r.recommendations : [];
    const open = all.filter((x) => !isDone(x)).length;
    const c = r && r.commitments;
    return [
      { id: 'overview', icon: '◎', label: 'Overview', badge: r ? money(r.summary.totalSavings, true) : '', badgeTitle: 'possible savings / month' },
      { id: 'actions', icon: '✓', label: 'Action plan', badge: r ? String(open) : '', badgeTitle: 'open actions' },
      { id: 'services', icon: '▤', label: 'By service', show: Boolean(r) },
      { id: 'plans', icon: '◷', label: 'Savings Plans', show: Boolean(c), badge: c && c.totals.monthlySavings > 0 ? money(c.totals.monthlySavings, true) : '', aws: c && c.source !== 'estimate' },
      { id: 'bill', icon: '🧾', label: 'Bill details', show: Boolean(state.pdf) },
      { id: 'data', icon: '⚙', label: 'Data & columns' },
    ].filter((t) => t.show !== false && (r || t.id === 'data'));
  }

  function renderTabs() {
    const tabs = tabList();
    if (!tabs.some((t) => t.id === state.tab)) state.tab = tabs[0].id;
    els.resultTabs.replaceChildren(...tabs.map((t) => {
      const b = el('button', {
        type: 'button', role: 'tab', class: 'result-tab', id: `rtab-${t.id}`, 'data-tab-id': t.id,
        'aria-selected': String(t.id === state.tab), tabindex: t.id === state.tab ? '0' : '-1',
      },
      el('span', { class: 'rt-icon', 'aria-hidden': 'true' }, t.icon),
      el('span', null, t.label),
      t.badge ? el('span', { class: 'rt-badge', title: t.badgeTitle || '' }, t.badge) : null,
      t.aws ? el('span', { class: 'rt-aws', title: 'Uses AWS data' }, 'AWS') : null);
      b.addEventListener('click', () => setTab(t.id));
      return b;
    }));
    applyTab();
  }

  function applyTab() {
    els.results.querySelectorAll('[data-tab]').forEach((n) => n.classList.toggle('tab-off', n.dataset.tab !== state.tab));
    els.resultTabs.querySelectorAll('.result-tab').forEach((b) => {
      const on = b.dataset.tabId === state.tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }

  function setTab(id, scroll = true) {
    state.tab = id;
    applyTab();
    if (id === 'data') els.mappingPanel.open = true;
    if (id === 'plans' && state.result) autoPriceCheck();
    if (scroll) els.resultTabs.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Arrow keys move between tabs (WAI-ARIA tabs pattern)
  function tabKeys(container, onPick) {
    container.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const tabs = [...container.querySelectorAll('[role="tab"]')];
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus();
      onPick(tabs[next]);
    });
  }

  /** Donut: share of spend that can be saved. */
  function renderStartVisual(s) {
    const pct = Math.max(0, Math.min(100, s.savingsPct));
    const r = 42; const c = 2 * Math.PI * r;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('class', 'donut');
    const ring = (cls, dash) => {
      const e = document.createElementNS(NS, 'circle');
      e.setAttribute('cx', '50'); e.setAttribute('cy', '50'); e.setAttribute('r', String(r));
      e.setAttribute('class', cls);
      if (dash != null) { e.setAttribute('stroke-dasharray', `${dash} ${c}`); e.setAttribute('transform', 'rotate(-90 50 50)'); }
      return e;
    };
    svg.append(ring('donut-bg'), ring('donut-fg', (pct / 100) * c));
    els.startVisual.replaceChildren(
      el('div', { class: 'donut-wrap' }, svg,
        el('div', { class: 'donut-label' }, el('strong', null, `${pct.toFixed(0)}%`), el('span', null, 'can be saved'))),
      el('div', { class: 'before-after' },
        el('div', null, el('span', { class: 'muted' }, 'Today'), el('strong', null, money(s.totalCost))),
        el('div', { class: 'ba-arrow', 'aria-hidden': 'true' }, '→'),
        el('div', null, el('span', { class: 'muted' }, 'After'), el('strong', { class: 'savings' }, money(s.totalCost - s.totalSavings)))));
  }

  function renderPdf() {
    const pdf = state.pdf;
    els.pdfPanel.hidden = !pdf;
    if (!pdf) return;
    const m = pdf.meta;
    const card = (label, value, sub, accent) =>
      el('div', { class: `card${accent ? ' accent' : ''}` },
        el('div', { class: 'card-label' }, label),
        el('div', { class: 'card-value' }, value),
        sub ? el('div', { class: 'card-sub' }, sub) : null);

    const sellerText = m.sellers && m.sellers.length > 1 ? m.sellers.map((s) => `${s.name} ${money(s.total)}`).join(' + ') : m.provider;
    const notes = [];
    if (pdf.rows.some((r) => r.Service === 'Data Transfer')) notes.push('Bills list Data Transfer as its own service; Cost Explorer spreads it across EC2-Other, Load Balancing, S3 and others, so per-service numbers differ while the total matches.');
    if (pdf.rows.some((r) => r['Pricing Model'] === 'Reserved')) notes.push('Reserved Instance fees are shown under EC2-Instances (Cost Explorer puts some in EC2-Other).');
    els.pdfMeta.textContent = [sellerText, m.period && `Billing period ${m.period}`, m.accountId && `Account ${m.accountId}`, ...notes].filter(Boolean).join(' · ');
    const billTotal = m.grandTotal != null ? m.grandTotal : m.expectedTotal;
    els.pdfCards.replaceChildren(
      card('Bill total', billTotal != null ? money(billTotal) : '—', m.totalTax ? `incl. ${money(m.totalTax)} tax` : 'pre-tax charges'),
      card('Parsed services', money(m.servicesTotal), `${m.serviceCount} services`, m.reconciled === true),
      card('Check', m.reconciled === true ? 'Matches' : m.reconciled === false ? 'Mismatch' : 'n/a',
        m.reconciled === false ? `difference ${money(Math.abs(m.expectedTotal - m.servicesTotal))}` : 'parsed vs bill total'),
      card('Line items', String(m.lineItemCount), `${m.pages || '?'} pages read`),
    );

    const items = pdf.lineItems.filter((i) => i.cost > 0).sort((a, b) => b.cost - a.cost);
    const limit = els.pdfTop.value === 'all' ? items.length : parseInt(els.pdfTop.value, 10);
    const total = m.servicesTotal || 1;
    els.pdfBody.replaceChildren(...items.slice(0, limit).map((i) => el('tr', null,
      el('td', null, el('div', { class: 'svc-name' }, i.service), i.region ? el('div', { class: 'res-meta' }, i.region) : null),
      el('td', null, el('div', null, i.usageType || '—'), i.description ? el('div', { class: 'rec-detail' }, i.description) : null),
      el('td', { class: 'num' }, i.quantity != null ? `${i.quantity.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${i.unit}` : '—'),
      el('td', { class: 'num savings' }, money(i.cost)),
      el('td', { class: 'pct-cell' },
        el('div', { class: 'pct-bar' },
          el('span', { class: 'bar-track', role: 'img', 'aria-label': `${((i.cost / total) * 100).toFixed(1)}% of bill` },
            el('span', { class: 'bar-fill', style: `width:${Math.max(1, (i.cost / total) * 100).toFixed(1)}%` })),
          el('span', { class: 'bar-value' }, `${((i.cost / total) * 100).toFixed(1)}%`))))));
    els.pdfEmpty.hidden = items.length > 0;
  }

  function renderServiceSavings() {
    const all = (state.result && state.result.serviceSavings) || [];
    const list = els.svcShow.value === 'all' ? all : all.filter((s) => s.totalSavings > 0);
    els.svcEmpty.hidden = list.length > 0;

    els.svcBody.replaceChildren(...list.map((s) => {
      const btn = el('button', { type: 'button', class: 'link-btn', title: `Show ${s.service} recommendations` }, s.service);
      btn.addEventListener('click', () => {
        els.fSearch.value = s.service;
        els.fPriority.value = '';
        els.fCategory.value = '';
        renderTable();
        setTab('actions');
      });
      const actions = s.actions.filter((a) => a.savings > 0 || s.totalSavings === 0).slice(0, 3);
      return el('tr', null,
        el('td', null, btn, s.resourceCount > 1 ? el('div', { class: 'res-meta' }, `${s.resourceCount} resources`) : null),
        el('td', { class: 'num' }, money(s.cost)),
        el('td', { class: 'num' }, s.optimizationSavings > 0 ? money(s.optimizationSavings) : '—'),
        el('td', { class: 'num' }, s.commitmentSavings > 0 ? money(s.commitmentSavings) : '—'),
        el('td', { class: 'num savings' }, s.totalSavings > 0 ? money(s.totalSavings) : '—'),
        el('td', { class: 'pct-cell' },
          el('div', { class: 'pct-bar' },
            el('span', { class: 'bar-track', role: 'img', 'aria-label': `${s.savingsPct.toFixed(1)}% savings` },
              el('span', { class: 'bar-fill', style: `width:${Math.max(s.savingsPct > 0 ? 2 : 0, s.savingsPct).toFixed(1)}%` })),
            el('span', { class: 'bar-value' }, `${s.savingsPct.toFixed(0)}%`))),
        el('td', { class: 'num' }, money(s.optimizedCost)),
        el('td', null, actions.length
          ? el('ul', { class: 'action-list' }, ...actions.map((a) => el('li', null, a.title,
            a.count > 1 ? ` (×${a.count})` : '', a.savings > 0 ? el('span', { class: 'muted' }, ` · ${money(a.savings)}`) : null)))
          : el('span', { class: 'muted' }, s.cost > 0 ? 'No savings identified' : '')));
    }));

    const sum = (k) => list.reduce((t, s) => t + s[k], 0);
    const cost = sum('cost'); const total = sum('totalSavings');
    els.svcFoot.replaceChildren(list.length ? el('tr', null,
      el('td', null, `Total (${list.length})`),
      el('td', { class: 'num' }, money(cost)),
      el('td', { class: 'num' }, money(sum('optimizationSavings'))),
      el('td', { class: 'num' }, money(sum('commitmentSavings'))),
      el('td', { class: 'num savings' }, money(total)),
      el('td', null, cost > 0 ? `${((total / cost) * 100).toFixed(0)}%` : ''),
      el('td', { class: 'num' }, money(sum('optimizedCost'))),
      el('td', null, '')) : '');
  }

  function renderCommitments(c) {
    if (!c) { els.spPanel.hidden = true; return; }
    els.spPanel.hidden = false;

    const card = (label, value, sub, accent) =>
      el('div', { class: `card${accent ? ' accent' : ''}` },
        el('div', { class: 'card-label' }, label),
        el('div', { class: 'card-value' }, value),
        sub ? el('div', { class: 'card-sub' }, sub) : null);
    els.spCards.replaceChildren(
      card('Eligible on-demand / mo', money(c.coverage.eligibleOnDemand), 'EC2, Fargate, Lambda, databases, SageMaker…'),
      card('Coverage', `${c.coverage.currentPct.toFixed(0)}% → ${c.coverage.projectedPct.toFixed(0)}%`,
        c.coverage.source === 'aws'
          ? `actual for ${c.coverage.month} (AWS)${c.coverage.utilizationPct ? ` · existing SPs ${c.coverage.utilizationPct.toFixed(0)}% used` : ''}`
          : 'current → after purchase'),
      card('Total commitment', `${money(c.totals.hourlyCommitment)}/hr`, `${money(c.totals.hourlyCommitment * 730)}/mo`),
      card('Commitment savings / mo', money(c.totals.monthlySavings), `${money(c.totals.monthlySavings * 12)}/yr`, true),
      card('Upfront payment', money(c.totals.upfront), c.totals.upfront > 0 ? 'due at purchase' : 'none for this term'),
    );

    // AWS sizes plans itself, so the coverage target only applies to estimates
    els.spCoverage.disabled = c.source === 'aws';
    els.spCoverage.title = c.source === 'aws' ? 'AWS Cost Explorer sizes these plans from your usage' : '';
    renderEC2(c.ec2, card);
    renderSpTools(c);
    renderFamilySource();
    renderPriceCheckIdle();
    renderSpa();
    if (state.spaResult) renderSpaResult();

    els.spEmpty.hidden = c.plans.length > 0;
    els.spBody.replaceChildren(...c.plans.map((p) => {
      const o = p.recommended;
      const options = el('details', { class: 'plan-options' },
        el('summary', null, 'Compare terms'),
        el('table', { class: 'options-table' },
          el('thead', null, el('tr', null, ...['Option', 'Discount', 'Commit / hr', 'Savings / mo', 'Upfront', 'Term savings'].map((h) => el('th', { scope: 'col' }, h)))),
          el('tbody', null, ...p.options.map((x) => el('tr', { class: x.key === o.key ? 'selected' : null },
            el('td', null, x.label), el('td', null, `${x.discountPct.toFixed(0)}%`), el('td', null, money(x.hourlyCommitment)),
            el('td', null, money(x.monthlySavings)), el('td', null, money(x.upfront)), el('td', null, money(x.totalTermSavings)))))));
      return el('tr', null,
        el('td', null,
          el('span', { class: `src-badge ${p.source === 'aws' ? 'aws' : 'est'}` }, p.source === 'aws' ? 'AWS Cost Explorer' : 'Estimate'),
          el('div', { class: 'plan-name' }, p.label),
          el('div', { class: 'plan-note' }, p.rationale),
          options),
        el('td', null, el('div', null, p.scope), el('div', { class: 'plan-note' }, p.appliesTo)),
        el('td', { class: 'num' }, money(p.coveredOnDemand)),
        el('td', { class: 'num' }, money(o.hourlyCommitment)),
        el('td', { class: 'num' }, `${o.discountPct.toFixed(0)}%`),
        el('td', { class: 'num savings' }, money(o.monthlySavings)),
        el('td', { class: 'num' }, money(o.upfront)));
    }));

    els.spServices.replaceChildren(...c.services.map((s) =>
      el('tr', null,
        el('td', null, s.service),
        el('td', { class: 'num' }, money(s.cost)),
        el('td', { class: 'num' }, s.eligible ? `${s.coveragePct.toFixed(0)}%` : '—'),
        el('td', null, el('span', { class: `tag${s.eligible ? ' tag-yes' : ''}` }, s.eligible ? s.plan : 'Not eligible')),
        el('td', { class: 'plan-note' }, s.notes || (s.eligible ? 'Steady usage counts toward the plan above.' : '')))));
  }

  // ---------------------------------------------------------------------------
  // Savings Plan tools: term finder, what-if simulator, staged purchase plan
  // ---------------------------------------------------------------------------

  const Commit = window.FinOpsCommitments;
  const TERM_LABEL = Object.fromEntries((Commit ? Commit.TERM_OPTIONS : []).map((t) => [t.key, t.label]));
  const CONSOLE_SP = 'https://console.aws.amazon.com/costmanagement/';
  const PLAN_BUY = {
    computeSP: { where: 'Billing and Cost Management → Savings Plans → Purchase Savings Plans', type: 'Compute Savings Plans', url: CONSOLE_SP },
    ec2InstanceSP: { where: 'Billing and Cost Management → Savings Plans → Purchase Savings Plans', type: 'EC2 Instance Savings Plans', url: CONSOLE_SP },
    sagemakerSP: { where: 'Billing and Cost Management → Savings Plans → Purchase Savings Plans', type: 'SageMaker Savings Plans', url: CONSOLE_SP },
    databaseSP: { where: 'Billing and Cost Management → Savings Plans → Purchase Savings Plans', type: 'Database Savings Plans', url: CONSOLE_SP },
    dbRI: { where: 'RDS / ElastiCache / OpenSearch console → Reserved instances (or nodes) → Purchase', type: 'Reserved Instances', url: 'https://console.aws.amazon.com/rds/home#reserved-instances:' },
    redshiftRN: { where: 'Redshift console → Reserved nodes → Purchase', type: 'Reserved Nodes', url: 'https://console.aws.amazon.com/redshiftv2/home#reserved-nodes' },
    azureSP: { where: 'Azure portal → Savings plans → Add', type: 'Azure savings plan for compute', url: 'https://portal.azure.com/#view/Microsoft_Azure_Reservations/CreateBenefitsBlade' },
    gcpFlexCUD: { where: 'Google Cloud console → Billing → Committed use discounts → Purchase', type: 'Flexible CUD', url: 'https://console.cloud.google.com/billing' },
  };
  const fmtHourly = (n) => (n < 1 ? n.toFixed(3) : n.toFixed(2));
  const addMonths = (d, m) => { const x = new Date(d); x.setMonth(x.getMonth() + m); return x; };
  const fmtDate = (d) => d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  async function copyText(text, what) {
    try { await navigator.clipboard.writeText(text); toast(`Copied ${what}: ${text}`); } catch (_) { toast(`Copy this: ${text}`); }
  }

  function renderSpTools(c) {
    const plans = c.plans.filter((p) => p.recommended && p.recommended.monthlySavings > 0);
    els.spTools.hidden = !plans.length;
    els.buySection.hidden = !plans.length;
    if (!plans.length) return;
    renderFinder(c);
    // Simulator plan picker (keep the selection across re-renders when possible)
    const prev = els.simPlan.value;
    els.simPlan.replaceChildren(...plans.map((p, i) => el('option', { value: String(i), selected: p.label === prev || String(i) === prev }, `${p.label}${p.source === 'aws' ? ' (AWS)' : ''}`)));
    if (!plans.some((p, i) => String(i) === els.simPlan.value)) els.simPlan.value = '0';
    state.simPlans = plans;
    const p = plans[parseInt(els.simPlan.value, 10)];
    els.simX.value = String(Math.round(p.recommendedX * 100));
    renderSim();
    renderBuyPlan(plans);
  }

  // ---- Instance families: AWS console recommendations + families in the uploaded data ----
  const familyOf = (type) => {
    const m = /^(?:db\.|cache\.)?([a-z]+\d+[a-z-]*)\.(\w+)$/i.exec(String(type || '').trim());
    return m ? m[1].toLowerCase() : '';
  };

  function famTable(caption, headers, rows) {
    return el('div', { class: 'table-wrap' }, el('table', { class: 'table table-compact' },
      el('caption', { class: 'sr-only' }, caption),
      el('thead', null, el('tr', null, ...headers.map((h, i) => el('th', { scope: 'col', class: i >= headers.length - 3 && h !== 'Status' && h !== 'Suggested' ? 'num' : null }, h)))),
      el('tbody', null, ...rows)));
  }

  function renderFamilySource() {
    const aws = state.aws;
    // 1. From AWS: exactly what Cost Explorer (and the console) recommends
    if (aws) {
      const rows = [];
      const sp = aws.savingsPlans || {};
      const spName = { COMPUTE_SP: 'Compute SP', EC2_INSTANCE_SP: 'EC2 Instance SP', SAGEMAKER_SP: 'SageMaker SP', DATABASE_SP: 'Database SP' };
      for (const [k, v] of Object.entries(sp)) {
        if (!v || v.error || !(v.monthlySavings > 0)) continue;
        const det = (v.details || []).filter((d) => d.family);
        if (det.length) {
          det.forEach((d) => rows.push(el('tr', null, el('td', null, spName[k]), el('td', null, el('code', null, d.family)), el('td', null, '—'),
            el('td', null, d.region || '—'), el('td', { class: 'num' }, `${money(d.hourly)}/hr`), el('td', { class: 'num savings' }, money(d.monthlySavings)), el('td', { class: 'num' }, money(d.upfront || 0)))));
        } else {
          rows.push(el('tr', null, el('td', null, spName[k]), el('td', null, el('span', { class: 'muted' }, k === 'COMPUTE_SP' ? 'Any family (flexible)' : 'Any')), el('td', null, '—'),
            el('td', null, k === 'COMPUTE_SP' ? 'Any region' : '—'), el('td', { class: 'num' }, `${money(v.hourly)}/hr`), el('td', { class: 'num savings' }, money(v.monthlySavings)), el('td', { class: 'num' }, money(v.upfront || 0))));
        }
      }
      for (const [k, v] of Object.entries(aws.reservations || {})) {
        if (!v || v.error) continue;
        (v.details || []).forEach((d) => rows.push(el('tr', null,
          el('td', null, `${k.toUpperCase()} Reserved Instance`),
          el('td', null, el('code', null, d.family || familyOf(d.instanceType) || '—')),
          el('td', null, el('code', null, d.instanceType || '—'), d.count ? el('span', { class: 'muted' }, ` × ${d.count}`) : null, d.sizeFlexible ? el('div', { class: 'res-meta' }, 'size-flexible within the family') : null),
          el('td', null, [d.region, d.platform || d.engine].filter(Boolean).join(' · ') || '—'),
          el('td', { class: 'num' }, d.count ? `${d.count} instance(s)` : '—'),
          el('td', { class: 'num savings' }, money(d.monthlySavings)),
          el('td', { class: 'num' }, money(d.upfront || 0)))));
      }
      els.famsrcAws.replaceChildren(
        el('h5', { class: 'minihead' }, `From AWS (same as the console) · ${els.spTerm.selectedOptions[0].text} · last ${aws.lookbackDays || 30} days`),
        rows.length ? famTable('AWS Savings Plan and Reserved Instance recommendations', ['Recommendation', 'Instance family', 'Instance type', 'Region / platform', 'Commitment', 'Savings / mo', 'Upfront'], rows)
          : el('p', { class: 'muted small' }, 'AWS recommends no new Savings Plans or Reserved Instances for this term and lookback.'),
        el('p', { class: 'muted small' }, 'The console shows Savings Plans and Reserved Instances as alternatives for the same usage. Do not buy both for one family.'));
    } else {
      els.famsrcAws.replaceChildren(el('p', { class: 'muted small' },
        el('strong', null, 'AWS console numbers: '),
        'connect your AWS account (Connect AWS tab) to see the exact Savings Plan and Reserved Instance recommendations with their instance family names. A bill or CSV cannot reproduce them, because AWS calculates them from hourly usage over the last 7, 30 or 60 days.'));
    }

    // 2. From the uploaded data: every EC2 family, by pricing model
    const groups = new Map();
    for (const r of (state.result && state.result.resources) || []) {
      const fam = familyOf(r.instanceType);
      if (!fam || /^(db|cache)\./i.test(r.instanceType)) continue;
      const key = `${fam}|${r.region}`;
      const g = groups.get(key) || { fam, region: r.region, types: new Set(), od: 0, odHrs: 0, ri: 0, riHrs: 0, spot: 0, spotHrs: 0 };
      g.types.add(r.instanceType);
      const hrs = r.usageHours || 0;
      const pm = String(r.pricingModel || '').toLowerCase();
      if (/reserved|savings/.test(pm) || r.costCovered > 0) { g.ri += r.cost; g.riHrs += hrs; }
      else if (/spot/.test(pm) || r.costSpot > 0) { g.spot += r.cost; g.spotHrs += hrs; }
      else { g.od += r.cost; g.odHrs += hrs; }
      groups.set(key, g);
    }
    const list = [...groups.values()].sort((a, b) => b.od - a.od || (b.ri + b.spot) - (a.ri + a.spot));
    if (!list.length) {
      els.famsrcBill.replaceChildren(el('p', { class: 'muted small' }, 'No instance types in this file. Upload the bill PDF, or a list of instances with an instance-type column, to see families here.'));
      return;
    }
    const cell = (cost, hrs) => (cost > 0 ? `${money(cost)}${hrs ? ` · ${Math.round(hrs).toLocaleString()} h` : ''}` : '—');
    els.famsrcBill.replaceChildren(
      el('h5', { class: 'minihead' }, 'From your bill / file · EC2 instance families'),
      famTable('EC2 instance families in the uploaded data', ['Instance family', 'Region', 'Sizes seen', 'On-demand', 'Reserved / SP', 'Spot', 'Suggested'], list.map((g) => {
        const avgInst = g.odHrs / 730;
        const suggest = g.od <= 0 ? 'Already covered / Spot'
          : avgInst < 0.5 ? `Low steady use (~${avgInst.toFixed(1)} instance avg): leave on-demand`
            : `EC2 Instance SP ${g.fam} or Compute SP (~${avgInst.toFixed(1)} instances 24/7)`;
        return el('tr', null,
          el('td', null, el('code', null, g.fam)),
          el('td', null, g.region || '—'),
          el('td', null, [...g.types].sort().join(', ')),
          el('td', { class: 'num' }, cell(g.od, g.odHrs)),
          el('td', { class: 'num' }, cell(g.ri, g.riHrs)),
          el('td', { class: 'num' }, cell(g.spot, g.spotHrs)),
          el('td', null, suggest));
      })),
      el('p', { class: 'muted small' }, '"Instances 24/7" = on-demand hours ÷ 730. AWS only recommends a commitment for usage that runs steadily every hour, so short-lived or bursty families often get no recommendation in the console.'));
  }

  // ---- Price check: exact AWS rates for each on-demand instance type ----
  function priceItems() {
    const m = new Map();
    for (const r of (state.result && state.result.resources) || []) {
      if (!familyOf(r.instanceType) || /^(db|cache)\./i.test(r.instanceType)) continue;
      const pm = String(r.pricingModel || '').toLowerCase();
      if (/reserved|savings|spot/.test(pm) || r.costCovered > 0 || r.costSpot > 0) continue;
      const os = /windows/i.test(`${r.usageType} ${r.pricingModel}`) ? 'windows' : /rhel|red hat/i.test(r.usageType) ? 'rhel' : /suse/i.test(r.usageType) ? 'suse' : 'linux';
      // Hours: from the data, or 730 for a resource row without hours
      const hours = r.usageHours != null ? r.usageHours : 730;
      const k = `${r.instanceType}|${r.region}|${os}`;
      const e = m.get(k) || { type: r.instanceType, region: r.region, os, hours: 0, billCost: 0 };
      e.hours += hours; e.billCost += r.cost;
      m.set(k, e);
    }
    // Instance types typed in by the user
    for (const line of String(els.priceManual.value || '').split(/\r?\n/)) {
      const [type, region, hours, os] = line.split(/[,\t;]/).map((s) => (s || '').trim());
      if (!familyOf(type) || !region) continue;
      const o = /windows/i.test(os) ? 'windows' : 'linux';
      const k = `${type}|${region}|${o}|manual`;
      m.set(k, { type, region, os: o, hours: parseFloat(hours) > 0 ? parseFloat(hours) : 730, billCost: 0, manual: true });
    }
    return [...m.values()].sort((a, b) => b.billCost - a.billCost).slice(0, 60);
  }

  /** Why prices cannot be fetched right now (null = ready). Public prices need the connector but no AWS login. */
  function priceBlocker(items) {
    // Works without the connector: saved AWS price lists are used when it is not running
    if (!items.length) return 'No on-demand instance types with a region in this data (service-level CSVs do not list instance types). Upload the bill PDF, or type instance types under "Add instance types yourself".';
    return null;
  }
  const connectorPricing = () => Boolean(state.awsStatus && state.awsStatus.connected);

  /** Why EC2 Instance SP / RI rates are missing (shown under the table). */
  function connectorHint() {
    if (!/^https?:$/.test(location.protocol)) return 'For EC2 Instance Savings Plan and Reserved Instance rates, open the page through the connector (server folder: npm install, npm start, then http://localhost:8787) and sign in to AWS.';
    const s = state.awsStatus;
    if (!s) return 'For EC2 Instance Savings Plan and Reserved Instance rates, start the connector (start.cmd).';
    if (!s.connected) return `For EC2 Instance Savings Plan and Reserved Instance rates, fix the AWS sign-in (${s.message || s.error}): create a new access key and run "aws configure", or run "aws sso login", then restart the connector.`;
    return '';
  }

  function renderPriceCheckIdle() {
    const items = priceItems();
    const blocker = priceBlocker(items);
    // Keep the calculator (and the user's edits) when the page re-renders with the same instance types
    if (pc.res && !blocker && pc.sig === items.map(itemKey).join(';')) { renderCalculator(); return; }
    if (pc.sig && pc.sig !== items.map(itemKey).join(';')) { pc.res = null; pc.sig = ''; }
    if (!blocker && state.tab === 'plans') { autoPriceCheck(); return; }
    // Never disabled: clicking explains what is missing
    els.btnPriceCheck.disabled = false;
    els.btnPriceCheck.classList.toggle('btn-blocked', Boolean(blocker));
    els.priceCheck.replaceChildren(el('p', { class: 'muted small' }, blocker
      ? `Not ready: ${blocker}`
      : `${items.length} on-demand instance type(s) ready. Click "Get AWS prices" for ${els.spTerm.selectedOptions[0].text}: ${connectorPricing()
        ? 'on-demand, Compute SP, EC2 Instance SP and RI rates from your AWS connection.'
        : state.awsStatus ? 'on-demand and Compute Savings Plan rates from AWS\'s public price files (no login needed).'
          : 'on-demand and Compute Savings Plan rates from the saved AWS price list (works offline).'}`));
  }

  // Interactive calculator state: edits survive term changes and re-renders
  const pc = { term: null, cover: 'all', sort: { key: 'od', dir: -1 }, edits: new Map(), res: null, items: [], sig: '' };
  const itemKey = (i) => `${i.type}|${i.region}|${i.os}`;
  const steadyHours = (h) => Math.min(h, Math.floor((h + 30) / 730) * 730); // whole instances running ~24/7

  async function runPriceCheck(opts = {}) {
    const items = priceItems();
    const blocker = priceBlocker(items);
    if (blocker) {
      if (!opts.auto) {
        els.priceCheck.replaceChildren(el('p', { class: 'status error' }, blocker));
        if (/instance types/.test(blocker)) { els.priceManualBox.open = true; els.priceManual.focus(); }
      }
      return;
    }
    const term = pc.term || els.spTerm.value;
    pc.term = term;
    els.btnPriceCheck.disabled = true;
    if (!pc.res) els.priceCheck.replaceChildren(el('p', { class: 'status loading' }, `Looking up AWS prices for ${items.length} instance type(s)…`));
    else els.priceCheck.classList.add('pc-busy');
    try {
      let res;
      if (connectorPricing()) {
        try { res = await Aws.pricing(items, term); } catch (_) { res = null; }
      }
      // Live public prices through the connector, else the saved copy (works from a file)
      if (!res && state.awsStatus) { try { res = await Aws.publicPricing(items, term); } catch (_) { res = null; } }
      if (!res) res = await window.FinOpsOfflinePricing.priceCheck(items, term);
      pc.res = res; pc.items = items; pc.sig = items.map(itemKey).join(';');
      renderCalculator();
    } catch (err) {
      els.priceCheck.replaceChildren(el('p', { class: 'status error' }, `AWS price lookup failed: ${err.message}`));
    } finally {
      els.btnPriceCheck.disabled = false;
      els.priceCheck.classList.remove('pc-busy');
    }
  }

  /** Auto-run when the Savings Plans tab opens (offline prices are free and instant). */
  function autoPriceCheck() {
    const items = priceItems();
    if (!items.length || priceBlocker(items)) return;
    if (pc.res && pc.sig === items.map(itemKey).join(';')) { renderCalculator(); return; }
    pc.res = null;
    runPriceCheck({ auto: true });
  }

  /** Per-row numbers with the user's edits applied. */
  function calcRows() {
    const byKey = new Map(pc.res.rows.map((r) => [`${r.type}|${r.os}`, r]));
    return pc.items.map((it) => {
      const p = byKey.get(`${it.type}|${it.os}`) || {};
      const e = pc.edits.get(itemKey(it)) || {};
      const hours = e.hours != null ? e.hours : it.hours;
      const autoCommit = pc.cover === 'steady' ? steadyHours(hours) : pc.cover === 'half' ? hours / 2 : hours;
      const commit = Math.min(hours, e.commit != null && pc.cover === 'custom' ? e.commit : autoCommit);
      const odRate = p.onDemand || 0;
      const od = odRate * hours;
      const opt = (rate) => {
        if (!rate || !odRate) return null;
        const cost = rate * commit + odRate * (hours - commit);
        return { rate, cost, save: od - cost, pct: od > 0 ? ((od - cost) / od) * 100 : 0, hourly: (rate * commit) / 730 };
      };
      const r = {
        it, p, key: itemKey(it), include: e.include !== false, hours, commit, odRate, od,
        c: opt(p.computeSP), i: opt(p.ec2InstanceSP), ri: opt(p.reservedInstance && p.reservedInstance.effectiveHourly),
      };
      r.best = ['c', 'i', 'ri'].filter((k) => r[k]).sort((a, b) => r[b].save - r[a].save)[0] || null;
      return r;
    });
  }

  const OPT_LABEL = { c: 'Compute SP', i: 'EC2 Instance SP', ri: 'Standard RI' };

  function renderCalculator() {
    if (!pc.res) return;
    const rows = calcRows();
    const on = rows.filter((r) => r.include && r.od > 0);
    const sum = (k, f) => on.reduce((s, r) => s + (r[k] ? f(r[k]) : 0), 0);
    const tot = {
      od: on.reduce((s, r) => s + r.od, 0),
      c: sum('c', (o) => o.save), i: sum('i', (o) => o.save), ri: sum('ri', (o) => o.save),
      ch: sum('c', (o) => o.hourly), ih: sum('i', (o) => o.hourly), rih: sum('ri', (o) => o.hourly),
    };
    const avail = ['c', 'i', 'ri'].filter((k) => on.some((r) => r[k]));
    const bestKey = avail.sort((a, b) => tot[b] - tot[a])[0];
    const rate = (v) => (v ? `$${v < 1 ? v.toFixed(4) : v.toFixed(3)}/h` : '—');

    // --- toolbar: term chips + coverage preset ---
    const chip = (label, active, onClick, title) => {
      const b = el('button', { type: 'button', class: `pc-chip${active ? ' on' : ''}`, 'aria-pressed': String(active), title: title || '' }, label);
      b.addEventListener('click', onClick);
      return b;
    };
    const terms = Object.keys(TERM_LABEL);
    const termBar = el('div', { class: 'pc-group', role: 'group', 'aria-label': 'Term' },
      el('span', { class: 'pc-label' }, 'Term'),
      ...terms.map((k) => chip(TERM_LABEL[k].replace(' Upfront', '').replace('No', 'No upfront').replace('Partial', 'Partial').replace('All', 'All upfront'),
        k === pc.term, () => { pc.term = k; runPriceCheck(); }, TERM_LABEL[k])));
    const COVER = { all: 'Every hour', steady: '24/7 instances only', half: 'Half', custom: 'Custom' };
    const coverBar = el('div', { class: 'pc-group', role: 'group', 'aria-label': 'Hours to commit' },
      el('span', { class: 'pc-label' }, 'Commit to'),
      ...Object.entries(COVER).map(([k, v]) => chip(v, pc.cover === k, () => { pc.cover = k; renderCalculator(); },
        k === 'steady' ? 'Only hours of instances that ran the whole month (what the AWS console usually recommends)' : k === 'custom' ? 'Type your own committed hours per row' : '')));

    // --- summary cards ---
    const card = (label, value, sub, cls) => el('div', { class: `pc-card ${cls || ''}` }, el('span', null, label), el('strong', null, value), sub ? el('small', null, sub) : null);
    const best = bestKey ? { save: tot[bestKey], hourly: tot[`${bestKey}h`] } : null;
    const cards = el('div', { class: 'pc-cards' },
      card('On-demand today', `${money(tot.od)}/mo`, `${on.length} of ${rows.length} instance types`),
      card('Best option', best ? OPT_LABEL[bestKey] : '—', best ? `commit ${money(best.hourly)}/hr` : 'no rates found', 'accent'),
      card('Saves', best ? `${money(best.save)}/mo` : '—', best && tot.od ? `${((best.save / tot.od) * 100).toFixed(0)}% · ${money(best.save * 12)}/yr` : '', 'good'),
      card('After', best ? `${money(tot.od - best.save)}/mo` : '—', 'for these instances'));

    // --- comparison bars ---
    const bars = el('div', { class: 'pc-bars' }, ...[['od', 'On-demand', tot.od], ...avail.map((k) => [k, OPT_LABEL[k], tot.od - tot[k]])]
      .map(([k, label, cost]) => el('div', { class: `pc-bar-row${k === bestKey ? ' best' : ''}` },
        el('span', { class: 'pc-bar-label' }, label, k === bestKey ? el('em', null, ' best') : null),
        el('span', { class: 'pc-bar-track' }, el('span', { class: `pc-bar-fill ${k}`, style: `width:${tot.od ? Math.max(2, (cost / tot.od) * 100).toFixed(1) : 0}%` })),
        el('span', { class: 'pc-bar-value' }, `${money(cost)}/mo`))));

    // --- table ---
    const sortVal = { type: (r) => r.it.type, hours: (r) => r.hours, od: (r) => r.od, c: (r) => (r.c ? r.c.save : -1), i: (r) => (r.i ? r.i.save : -1), ri: (r) => (r.ri ? r.ri.save : -1) };
    const s = pc.sort;
    rows.sort((a, b) => {
      const x = sortVal[s.key](a); const y = sortVal[s.key](b);
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * s.dir;
    });
    const th = (key, label, num) => {
      const active = s.key === key;
      const b = el('button', { type: 'button', class: 'pc-sort', 'aria-label': `Sort by ${label}` }, label, el('span', { 'aria-hidden': 'true' }, active ? (s.dir > 0 ? ' ▲' : ' ▼') : ' ↕'));
      b.addEventListener('click', () => { pc.sort = { key, dir: active ? -s.dir : (key === 'type' ? 1 : -1) }; renderCalculator(); });
      return el('th', { scope: 'col', class: num ? 'num' : null, 'aria-sort': active ? (s.dir > 0 ? 'ascending' : 'descending') : 'none' }, b);
    };
    const numInput = (val, max, label, onChange) => {
      const inp = el('input', { type: 'number', class: 'pc-num', min: '0', max: String(Math.round(max)), step: '1', value: String(Math.round(val)), 'aria-label': label });
      inp.addEventListener('change', () => onChange(Math.max(0, Math.min(max, parseFloat(inp.value) || 0))));
      return inp;
    };
    const optCell = (r, k) => {
      const o = r[k];
      if (!o) return el('td', { class: 'num muted' }, '—');
      return el('td', { class: `num${r.best === k && r.include ? ' pc-best' : ''}` },
        el('div', null, rate(o.rate)),
        el('div', { class: o.save > 0 ? 'savings small' : 'small warn-text' }, `${o.save >= 0 ? '−' : '+'}${money(Math.abs(o.save))} (${o.pct.toFixed(0)}%)`));
    };
    const edit = (key, patch) => { pc.edits.set(key, Object.assign({}, pc.edits.get(key), patch)); renderCalculator(); };
    const body = rows.map((r) => {
      const box = el('input', { type: 'checkbox', checked: r.include, 'aria-label': `Include ${r.it.type}` });
      box.addEventListener('change', () => edit(r.key, { include: box.checked }));
      const billRate = r.hours > 0 && r.it.billCost ? r.it.billCost / r.it.hours : 0;
      return el('tr', { class: r.include ? null : 'pc-off' },
        el('td', null, box),
        el('td', null, el('code', null, r.it.type), el('div', { class: 'res-meta' }, `${familyOf(r.it.type)} · ${r.p.region || r.it.region} · ${r.it.os}${r.it.manual ? ' · added by you' : ''}`)),
        el('td', { class: 'num' }, numInput(r.hours, 744, `Hours per month for ${r.it.type}`, (v) => edit(r.key, { hours: v })),
          el('div', { class: 'res-meta' }, `≈ ${(r.hours / 730).toFixed(1)} instance 24/7`)),
        el('td', { class: 'num' }, pc.cover === 'custom'
          ? numInput(r.commit, r.hours, `Committed hours for ${r.it.type}`, (v) => edit(r.key, { commit: v }))
          : el('span', null, `${Math.round(r.commit).toLocaleString()} h`)),
        el('td', { class: 'num' }, el('div', null, rate(r.odRate)),
          r.odRate && billRate && Math.abs(billRate - r.odRate) / r.odRate > 0.03 ? el('div', { class: 'res-meta' }, `your bill: ${rate(billRate)}`) : null),
        el('td', { class: 'num' }, r.od ? money(r.od) : '—'),
        optCell(r, 'c'), optCell(r, 'i'), optCell(r, 'ri'));
    });
    const table = el('div', { class: 'table-wrap' }, el('table', { class: 'table table-compact pc-table' },
      el('caption', { class: 'sr-only' }, 'Exact AWS rates per instance type; edit hours to recalculate'),
      el('thead', null, el('tr', null, el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, 'Include')),
        th('type', 'Instance'), th('hours', 'Hours / mo', true), el('th', { scope: 'col', class: 'num' }, 'Committed'),
        el('th', { scope: 'col', class: 'num' }, 'On-demand rate'), th('od', 'On-demand / mo', true),
        th('c', 'Compute SP', true), th('i', 'EC2 Instance SP', true), th('ri', 'Standard RI', true))),
      el('tbody', null, ...body,
        el('tr', { class: 'total-row' }, el('td', null, ''), el('td', null, el('strong', null, 'Total (ticked)')), el('td', null, ''), el('td', null, ''), el('td', null, ''),
          el('td', { class: 'num' }, el('strong', null, money(tot.od))),
          ...['c', 'i', 'ri'].map((k) => el('td', { class: `num savings${k === bestKey ? ' pc-best' : ''}` }, avail.includes(k) ? `−${money(tot[k])}` : '—'))))));

    // --- actions ---
    const btn = (label, fn, cls = 'btn btn-ghost btn-sm') => { const b = el('button', { type: 'button', class: cls }, label); b.addEventListener('click', fn); return b; };
    const actions = el('div', { class: 'pc-actions' },
      best ? btn(`Copy ${money(best.hourly)}/hr`, () => copyText(best.hourly.toFixed(3), `${OPT_LABEL[bestKey]} commitment`), 'btn btn-secondary btn-sm') : null,
      best ? btn('Check with AWS analyzer ↓', () => { spaFromCalculator(); $('spa').scrollIntoView({ behavior: 'smooth', block: 'start' }); }) : null,
      btn('⬇ Download CSV', () => downloadCalcCsv(rows)),
      pc.edits.size ? btn('Reset edits', () => { pc.edits.clear(); renderCalculator(); }) : null);

    const notes = [
      pc.cover === 'all' ? 'Committing every hour only pays off if these instances keep running the same hours each month. Try "24/7 instances only" to see what is safe to commit.' : null,
      pc.cover === 'steady' && tot.c === 0 && tot.i === 0 ? 'None of these instance types ran a whole month, so a safe commitment is $0. That is likely why the AWS console shows no recommendation for them.' : null,
    ].filter(Boolean);
    const res = pc.res;
    els.priceCheck.replaceChildren(
      el('div', { class: 'pc-toolbar' }, termBar, coverBar),
      cards, bars, table, actions,
      ...notes.map((n) => el('p', { class: 'small pc-note' }, n)),
      res.errors && res.errors.length ? el('p', { class: 'muted small' }, `Some prices could not be fetched: ${res.errors.join('; ')}`) : null,
      res.partial && connectorHint() ? el('p', { class: 'muted small' }, connectorHint()) : null,
      el('p', { class: 'muted small' }, `Source: ${res.source}. Edit hours or untick rows to recalculate instantly. Standard RI = effective hourly rate including any upfront payment.`));
  }

  function downloadCalcCsv(rows) {
    const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const n = (v) => (v == null ? '' : Math.round(v * 10000) / 10000);
    const lines = [['Include', 'Instance type', 'Family', 'Region', 'OS', 'Hours/mo', 'Committed hours', 'On-demand $/h', 'On-demand $/mo',
      'Compute SP $/h', 'Compute SP saves $/mo', 'EC2 Instance SP $/h', 'EC2 Instance SP saves $/mo', 'Standard RI $/h', 'Standard RI saves $/mo', 'Term'].map(q).join(',')];
    for (const r of rows) {
      lines.push([r.include ? 'yes' : 'no', r.it.type, familyOf(r.it.type), r.p.region || r.it.region, r.it.os, n(r.hours), n(r.commit), n(r.odRate), n(r.od),
        n(r.c && r.c.rate), n(r.c && r.c.save), n(r.i && r.i.rate), n(r.i && r.i.save), n(r.ri && r.ri.rate), n(r.ri && r.ri.save), pc.term].map(q).join(','));
    }
    const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' }));
    const a = el('a', { href: url, download: `aws_price_check_${pc.term}.csv` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Price check downloaded');
  }

  // ---- AWS Savings Plans Purchase Analyzer ----
  const SPA_TYPE_OF = { computeSP: 'COMPUTE_SP', ec2InstanceSP: 'EC2_INSTANCE_SP', databaseSP: 'DATABASE_SP', sagemakerSP: 'SAGEMAKER_SP' };
  const SPA_LABEL = { COMPUTE_SP: 'Compute Savings Plan', EC2_INSTANCE_SP: 'EC2 Instance Savings Plan', DATABASE_SP: 'Database Savings Plan', SAGEMAKER_SP: 'SageMaker Savings Plan' };
  const spaMode = () => (document.querySelector('input[name="spa-mode"]:checked') || {}).value || 'CUSTOM_COMMITMENT';

  function spaBlocker() {
    if (!/^https?:$/.test(location.protocol)) return 'The Purchase Analyzer runs on your AWS account, so the page must be opened through the connector: double-click start.cmd and use http://localhost:8787.';
    const s = state.awsStatus;
    if (!s) return 'The local connector is not running. Double-click start.cmd and reload http://localhost:8787.';
    if (!s.connected) return `AWS rejected your sign-in (${s.message || s.error}). Create a new access key and run "aws configure", or run "aws sso login", then restart start.cmd.`;
    return null;
  }

  function renderSpa() {
    const type = els.spaType.value;
    const mode = spaMode();
    document.querySelectorAll('.spa-ec2').forEach((n) => { n.hidden = type !== 'EC2_INSTANCE_SP'; });
    els.spaCommitBox.hidden = mode !== 'CUSTOM_COMMITMENT';
    els.spaCovBox.hidden = mode !== 'TARGET_AVERAGE_COVERAGE';
    els.spaCovOut.textContent = `${els.spaCov.value}%`;
    const term = els.spTerm.value;
    els.spaTerm.textContent = `Term: ${TERM_LABEL[term] || term}${type === 'DATABASE_SP' ? ' (Database SP is 1-yr No Upfront only)' : ''} · change it at the top of this tab`;
    // Families from the data and from AWS's own recommendation
    const fams = new Map();
    for (const r of (state.result && state.result.resources) || []) {
      const f = familyOf(r.instanceType);
      if (f && !/^(db|cache)\./i.test(r.instanceType)) fams.set(f, r.region);
    }
    const e = state.result && state.result.commitments && state.result.commitments.ec2;
    ((e && e.awsFamilies) || []).forEach((f) => fams.set(f.family, f.region));
    els.spaFamilyList.replaceChildren(...[...fams.entries()].map(([f, rg]) => el('option', { value: f }, rg || '')));
    if (!els.spaRegion.value && els.spaFamily.value && fams.get(els.spaFamily.value)) els.spaRegion.value = fams.get(els.spaFamily.value);
    const blocker = spaBlocker();
    els.spaRun.classList.toggle('btn-blocked', Boolean(blocker));
    if (blocker && !state.spaResult) {
      els.spaOut.replaceChildren(el('p', { class: 'muted small' }, `Not ready: ${blocker} Or enter these values yourself in the console: Billing and Cost Management → Savings Plans → Purchase Analyzer.`),
        el('a', { class: 'btn btn-ghost btn-sm', href: 'https://console.aws.amazon.com/costmanagement/home#/savings-plans/overview', target: '_blank', rel: 'noopener noreferrer' }, 'Open Savings Plans in the AWS console ↗'));
    }
  }

  /** Prefill from the simulator's current plan and slider. */
  function spaFromSimulator() {
    const p = (state.simPlans || [])[parseInt(els.simPlan.value, 10)];
    if (!p || !Commit) { toast('No simulator plan to copy.'); return; }
    const sim = Commit.simulate(p, parseInt(els.simX.value, 10) / 100);
    if (SPA_TYPE_OF[p.planType]) els.spaType.value = SPA_TYPE_OF[p.planType];
    if (p.planType === 'ec2InstanceSP') { els.spaFamily.value = p.family || ''; els.spaRegion.value = p.region || ''; }
    document.querySelector('input[name="spa-mode"][value="CUSTOM_COMMITMENT"]').checked = true;
    els.spaCommit.value = Math.max(0.001, sim.hourly).toFixed(3);
    renderSpa();
    toast(`Analyzer set to ${SPA_LABEL[els.spaType.value]} at ${els.spaCommit.value}/hr`);
  }

  /** Prefill from the price check's best option. */
  function spaFromCalculator() {
    if (!pc.res) { toast('Run the price check first.'); return; }
    const on = calcRows().filter((r) => r.include && r.od > 0);
    const hourly = (k) => on.reduce((s, r) => s + (r[k] ? r[k].hourly : 0), 0);
    const save = (k) => on.reduce((s, r) => s + (r[k] ? r[k].save : 0), 0);
    const k = save('i') > save('c') ? 'i' : 'c';
    els.spaType.value = k === 'i' ? 'EC2_INSTANCE_SP' : 'COMPUTE_SP';
    if (k === 'i') {
      const top = on.slice().sort((a, b) => b.od - a.od)[0];
      if (top) { els.spaFamily.value = familyOf(top.it.type); els.spaRegion.value = top.p.region || top.it.region; }
    }
    document.querySelector('input[name="spa-mode"][value="CUSTOM_COMMITMENT"]').checked = true;
    els.spaCommit.value = Math.max(0.001, hourly(k)).toFixed(3);
    renderSpa();
    toast(`Analyzer set to ${SPA_LABEL[els.spaType.value]} at ${els.spaCommit.value}/hr`);
  }

  async function runSpa() {
    const blocker = spaBlocker();
    if (blocker) { els.spaOut.replaceChildren(el('p', { class: 'status error' }, blocker)); return; }
    const type = els.spaType.value;
    const mode = spaMode();
    const term = type === 'DATABASE_SP' ? '1y-nu' : els.spTerm.value;
    if (mode === 'CUSTOM_COMMITMENT' && !(parseFloat(els.spaCommit.value) >= 0.001)) {
      els.spaOut.replaceChildren(el('p', { class: 'status error' }, 'Enter an hourly commitment (at least $0.001/hr), or use "From simulator" / "From price check".'));
      els.spaCommit.focus();
      return;
    }
    const params = Object.assign({}, state.awsTargetParams || targetParams(), {
      type, analysisType: mode, term, lookback: els.spaLookback.value,
      commitment: mode === 'CUSTOM_COMMITMENT' ? els.spaCommit.value : '',
      coverage: mode === 'TARGET_AVERAGE_COVERAGE' ? els.spaCov.value : '',
      family: type === 'EC2_INSTANCE_SP' ? els.spaFamily.value.trim() : '',
      region: type === 'EC2_INSTANCE_SP' ? els.spaRegion.value.trim() : '',
    });
    els.spaRun.disabled = true;
    state.spaResult = null;
    const bar = el('div', { class: 'progress indeterminate' }, el('div', { class: 'progress-bar' }));
    const msg = el('p', { class: 'status loading' }, 'Starting the analysis in AWS…');
    els.spaOut.replaceChildren(msg, bar);
    try {
      const res = await Aws.purchaseAnalysis(params, (r, secs) => {
        msg.textContent = `AWS is replaying your last ${params.lookback} days of hourly usage… ${secs}s (usually 1-5 minutes)`;
      });
      if (res.status !== 'SUCCEEDED') {
        const why = { NO_USAGE_FOUND: 'No eligible usage was found for this plan in the selected period (check the family / region, or try a longer lookback).', INVALID_SAVINGS_PLANS_TO_ADD: 'AWS did not accept this plan (check the family, region and term).', INVALID_ACCOUNT_ID: 'AWS did not accept the account ID.' }[res.errorCode];
        throw new Error(why || `Analysis ${res.status}${res.errorCode ? ` (${res.errorCode})` : ''}.`);
      }
      state.spaResult = Object.assign(res, { params });
      renderSpaResult();
      toast('AWS Purchase Analyzer finished');
    } catch (err) {
      els.spaOut.replaceChildren(el('p', { class: 'status error' }, `AWS analysis failed: ${err.message}`));
    } finally {
      els.spaRun.disabled = false;
    }
  }

  function renderSpaResult() {
    const r = state.spaResult;
    if (!r) return;
    const p = r.params;
    const card = (label, value, sub, cls) => el('div', { class: `pc-card ${cls || ''}` }, el('span', null, label), el('strong', null, value), sub ? el('small', null, sub) : null);
    const utilOk = r.utilization >= 95;
    const head = `${SPA_LABEL[p.type]}${p.family ? ` · ${p.family} in ${p.region}` : ''} · ${TERM_LABEL[p.term] || p.term} · last ${p.lookback} days`;

    // Our estimate for the same plan, to compare
    const ours = (state.simPlans || []).find((x) => SPA_TYPE_OF[x.planType] === p.type && (!p.family || x.family === p.family));
    const ourAtSame = ours && Commit ? Commit.simulate(ours, Math.min(1.5, r.hourlyCommitment / Math.max(0.0001, (ours.baselineOD * (1 - ours.discount)) / 730))) : null;

    const verdict = r.monthlySavings <= 0 ? ['bad', 'This commitment would not save money on your recent usage. Lower it or pick another plan.']
      : !utilOk ? ['warn', `It saves money, but only ${r.utilization.toFixed(0)}% of the commitment would be used. Lowering it towards the always-on usage raises utilization.`]
        : ['good', `Safe to buy: about ${r.utilization.toFixed(0)}% utilization and ${money(r.monthlySavings)}/mo savings on your real hourly usage.`];

    els.spaOut.replaceChildren(
      el('p', { class: 'muted small' }, `Result from AWS: ${head}`),
      el('div', { class: `spa-verdict ${verdict[0]}` }, verdict[1]),
      el('div', { class: 'pc-cards' },
        card('Commitment', `${money(r.hourlyCommitment)}/hr`, r.existingHourlyCommitment ? `on top of ${money(r.existingHourlyCommitment)}/hr you own` : `${money(r.hourlyCommitment * 730)}/mo`, 'accent'),
        card('Savings', `${money(r.monthlySavings)}/mo`, `${r.savingsPct.toFixed(0)}% · ROI ${r.roiPct.toFixed(0)}%`, r.monthlySavings > 0 ? 'good' : ''),
        card('Utilization', `${r.utilization.toFixed(0)}%`, utilOk ? 'commitment fully used' : 'some hours unused', utilOk ? 'good' : ''),
        card('Coverage', `${r.currentCoverage.toFixed(0)}% → ${r.estimatedCoverage.toFixed(0)}%`, 'of eligible usage'),
        card('Hourly on-demand', `${money(r.minHourlyOnDemand)}–${money(r.maxHourlyOnDemand)}`, `average ${money(r.avgHourlyOnDemand)}/hr`),
        card('Upfront', money(r.upfront), r.upfront ? 'due at purchase' : 'none')),
      spaChart(r.daily),
      ourAtSame ? el('p', { class: 'small pc-note' }, `Our estimate for ${money(r.hourlyCommitment)}/hr was ${money(ourAtSame.monthlySavings)}/mo; AWS measured ${money(r.monthlySavings)}/mo on your hourly usage. Trust the AWS number when they differ.`) : null,
      el('div', { class: 'pc-actions' },
        (() => { const b = el('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, `Copy ${r.hourlyCommitment.toFixed(3)}/hr`); b.addEventListener('click', () => copyText(r.hourlyCommitment.toFixed(3), 'commitment')); return b; })(),
        el('a', { class: 'btn btn-ghost btn-sm', href: 'https://console.aws.amazon.com/costmanagement/home#/savings-plans/overview', target: '_blank', rel: 'noopener noreferrer' }, 'Buy in the AWS console ↗')));
  }

  /** Daily coverage (now vs with the plan) and utilization lines. */
  function spaChart(daily) {
    if (!daily || daily.length < 2) return null;
    const NS = 'http://www.w3.org/2000/svg';
    const W = 600; const H = 150; const pad = 10;
    const X = (i) => pad + (i / (daily.length - 1)) * (W - pad * 2);
    const Y = (v) => H - pad - (Math.max(0, Math.min(100, v)) / 100) * (H - pad * 2);
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'spa-chart');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Daily coverage before and after the plan, and utilization');
    const line = (key, cls) => {
      const pl = document.createElementNS(NS, 'polyline');
      pl.setAttribute('points', daily.map((d, i) => `${X(i)},${Y(d[key])}`).join(' '));
      pl.setAttribute('class', cls);
      svg.append(pl);
    };
    [25, 50, 75, 100].forEach((v) => {
      const g = document.createElementNS(NS, 'line');
      g.setAttribute('x1', pad); g.setAttribute('x2', W - pad); g.setAttribute('y1', Y(v)); g.setAttribute('y2', Y(v)); g.setAttribute('class', 'spa-grid');
      svg.append(g);
    });
    line('currentCoverage', 'spa-cur'); line('estimatedCoverage', 'spa-est'); line('utilization', 'spa-util');
    return el('div', { class: 'spa-chart-wrap' }, svg,
      el('div', { class: 'sim-legend' },
        el('span', null, el('i', { class: 'lg-cur' }), 'Coverage now'),
        el('span', null, el('i', { class: 'lg-est' }), 'Coverage with plan'),
        el('span', null, el('i', { class: 'lg-util' }), 'Plan utilization'),
        el('span', { class: 'muted' }, `${daily[0].day} → ${daily[daily.length - 1].day}`)));
  }

  // ---- 1. Term finder ----
  function finderPick() {
    const sure = (document.querySelector('input[name="sure"]:checked') || {}).value || 'mid';
    const cash = (document.querySelector('input[name="cash"]:checked') || {}).value || 'none';
    const years = sure === 'high' ? '3y' : '1y';
    const pay = cash === 'all' ? 'au' : cash === 'some' ? 'pu' : 'nu';
    return { key: `${years}-${pay}`, sure, cash };
  }

  function renderFinder(c) {
    const { key, sure } = finderPick();
    const current = els.spTerm.value;
    // Savings for the suggested term from each plan's options (AWS plans only have the selected term)
    let monthly = 0; let upfront = 0; let covered = 0; let awsMissing = false; let otherMissing = [];
    for (const p of c.plans) {
      const o = p.options.find((x) => x.key === key) || (p.planType === 'databaseSP' ? p.options[0] : null);
      if (!o) { if (p.source === 'aws') awsMissing = true; else otherMissing.push(p.label); continue; }
      monthly += o.monthlySavings; upfront += o.upfront; covered += p.coveredOnDemand;
    }
    const known = !awsMissing;
    const notes = [];
    if (otherMissing.length) notes.push(`${otherMissing.join(', ')} ${otherMissing.length > 1 ? 'do' : 'does'} not offer this payment option, so ${otherMissing.length > 1 ? 'they are' : 'it is'} not in this total.`);
    if (sure === 'low') notes.push('Usage may shrink, so commit less: set Target coverage to 50% or use the simulator below.');
    if (key.startsWith('3y') && c.plans.some((p) => p.planType === 'databaseSP')) notes.push('Database Savings Plans are 1-year only; for 3 years databases use Reserved Instances.');
    if (c.coverage && c.coverage.utilizationPct && c.coverage.utilizationPct < 95) notes.push(`Your current plans are only ${c.coverage.utilizationPct.toFixed(0)}% used. Fix that before adding more.`);
    if (upfront > 0 && covered > 0) notes.push(`The upfront payment pays for itself in about ${Math.max(1, Math.ceil(upfront / covered))} month(s) compared with on-demand.`);

    const applied = key === current;
    const btn = el('button', { type: 'button', class: `btn btn-sm ${applied ? 'btn-ghost' : 'btn-primary'}`, disabled: applied }, applied ? '✓ In use' : 'Use this term');
    btn.addEventListener('click', () => {
      if (finderPick().sure === 'low' && !els.spCoverage.disabled) els.spCoverage.value = '0.5';
      els.spTerm.value = key;
      els.spTerm.dispatchEvent(new Event('change'));
      toast(`Savings Plans now use ${TERM_LABEL[key] || key}.`);
    });
    els.finderResult.replaceChildren(
      el('div', { class: 'finder-pick' },
        el('div', null, el('span', { class: 'muted' }, 'Best fit: '), el('strong', null, TERM_LABEL[key] || key),
          known && monthly > 0 ? el('span', { class: 'muted' }, ` · about ${money(monthly)}/mo${upfront > 0 ? `, ${money(upfront)} upfront` : ''}`)
            : !known ? el('span', { class: 'muted' }, ' · apply it to get AWS numbers for this term') : null),
        btn),
      ...(notes.length ? [el('ul', { class: 'finder-notes' }, ...notes.map((n) => el('li', null, n)))] : []));
  }

  // ---- 2. What-if simulator ----
  function renderSim() {
    const plans = state.simPlans || [];
    const p = plans[parseInt(els.simPlan.value, 10)];
    if (!p || !Commit) return;
    const x = parseInt(els.simX.value, 10) / 100;
    const sim = Commit.simulate(p, x);
    const rec = Commit.simulate(p, p.recommendedX);
    els.simX.style.setProperty('--fill', `${(x / 1.5) * 100}%`);
    els.simXOut.textContent = `${Math.round(x * 100)}% of steady usage`;
    const diff = sim.monthlySavings - rec.monthlySavings;
    // With one month of data we cannot see dips, so anything above the recommendation is an unknown risk
    const oneMonth = p.usageFactors.length < 2;
    const risk = x > Math.max(...p.usageFactors) ? 'high' : x > 1 ? 'medium' : oneMonth && x > p.recommendedX + 0.001 ? 'unknown' : 'low';
    const stat = (label, value, cls) => el('div', { class: `sim-stat ${cls || ''}` }, el('span', null, label), el('strong', null, value));
    els.simReadout.replaceChildren(
      stat('Commitment', `${money(sim.hourly)}/hr`),
      stat('Savings / mo', money(sim.monthlySavings), sim.monthlySavings >= 0 ? 'good' : 'bad'),
      stat('vs recommended', `${diff >= 0 ? '+' : '−'}${money(Math.abs(diff))}`, Math.abs(diff) < 0.5 ? '' : diff > 0 ? 'good' : 'bad'),
      stat('Unused / mo', money(sim.wasted), sim.wasted > 0 ? 'bad' : ''),
      stat('Expected use', `${sim.utilizationPct.toFixed(0)}%`, sim.utilizationPct < 95 ? 'bad' : 'good'),
      stat('Risk', { low: 'Low', unknown: 'Unknown: 1 month of data', medium: 'Some months unused', high: 'Pays for unused hours' }[risk], risk === 'low' ? 'good' : 'bad'));
    renderSimChart(p, x);
  }

  function renderSimChart(p, x) {
    const NS = 'http://www.w3.org/2000/svg';
    const W = 320; const H = 120; const pad = 8;
    const pts = [];
    for (let i = 0; i <= 30; i++) pts.push(Commit.simulate(p, i * 0.05));
    const ys = pts.map((s) => s.monthlySavings);
    const max = Math.max(...ys, 1); const min = Math.min(...ys, 0);
    const X = (v) => pad + (v / 1.5) * (W - pad * 2);
    const Y = (v) => H - pad - ((v - min) / (max - min || 1)) * (H - pad * 2);
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const add = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); svg.append(e); return e; };
    add('rect', { x: X(1), y: pad, width: X(1.5) - X(1), height: H - pad * 2, class: 'sim-risk' });
    add('line', { x1: pad, x2: W - pad, y1: Y(0), y2: Y(0), class: 'sim-zero' });
    add('polyline', { points: pts.map((s) => `${X(s.x)},${Y(s.monthlySavings)}`).join(' '), class: 'sim-line' });
    add('line', { x1: X(p.recommendedX), x2: X(p.recommendedX), y1: pad, y2: H - pad, class: 'sim-rec' });
    const cur = Commit.simulate(p, x);
    add('circle', { cx: X(x), cy: Y(cur.monthlySavings), r: 5, class: 'sim-dot' });
    els.simChart.replaceChildren(svg,
      el('div', { class: 'sim-legend' },
        el('span', null, el('i', { class: 'lg-line' }), 'Savings / mo'),
        el('span', null, el('i', { class: 'lg-rec' }), p.source === 'aws' ? 'AWS recommendation' : 'Recommended'),
        el('span', null, el('i', { class: 'lg-risk' }), 'Above steady usage'),
        p.usageFactors.length < 2 ? el('span', { class: 'muted' }, 'One month of data: assumes flat usage') : null));
  }

  // ---- 3. Staged purchase plan ----
  function renderBuyPlan(plans) {
    const today = new Date();
    const term = els.spTerm.value;
    const years = term.startsWith('3y') ? 3 : 1;
    els.buyPlan.replaceChildren(...plans.map((p) => {
      const o = p.recommended;
      const info = PLAN_BUY[p.planType] || PLAN_BUY.computeSP;
      const staged = o.hourlyCommitment >= 0.1 && /SP$/.test(p.planType);
      const first = staged ? Math.round(o.hourlyCommitment * 0.6 * 1000) / 1000 : o.hourlyCommitment;
      const second = staged ? Math.round((o.hourlyCommitment - first) * 1000) / 1000 : 0;
      const expiry = addMonths(today, years * 12);
      const review = addMonths(expiry, -2);
      const copyBtn = (v) => {
        const b = el('button', { type: 'button', class: 'btn btn-ghost btn-sm copy-btn', title: 'Copy hourly commitment' }, `Copy ${fmtHourly(v)}`);
        b.addEventListener('click', () => copyText(fmtHourly(v), 'commitment'));
        return b;
      };
      const cal = el('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, '📅 Renewal reminder');
      cal.addEventListener('click', () => downloadReminder(p, review, expiry));
      const isRi = !/SP$/.test(p.planType);
      const steps = [
        el('li', null, el('strong', null, staged ? 'Today: buy 60%' : 'Today: buy'), ' · ',
          isRi ? `${(p.details || []).slice(0, 3).map((d) => `${d.count}× ${d.instanceType}`).join(', ') || p.scope}` : `${money(first)}/hr`,
          ` · ${o.label}`, isRi ? null : copyBtn(first)),
        staged ? el('li', null, el('strong', null, `${fmtDate(addMonths(today, 1))}: top up 40%`), ` · ${money(second)}/hr, only if the first purchase shows about 100% utilization in Cost Explorer`, copyBtn(second)) : null,
        el('li', null, el('strong', null, `${fmtDate(review)}: review`), ` · the plan ends ${fmtDate(expiry)}. Check usage and renew or resize; expired plans fall back to on-demand prices.`),
      ];
      return el('article', { class: 'buy-card' },
        el('div', { class: 'buy-head' },
          el('div', null,
            el('span', { class: `src-badge ${p.source === 'aws' ? 'aws' : 'est'}` }, p.source === 'aws' ? 'AWS Cost Explorer' : 'Estimate'),
            el('div', { class: 'plan-name' }, p.label),
            el('div', { class: 'plan-note' }, `${money(o.monthlySavings)}/mo savings · ${money(o.hourlyCommitment)}/hr total${o.upfront > 0 ? ` · ${money(o.upfront)} upfront` : ''}`)),
          el('a', { class: 'btn btn-secondary btn-sm', href: info.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open AWS console ↗')),
        el('ol', { class: 'buy-steps' }, ...steps.filter(Boolean)),
        el('p', { class: 'muted small' }, `Where: ${info.where}. Choose ${info.type}, ${o.label}${isRi ? '' : `, hourly commitment ${fmtHourly(first)}`}. `,
          /SP$/.test(p.planType) ? 'Tip: the Savings Plans Purchase Analyzer in the console previews coverage and utilization before you buy.' : ''),
        el('div', { class: 'buy-foot' }, cal));
    }));
  }

  /** .ics calendar file with a reminder before the commitment expires. */
  function downloadReminder(p, review, expiry) {
    const d = (x) => x.toISOString().slice(0, 10).replace(/-/g, '');
    const esc = (s) => String(s).replace(/[\\,;]/g, (m) => `\\${m}`).replace(/\n/g, '\\n');
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CloudLens FinOps//EN', 'BEGIN:VEVENT',
      `UID:${Date.now()}-${p.planType}@cloudlens-finops`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
      `DTSTART;VALUE=DATE:${d(review)}`, `DTEND;VALUE=DATE:${d(new Date(review.getTime() + 86400000))}`,
      `SUMMARY:${esc(`Review ${p.label} before it expires on ${fmtDate(expiry)}`)}`,
      `DESCRIPTION:${esc(`Commitment ${fmtHourly(p.recommended.hourlyCommitment)}/hr (${p.recommended.label}). Check utilization and coverage in Cost Explorer, then renew or resize.`)}`,
      'BEGIN:VALARM', 'TRIGGER:-P7D', 'ACTION:DISPLAY', 'DESCRIPTION:Savings Plan review', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    const a = el('a', { href: url, download: `${p.label.replace(/\W+/g, '_')}_review.ics` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Calendar reminder downloaded');
  }

  function renderEC2(e, card) {
    els.ec2Sp.hidden = !e;
    if (!e) return;
    els.ec2Cards.replaceChildren(
      card('EC2 on-demand / mo', money(e.onDemand), e.covered > 0 ? `${money(e.covered)} already covered` : 'nothing covered today'),
      card('Steady baseline / mo', money(e.baseline), e.optimizationCut > 0 ? `after ${money(e.optimizationCut)} rightsizing/waste` : 'after optimization'),
      card('EC2 coverage', `${e.currentCoveragePct.toFixed(0)}% → ${e.projectedCoveragePct.toFixed(0)}%`, `commit ${money(e.commitOnDemand)}/mo of usage`),
      card('Commitment', `${money(e.hourlyCommitment)}/hr`, e.plans.map((p) => p.label).join(' + ') || '—'),
      card('EC2 SP savings / mo', money(e.monthlySavings), `${money(e.monthlySavings * 12)}/yr`, true),
    );

    const term = els.spTerm.value;
    els.ec2Compare.replaceChildren(...e.comparison.map((row) => {
      const i = row.ec2InstanceSP;
      return el('tr', { class: row.key === term ? 'selected' : null },
        el('th', { scope: 'row' }, row.label),
        el('td', { class: 'num' }, `${money(row.computeSP.monthlySavings)} (${row.computeSP.discountPct.toFixed(0)}%)`),
        el('td', { class: 'num' }, money(row.computeSP.hourlyCommitment)),
        el('td', { class: 'num' }, i ? `${money(i.monthlySavings)} (${i.discountPct.toFixed(0)}%)` : '—'),
        el('td', { class: 'num' }, i ? money(i.hourlyCommitment) : '—'),
        el('td', { class: 'num' }, money(row.computeSP.upfront)));
    }));

    const guidance = e.guidance.slice();
    if (e.aws && (e.aws.computeSP || e.aws.ec2InstanceSP)) {
      const fmt = (a, name) => (a ? `${name}: ${a.monthlySavings > 0 ? `${money(a.monthlySavings)}/mo at ${money(a.hourly)}/hr` : 'no purchase needed'}` : null);
      guidance.unshift(`AWS Cost Explorer (account-wide, ${els.spTerm.selectedOptions[0].text}): ${[fmt(e.aws.computeSP, 'Compute SP'), fmt(e.aws.ec2InstanceSP, 'EC2 Instance SP')].filter(Boolean).join(' · ')}. Pick one; they cover the same usage. The table on the left is our estimate for comparison.`);
    }
    els.ec2Guidance.replaceChildren(...guidance.map((g) => el('li', null, g)));
    els.ec2Families.replaceChildren();
    renderFamilyPlan(e);
  }

  /** Instance family "from → to" table and the family-level Savings Plan summary. */
  function renderFamilyPlan(e) {
    const rows = e.familyPlan || [];
    const fams = e.families || [];
    const awsFams = e.awsFamilies || [];
    els.familyPlan.hidden = !rows.length && !fams.length && !awsFams.length;
    if (els.familyPlan.hidden) return;

    const chip = (head, sub, yes) => el('div', { class: `fam-chip${yes ? ' yes' : ''}` }, el('strong', null, head), el('span', null, sub));
    els.familySummary.replaceChildren(
      ...fams.map((f) => chip(
        `${f.from.length ? `${f.from.join(', ')} → ` : ''}${f.family}`,
        `${f.region} · ${money(f.baseline)}/mo steady · ${f.instanceSP ? 'EC2 Instance SP' : 'Compute SP'}`, f.instanceSP)),
      ...awsFams.map((f) => chip(`${f.family} (AWS)`, `${f.region} · AWS suggests ${money(f.hourly)}/hr EC2 Instance SP · saves ${money(f.monthlySavings)}/mo`, true)));

    const typeCell = (t, cls) => (t ? el('span', { class: `type ${cls || ''}` }, el('code', null, t.type), t.family ? el('small', null, `${t.family} family`) : null) : el('span', { class: 'type remove' }, 'Remove'));
    const CHANGE = { keep: 'Keep', size: 'Smaller size', family: 'New family', 'family+size': 'New family + size', remove: 'Remove' };
    els.familyBody.replaceChildren(...rows.map((r) => el('tr', { class: `fam-${r.change}` },
      el('td', null, el('div', { class: 'res-id' }, r.id), el('div', { class: 'res-meta' }, [r.region, r.environment, r.os].filter(Boolean).join(' · '))),
      el('td', null, typeCell(r.from)),
      el('td', null, el('span', { class: 'fam-arrow', 'aria-hidden': 'true' }, '→ '), typeCell(r.to, r.change !== 'keep' ? 'changed' : '')),
      el('td', null, el('span', { class: `tag${r.change === 'keep' ? '' : ' tag-yes'}` }, CHANGE[r.change] || r.change), r.reason ? el('div', { class: 'res-meta' }, r.reason) : null),
      el('td', { class: 'num' }, money(r.costNow)),
      el('td', { class: 'num' }, r.to ? money(r.steadyAfter) : '—'),
      el('td', null, r.coveredBy),
      el('td', { class: 'num' }, r.commitHourly > 0 ? money(r.commitHourly) : '—'),
      el('td', null, r.graviton ? el('code', null, r.graviton) : el('span', { class: 'muted' }, r.os === 'Windows' ? 'n/a (Windows)' : '—')))));

    const notes = [];
    const moving = rows.filter((r) => r.change === 'family' || r.change === 'family+size');
    if (moving.length) notes.push(`${moving.length} instance(s) change family (${[...new Set(moving.map((r) => `${r.from.family} → ${r.to.family}`))].join(', ')}). Do those moves first; until they are done, a Compute Savings Plan covers both the old and the new family.`);
    if (fams.some((f) => f.instanceSP)) notes.push('EC2 Instance Savings Plans are sized on the "to" families above. Buy them after the instances run on those families.');
    if (rows.some((r) => r.graviton)) notes.push('Graviton options are about 20% cheaper on top. If you may move to Graviton during the term, choose a Compute Savings Plan: an EC2 Instance Savings Plan cannot follow a family change.');
    if (rows.some((r) => r.change === 'remove')) notes.push('Instances marked "Remove" are left out of every commitment.');
    els.familyNotes.replaceChildren(...notes.map((n) => el('li', null, n)));
  }

  function renderSummary(s) {
    const card = (label, value, sub, accent) =>
      el('div', { class: `card${accent ? ' accent' : ''}` },
        el('div', { class: 'card-label' }, label),
        el('div', { class: 'card-value' }, value),
        sub ? el('div', { class: 'card-sub' }, sub) : null);

    els.summary.replaceChildren(
      card('Monthly spend', money(s.totalCost), s.level === 'service'
        ? `${s.serviceCount} services analyzed${s.resourceCount > s.serviceCount ? ` (${s.resourceCount} rows incl. EC2 by type)` : ''}`
        : `${s.resourceCount} resources analyzed`),
      card('Potential savings / mo', money(s.totalSavings), `${s.savingsPct.toFixed(1)}% of spend`, true),
      card('Annual savings', money(s.annualSavings), 'if all actions are applied', true),
      card('Recommendations', String(s.recommendationCount), `${s.byPriority.High} high · ${s.byPriority.Medium} medium · ${s.byPriority.Low} low`),
      card(s.level === 'service' ? 'Items to optimize' : 'Resources to optimize', String(s.affectedResources), 'services, resources and plans with savings'),
    );
  }

  function renderBars(container, data, emptyMsg, savings) {
    // Hide charts that have nothing to show instead of displaying an empty box
    const panel = container.closest('.panel');
    const empty = !data || !data.length || (data.length === 1 && data[0].label === 'Unspecified');
    if (panel && container !== els.chartCategory) {
      panel.hidden = empty;
      const grid = panel.parentElement;
      if (grid && grid.classList.contains('grid-3')) {
        const visible = [...grid.children].filter((c) => !c.hidden).length;
        grid.hidden = visible === 0;
        grid.style.gridTemplateColumns = visible ? `repeat(${visible}, 1fr)` : '';
      }
    }
    if (empty) { container.replaceChildren(el('p', { class: 'muted empty' }, emptyMsg)); return; }
    container.classList.toggle('savings', Boolean(savings));
    const top = data.slice(0, 8);
    if (data.length > 8) {
      top.push({ label: `Other (${data.length - 8})`, value: data.slice(8).reduce((s, d) => s + d.value, 0) });
    }
    const max = Math.max(...top.map((d) => d.value), 1);
    container.replaceChildren(...top.map((d) =>
      el('div', { class: 'bar-row' },
        el('span', { class: 'bar-label', title: d.label }, d.label),
        el('span', { class: 'bar-track', role: 'img', 'aria-label': `${d.label}: ${money(d.value)}` },
          el('span', { class: 'bar-fill', style: `width:${Math.max(2, (d.value / max) * 100).toFixed(1)}%;display:block` })),
        el('span', { class: 'bar-value' }, money(d.value, true)))));
  }

  const PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };

  function filteredRecs() {
    if (!state.result) return [];
    const q = els.fSearch.value.trim().toLowerCase();
    const p = els.fPriority.value;
    const c = els.fCategory.value;
    const list = state.result.recommendations.filter((r) =>
      (!p || r.priority === p) &&
      (!c || r.category === c) &&
      (!q || `${r.resourceId} ${r.service} ${r.title} ${r.detail} ${r.region} ${r.environment} ${r.instanceType}`.toLowerCase().includes(q)));

    const sort = els.fSort.value;
    list.sort((a, b) => {
      if (sort === 'savings') return b.monthlySavings - a.monthlySavings;
      if (sort === 'cost') return b.currentCost - a.currentCost;
      return (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) || (b.monthlySavings - a.monthlySavings);
    });
    return list;
  }

  function renderDoneProgress() {
    const all = (state.result && state.result.recommendations) || [];
    if (!all.length) { els.doneProgress.replaceChildren(); return; }
    const done = all.filter(isDone);
    const captured = done.reduce((s, r) => s + r.monthlySavings, 0);
    const total = all.reduce((s, r) => s + r.monthlySavings, 0) || 1;
    const pct = Math.round((captured / total) * 100);
    els.doneProgress.replaceChildren(
      el('div', { class: 'done-text' },
        done.length
          ? [el('strong', null, `${done.length} of ${all.length} done`), ` · ${money(captured)}/mo captured (${pct}% of possible savings)`]
          : 'Tick the box next to each action once you have done it to track your progress.'),
      el('div', { class: 'done-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Savings captured' },
        el('span', { class: 'done-fill', style: `width:${pct}%` })));
  }

  function renderTable() {
    let list = filteredRecs();
    if (els.fHideDone.checked) list = list.filter((r) => !isDone(r));
    const total = list.reduce((s, r) => s + r.monthlySavings, 0);
    els.recCount.textContent = `${list.length} · ${money(total)}/mo`;
    els.recEmpty.hidden = list.length > 0;
    renderDoneProgress();

    const frag = document.createDocumentFragment();
    state.recByKey = new Map(list.map((x) => [recKey(x), x]));
    for (const r of list) {
      const meta = [r.service, r.instanceType, r.region, r.environment].filter(Boolean).join(' · ');
      const done = isDone(r);
      const box = el('input', { type: 'checkbox', class: 'done-box', 'aria-label': `Mark "${r.title}" as done`, checked: done });
      box.addEventListener('change', () => {
        setDone(r, box.checked);
        box.closest('tr').classList.toggle('done', box.checked);
        renderDoneProgress();
        renderStart();
        renderRoadmap(state.result);
        renderTabs();
        toast(box.checked ? `Nice. ${r.monthlySavings > 0 ? `${money(r.monthlySavings)}/mo marked as captured.` : 'Marked as done.'}` : 'Marked as not done.');
        if (box.checked && els.fHideDone.checked) setTimeout(renderTable, 400);
      });
      frag.append(el('tr', { class: done ? 'done' : null, 'data-key': recKey(r) },
        el('td', { class: 'done-cell' }, box),
        el('td', null, el('span', { class: `badge badge-${r.priority}` }, r.priority)),
        el('td', null, el('div', { class: 'res-id' }, r.resourceId), meta ? el('div', { class: 'res-meta' }, meta) : null),
        el('td', null, r.category),
        el('td', null,
          r.source === 'aws' ? el('span', { class: 'src-badge aws', title: 'Figures from AWS for your account' }, 'AWS ✓') : null,
          el('div', { class: 'rec-title' }, r.title), el('div', { class: 'rec-detail' }, r.detail)),
        el('td', { class: 'num' }, money(r.currentCost)),
        el('td', { class: 'num savings' }, r.monthlySavings > 0 ? money(r.monthlySavings) : '—'),
        el('td', null, r.effort)));
    }
    els.recBody.replaceChildren(frag);
  }

  function renderMapping() {
    const fields = Object.keys(Engine.FIELD_LABELS);
    els.mapping.replaceChildren(...fields.map((f) => {
      const id = `map-${f}`;
      const select = el('select', { id, class: 'select select-sm', 'data-field': f },
        el('option', { value: '' }, '— not mapped —'),
        ...state.headers.map((h) => el('option', { value: h, selected: state.mapping[f] === h }, h)));
      return el('div', { class: `mapping-field${f === 'cost' ? ' required' : ''}` },
        el('label', { for: id }, Engine.FIELD_LABELS[f]), select);
    }));
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  function exportResults() {
    if (!state.result || !ensureXlsx()) return;
    const r = state.result;
    const wb = XLSX.utils.book_new();

    const recs = filteredRecs().map((x) => ({
      Status: isDone(x) ? 'Done' : 'Open',
      Priority: x.priority, 'Resource ID': x.resourceId, Service: x.service, 'Instance Type': x.instanceType,
      Region: x.region, Environment: x.environment, Category: x.category, Recommendation: x.title,
      Details: x.detail, Effort: x.effort, 'Current Monthly Cost': x.currentCost,
      'Est. Monthly Savings': x.monthlySavings, 'Est. Annual Savings': Math.round(x.monthlySavings * 1200) / 100,
      ...playbookColumns(x),
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(recs), 'Recommendations');

    const s = r.summary;
    const summaryRows = [
      ['Metric', 'Value'],
      ['Currency', state.currency],
      ['Total monthly spend', s.totalCost],
      ['Potential monthly savings', s.totalSavings],
      ['Potential annual savings', s.annualSavings],
      ['Savings %', s.savingsPct],
      ['Resources analyzed', s.resourceCount],
      ['Recommendations', s.recommendationCount],
      [],
      ['Category', 'Count', 'Monthly savings'],
      ...Object.entries(s.byCategory).map(([k, v]) => [k, v.count, v.savings]),
      [],
      ['Insights'],
      ...r.insights.map((i) => [i.text]),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows), 'Summary');

    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(r.serviceSavings.map((s) => ({
      Service: s.service, Resources: s.resourceCount, 'Current Monthly Cost': s.cost,
      'Optimization Savings / mo': s.optimizationSavings, 'Savings Plan / RI Savings / mo': s.commitmentSavings,
      'Total Savings / mo': s.totalSavings, 'Total Savings / yr': Math.round(s.totalSavings * 1200) / 100,
      'Savings %': s.savingsPct, 'Optimized Monthly Cost': s.optimizedCost,
      'Recommended Actions': s.actions.map((a) => `${a.title}${a.savings > 0 ? ` (${a.savings})` : ''}`).join('; '),
    }))), 'Service Savings');

    if (state.pdf) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(state.pdf.lineItems.map((i) => ({
        Service: i.service, Region: i.region, 'Usage Type': i.usageType, Description: i.description,
        Quantity: i.quantity, Unit: i.unit, Amount: i.cost,
      }))), 'PDF Line Items');
    }

    if (r.commitments && r.commitments.ec2) {
      const e = r.commitments.ec2;
      const ec2Rows = [
        ['EC2 Savings Plan'],
        ['EC2 on-demand / mo', e.onDemand], ['Already covered / mo', e.covered], ['Rightsizing/waste excluded / mo', e.optimizationCut],
        ['Steady baseline / mo', e.baseline], ['Usage to commit / mo', e.commitOnDemand],
        ['Coverage now %', e.currentCoveragePct], ['Coverage after %', e.projectedCoveragePct],
        ['Recommended plan(s)', e.plans.map((p) => `${p.label} (${p.scope})`).join(' + ')],
        ['Hourly commitment', e.hourlyCommitment], ['Monthly savings', e.monthlySavings],
        [],
        ['Term', 'Compute SP savings / mo', 'Compute SP discount %', 'Compute SP / hr', 'EC2 Instance SP savings / mo', 'EC2 Instance SP discount %', 'EC2 Instance SP / hr', 'Upfront'],
        ...e.comparison.map((x) => [x.label, x.computeSP.monthlySavings, x.computeSP.discountPct, x.computeSP.hourlyCommitment,
          x.ec2InstanceSP ? x.ec2InstanceSP.monthlySavings : '', x.ec2InstanceSP ? x.ec2InstanceSP.discountPct : '',
          x.ec2InstanceSP ? x.ec2InstanceSP.hourlyCommitment : '', x.computeSP.upfront]),
        [],
        ['Guidance'], ...e.guidance.map((g) => [g]),
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ec2Rows), 'EC2 Savings Plan');
      if (e.familyPlan && e.familyPlan.length) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(e.familyPlan.map((f) => ({
          Instance: f.id, Region: f.region, Environment: f.environment, OS: f.os || 'Linux',
          'From Type': f.from.type, 'From Family': f.from.family,
          'To Type': f.to ? f.to.type : 'Remove', 'To Family': f.to ? f.to.family : '',
          Change: f.change, Why: f.reason, 'Cost Now / mo': f.costNow, 'Steady After / mo': f.to ? f.steadyAfter : 0,
          'Covered By': f.coveredBy, 'Commit / hr': f.commitHourly, 'Plan Savings / mo': f.planSavings, 'Graviton Option': f.graviton,
        }))), 'EC2 Families');
      }
    }

    if (r.commitments) {
      const plans = r.commitments.plans.flatMap((p) => p.options.map((o) => ({
        Plan: p.label, Scope: p.scope, 'Applies To': p.appliesTo, Option: o.label,
        Recommended: o.key === p.recommended.key ? 'Yes' : '',
        'On-Demand Covered / mo': p.coveredOnDemand, 'Discount %': o.discountPct, 'Commitment / hr': o.hourlyCommitment,
        'Savings / mo': o.monthlySavings, Upfront: o.upfront, 'Total Term Savings': o.totalTermSavings, Rationale: p.rationale,
      })));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(plans.length ? plans : [{ Plan: 'No eligible on-demand spend' }]), 'Savings Plans');

      // Staged purchase plan (60% now, 40% after a month of good utilization)
      const years = els.spTerm.value.startsWith('3y') ? 3 : 1;
      const buy = r.commitments.plans.filter((p) => p.recommended.monthlySavings > 0).flatMap((p) => {
        const o = p.recommended;
        const staged = o.hourlyCommitment >= 0.1 && /SP$/.test(p.planType);
        const first = staged ? Math.round(o.hourlyCommitment * 600) / 1000 : o.hourlyCommitment;
        const base = { Plan: p.label, Source: p.source === 'aws' ? 'AWS Cost Explorer' : 'Estimate', Term: o.label };
        const rows = [Object.assign({}, base, { Step: staged ? 'Buy 60% now' : 'Buy now', When: fmtDate(new Date()), 'Commitment / hr': first })];
        if (staged) rows.push(Object.assign({}, base, { Step: 'Top up 40% if utilization ~100%', When: fmtDate(addMonths(new Date(), 1)), 'Commitment / hr': Math.round((o.hourlyCommitment - first) * 1000) / 1000 }));
        rows.push(Object.assign({}, base, { Step: 'Review before expiry', When: fmtDate(addMonths(new Date(), years * 12 - 2)), 'Commitment / hr': '' }));
        return rows;
      });
      if (buy.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(buy), 'Purchase Plan');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(r.commitments.services.map((s) => ({
        Service: s.service, 'Monthly Cost': s.cost, 'On-Demand': s.onDemand, 'Covered Today': s.covered,
        'Coverage %': s.eligible ? s.coveragePct : '', 'Commitment Option': s.eligible ? s.plan : 'Not eligible', Notes: s.notes,
      }))), 'Service Eligibility');
    }

    const base = state.fileName.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_') || 'finops';
    XLSX.writeFile(wb, `${base}_finops_recommendations.xlsx`);
    toast(`Report downloaded: ${base}_finops_recommendations.xlsx`);
  }

  function playbookColumns(x) {
    if (!Playbooks) return {};
    const pb = Playbooks.forRec(x);
    const ex = Playbooks.explain(x);
    return {
      Confidence: ex.confidence, 'How Estimated': ex.basis, 'Time To Do': pb.time, Risk: pb.risk,
      Steps: pb.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
      'AWS CLI': pb.cli.map((c) => `# ${c.label}\n${c.cmd}`).join('\n'),
      'Check It Worked': pb.verify,
    };
  }

  function downloadTemplate() {
    if (!ensureXlsx()) return;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(window.FINOPS_SAMPLE), 'Resources');
    const guide = [['Column', 'Required', 'Description'],
      ['Resource ID', 'Recommended', 'Unique resource identifier or name'],
      ['Service', 'Recommended', 'EC2, RDS, EBS, S3, Virtual Machines, Compute Engine…'],
      ['Monthly Cost', 'Yes', 'Monthly cost of the resource'],
      ['CPU Utilization %', 'Recommended', 'Average CPU % (0-100 or 0-1)'],
      ['Memory Utilization %', 'Optional', 'Average memory %'],
      ['Instance Type', 'Optional', 'e.g. m5.xlarge, Standard_D4s_v3, n2-standard-4'],
      ['Region', 'Optional', 'Cloud region'],
      ['Environment', 'Optional', 'Production, Staging, Dev, Test…'],
      ['Owner', 'Optional', 'Owning team / cost center'],
      ['Usage Hours', 'Optional', 'Hours running per month (730 = 24/7)'],
      ['Pricing Model', 'Optional', 'On-Demand, Reserved, Savings Plan, Spot'],
      ['Status', 'Optional', 'running, stopped, unattached, unassociated…'],
      ['Storage Type', 'Optional', 'gp2, gp3, io1, Standard, Premium SSD…'],
      ['Last Used', 'Optional', 'Date the resource was last used/accessed'],
      ['Created Date', 'Optional', 'Creation date (used for snapshot age)']];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(guide), 'Column Guide');
    XLSX.writeFile(wb, 'finops_template.xlsx');
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  els.currency.value = state.currency;
  els.currency.addEventListener('change', () => {
    state.currency = els.currency.value;
    localStorage.setItem('finops.currency', state.currency);
    if (state.result) renderAll();
  });

  els.fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

  ['dragenter', 'dragover'].forEach((ev) => els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((ev) => els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('dragover');
  }));
  els.dropzone.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));
  // Prevent the browser from opening files dropped outside the zone
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  $('btn-sample').addEventListener('click', loadSample);
  $('btn-template').addEventListener('click', downloadTemplate);
  $('btn-export').addEventListener('click', exportResults);
  $('btn-new').addEventListener('click', () => els.fileInput.click());
  $('btn-clear-filters').addEventListener('click', () => {
    els.fSearch.value = ''; els.fPriority.value = ''; els.fCategory.value = ''; els.fHideDone.checked = false;
    renderTable();
  });
  els.fHideDone.addEventListener('change', renderTable);
  // Build the playbook the first time a row is opened (ui.js toggles the row right after)
  els.recBody.addEventListener('click', (e) => { if (!e.target.closest('.rec-more')) ensureMore(e.target.closest('tr')); });
  els.recBody.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr')) ensureMore(e.target); });

  // "/" focuses search, Esc clears it
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (e.key === '/' && !typing && state.result) { e.preventDefault(); els.fSearch.focus(); els.fSearch.select(); }
    else if (e.key === 'Escape' && document.activeElement === els.fSearch && els.fSearch.value) { els.fSearch.value = ''; renderTable(); }
  });
  els.sheetSelect.addEventListener('change', () => loadSheet(els.sheetSelect.value));

  els.mapping.addEventListener('change', (e) => {
    const f = e.target.dataset.field;
    if (!f) return;
    if (e.target.value) {
      // A header can only map to one field
      for (const k of Object.keys(state.mapping)) if (state.mapping[k] === e.target.value) delete state.mapping[k];
      state.mapping[f] = e.target.value;
    } else {
      delete state.mapping[f];
    }
    run(false);
  });

  els.svcShow.addEventListener('change', renderServiceSavings);
  els.pdfTop.addEventListener('change', renderPdf);
  els.spCoverage.addEventListener('change', () => { if (state.headers.length) run(false); });
  els.spTerm.addEventListener('change', async () => {
    if (!state.headers.length) return;
    if (state.aws) {
      // AWS recommendations depend on the term: ask again (server cache makes repeats free)
      setStatus('Getting AWS recommendations for this term…', 'loading');
      try { state.aws = await fetchAws(false); } catch (err) { toast(`AWS request failed: ${err.message}`); }
    }
    run(false);
  });
  $('btn-go-actions').addEventListener('click', () => setTab('actions'));
  els.btnPriceCheck.addEventListener('click', () => { pc.res = null; runPriceCheck(); });
  els.spaRun.addEventListener('click', runSpa);
  $('spa-from-sim').addEventListener('click', spaFromSimulator);
  $('spa-from-calc').addEventListener('click', spaFromCalculator);
  [els.spaType, els.spaCov, els.spaFamily].forEach((n) => n.addEventListener('input', renderSpa));
  document.querySelectorAll('input[name="spa-mode"]').forEach((n) => n.addEventListener('change', renderSpa));
  let manualTimer;
  els.priceManual.addEventListener('input', () => { clearTimeout(manualTimer); manualTimer = setTimeout(() => { if (state.result) renderPriceCheckIdle(); }, 300); });
  $('compare-close').addEventListener('click', () => { state.compareHidden = true; els.comparePanel.hidden = true; });
  // Savings Plan tools
  document.querySelectorAll('input[name="sure"], input[name="cash"]').forEach((r) => r.addEventListener('change', () => {
    if (state.result && state.result.commitments) renderFinder(state.result.commitments);
  }));
  els.simX.addEventListener('input', renderSim);
  els.simPlan.addEventListener('change', () => {
    const p = (state.simPlans || [])[parseInt(els.simPlan.value, 10)];
    if (p) els.simX.value = String(Math.round(p.recommendedX * 100));
    renderSim();
  });
  $('sim-reset').addEventListener('click', () => {
    const p = (state.simPlans || [])[parseInt(els.simPlan.value, 10)];
    if (p) { els.simX.value = String(Math.round(p.recommendedX * 100)); renderSim(); }
  });
  $('sim-copy').addEventListener('click', () => {
    const p = (state.simPlans || [])[parseInt(els.simPlan.value, 10)];
    if (p) copyText(fmtHourly(Commit.simulate(p, parseInt(els.simX.value, 10) / 100).hourly), `${p.label} commitment`);
  });
  $('btn-verify-top').addEventListener('click', verifyWithAws);
  tabKeys(els.resultTabs, (b) => setTab(b.dataset.tabId, false));

  // Start options: "Upload a file" / "Connect AWS account"
  function setStartTab(which) {
    const aws = which === 'aws';
    els.tabFile.setAttribute('aria-selected', String(!aws)); els.tabFile.tabIndex = aws ? -1 : 0;
    els.tabAws.setAttribute('aria-selected', String(aws)); els.tabAws.tabIndex = aws ? 0 : -1;
    els.optFile.hidden = aws; els.optAws.hidden = !aws;
  }
  els.tabFile.addEventListener('click', () => setStartTab('file'));
  els.tabAws.addEventListener('click', () => setStartTab('aws'));
  tabKeys(els.tabFile.parentElement, (b) => setStartTab(b === els.tabAws ? 'aws' : 'file'));

  els.btnAwsAnalyze.addEventListener('click', analyzeAwsAccount);
  [els.awsAccount, els.awsRole].forEach((i) => i.addEventListener('input', updateTargetHelp));
  els.awsMode.addEventListener('change', updateTargetHelp);
  els.awsAccount.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !els.btnAwsAnalyze.disabled) analyzeAwsAccount(); });
  els.btnAwsVerify.addEventListener('click', verifyWithAws);
  els.awsLookback.addEventListener('change', () => { if (state.aws) (state.awsSource ? analyzeAwsAccount : verifyWithAws)(); });
  checkConnector();

  let searchTimer;
  els.fSearch.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderTable, 150); });
  [els.fPriority, els.fCategory, els.fSort].forEach((s) => s.addEventListener('change', renderTable));
})();