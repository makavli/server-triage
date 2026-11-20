// Search, copy, the offline copy and the Install button. The page reads in full without it.
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const q = $('#q');
  const none = $('#none');
  const status = $('#status');
  const toast = $('#toast');

  // Each entry is searched by its own text and by the names of its section and group.
  const sections = [...document.querySelectorAll('main section')].map((el) => ({
    el,
    groups: [...el.querySelectorAll('.grp')].map((g) => ({
      el: g,
      items: [...g.querySelectorAll('[data-in]')].map((it) => ({ el: it, text: `${it.dataset.in} ${it.textContent}`.toLowerCase() })),
    })),
  }));

  // Every word must match, in any order: "postgresql lock" finds the lock rows of the PostgreSQL section.
  function search() {
    const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const s of sections) {
      let any = false;
      for (const g of s.groups) {
        let hit = false;
        for (const it of g.items) {
          const ok = words.every((w) => it.text.includes(w));
          it.el.hidden = !ok;
          if (ok) { hit = true; shown++; }
        }
        g.el.hidden = !hit;
        any ||= hit;
      }
      s.el.hidden = !any;
    }
    none.hidden = shown > 0;
    status.textContent = words.length ? `${shown} ${shown === 1 ? 'entry matches' : 'entries match'}` : '';
  }
  q.addEventListener('input', search);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && q.value) { q.value = ''; search(); }
  });
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); q.focus(); q.select(); }
  });

  let timer;
  function say(msg) {
    toast.textContent = msg;
    toast.classList.add('on');
    status.textContent = msg;
    clearTimeout(timer);
    timer = setTimeout(() => toast.classList.remove('on'), 1600);
  }

  // A command copies on click, Enter or Space. Where the clipboard is refused, it is selected for Ctrl+C instead.
  async function copy(el) {
    try {
      await navigator.clipboard.writeText(el.textContent);
      say('Copied');
    } catch {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      say('Selected. Press Ctrl+C to copy');
    }
  }
  for (const k of document.querySelectorAll('code.k')) {
    k.tabIndex = 0;
    k.setAttribute('role', 'button');
    k.title = 'Copy';
  }
  document.addEventListener('click', (e) => {
    const k = e.target.closest?.('code.k');
    if (k && !String(getSelection())) copy(k); // a drag that selects part of a command is left alone
  });
  document.addEventListener('keydown', (e) => {
    const k = e.target.closest?.('code.k');
    if (k && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); copy(k); }
  });

  // The app's manifest and offline copy, over http(s) only: a page opened from disk is offline already, and the
  // browser refuses a manifest there. Trusted Types guard the worker's URL, as the page's policy requires.
  const served = /^https?:$/.test(location.protocol);
  if (served) {
    const link = document.createElement('link');
    link.rel = 'manifest';
    link.href = 'manifest.webmanifest';
    document.head.append(link);
  }
  if (served && 'serviceWorker' in navigator) {
    const tt = window.trustedTypes;
    const url = tt
      ? tt.createPolicy('triage', { createScriptURL: (u) => { if (u !== 'sw.js') throw new TypeError(`refused worker ${u}`); return u; } }).createScriptURL('sw.js')
      : 'sw.js';
    navigator.serviceWorker.register(url).catch((err) => console.warn('No offline copy:', err.message));
  }

  // Edge and Chrome offer to install the page as an app; the button appears only when they would.
  const install = $('#install');
  let offer = null;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); offer = e; install.hidden = false; });
  install.addEventListener('click', async () => {
    if (!offer) return;
    install.hidden = true;
    offer.prompt();
    await offer.userChoice;
    offer = null;
  });
  addEventListener('appinstalled', () => { install.hidden = true; offer = null; });

  document.documentElement.dataset.ready = '1';
})();
