/* Interaction layer: theme, scroll progress, card spotlight, count-up, value flash, expandable rows.
   Purely presentational; it observes the DOM that app.js renders and never changes data. */
(function () {
  'use strict';

  const root = document.documentElement;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (id) => document.getElementById(id);

  // ---- Theme toggle -------------------------------------------------------
  const toggle = $('theme-toggle');
  function applyTheme(theme) {
    if (theme === 'light') root.dataset.theme = 'light'; else delete root.dataset.theme;
    const light = theme === 'light';
    toggle.textContent = light ? '☾' : '☀';
    toggle.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
  }
  applyTheme(root.dataset.theme === 'light' ? 'light' : 'dark');
  toggle.addEventListener('click', () => {
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try { localStorage.setItem('finops.theme', next); } catch (_) { /* storage blocked */ }
  });

  // ---- Scroll progress + back to top ---------------------------------------
  const progress = document.querySelector('.scroll-progress');
  const toTop = $('to-top');
  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? Math.min(1, window.scrollY / max) : 0;
      progress.style.setProperty('--progress', p.toFixed(4));
      toTop.classList.toggle('show', window.scrollY > 600);
      ticking = false;
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  toTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' }));

  // ---- Card cursor spotlight (delegated) -----------------------------------
  document.addEventListener('pointermove', (e) => {
    const card = e.target.closest && e.target.closest('.card');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  }, { passive: true });

  // ---- Number count-up / flash ---------------------------------------------
  // Only animates plain "1,234.56"-style numbers; anything else is left as-is.
  const NUM = /^(\D*?)(\d{1,3}(?:,\d{2,3})*(?:\.\d+)?|\d+(?:\.\d+)?)(.*)$/s;

  function countUp(node) {
    const original = node.textContent;
    const m = NUM.exec(original);
    if (!m || reduceMotion) return;
    const [, prefix, numStr, suffix] = m;
    const target = parseFloat(numStr.replace(/,/g, ''));
    if (!Number.isFinite(target) || target === 0) return;
    const decimals = (numStr.split('.')[1] || '').length;
    const grouped = numStr.includes(',');
    const fmt = (v) => {
      const s = v.toFixed(decimals);
      if (!grouped) return s;
      const [i, d] = s.split('.');
      return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (d ? `.${d}` : '');
    };
    const start = performance.now();
    const dur = 900;
    const step = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      if (t < 1) { node.textContent = prefix + fmt(target * eased) + suffix; requestAnimationFrame(step); }
      else node.textContent = original; // always end on the exact formatted value
    };
    requestAnimationFrame(step);
  }

  function flash(node) {
    node.classList.remove('flash');
    void node.offsetWidth; // restart animation
    node.classList.add('flash');
  }

  // Remember the last values per container so re-renders (term/coverage changes) can flash what changed.
  const lastValues = new WeakMap();
  function watchValues(container, isNewData) {
    if (!container) return;
    new MutationObserver(() => {
      const nodes = [...container.querySelectorAll('.card-value')];
      const prev = lastValues.get(container) || [];
      const fresh = isNewData();
      nodes.forEach((n, i) => {
        if (fresh) countUp(n);
        else if (prev[i] != null && prev[i] !== n.textContent) flash(n);
      });
      lastValues.set(container, nodes.map((n) => n.textContent));
    }).observe(container, { childList: true });
  }

  // ---- Reveal on new data ---------------------------------------------------
  const results = $('results');
  const meta = $('file-meta');
  let lastMeta = '';
  let freshUntil = 0;
  const isNewData = () => performance.now() < freshUntil;

  new MutationObserver(() => {
    if (meta.textContent === lastMeta) return;
    lastMeta = meta.textContent;
    freshUntil = performance.now() + 300; // card containers render in the same task
    results.classList.remove('reveal');
    void results.offsetWidth;
    results.classList.add('reveal');
  }).observe(meta, { childList: true, characterData: true, subtree: true });

  ['summary', 'sp-cards', 'ec2-cards'].forEach((id) => watchValues($(id), isNewData));

  // ---- Expandable recommendation rows ---------------------------------------
  const recBody = $('rec-body');
  new MutationObserver(() => {
    for (const tr of recBody.rows) {
      if (tr.hasAttribute('tabindex')) continue;
      tr.tabIndex = 0;
      tr.setAttribute('aria-expanded', 'false');
      tr.title = 'Click to expand details';
    }
  }).observe(recBody, { childList: true });

  function toggleRow(tr) {
    const open = tr.classList.toggle('expanded');
    tr.setAttribute('aria-expanded', String(open));
  }
  recBody.addEventListener('click', (e) => {
    // Clicks inside the opened playbook (steps, commands) should not collapse the row
    if (e.target.closest('a, button, input, select, .rec-more') || window.getSelection().toString()) return;
    const tr = e.target.closest('tr');
    if (tr) toggleRow(tr);
  });
  recBody.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr')) { e.preventDefault(); toggleRow(e.target); }
  });
})();
