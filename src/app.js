// The page's behaviour: search, copy, the Setup panel (your values for the blanks, filters, your data), pins, notes,
// your own entries, links to one entry, the offline copy and the Install button. The page reads in full without it.
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const q = $('#q');
  const none = $('#none');
  const status = $('#status');
  const toast = $('#toast');
  const setup = $('#setup');
  const form = $('#mine-form');
  const HOME = 'https://makavli.github.io/server-triage/'; // the link to an entry, when the page is opened from disk
  const served = /^https?:$/.test(location.protocol);
  const BLANKS = $$('input[data-p]', setup).map((i) => i.dataset.p);
  const ENGINES = $$('input[data-engine]', setup).map((i) => i.dataset.engine);
  const BLANK = BLANKS.length ? new RegExp(`\\b(${BLANKS.join('|')})\\b`, 'g') : null;

  let timer;
  function say(msg) {
    toast.textContent = msg;
    toast.classList.add('on');
    status.textContent = msg;
    clearTimeout(timer);
    timer = setTimeout(() => toast.classList.remove('on'), 1800);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Your data: IndexedDB, one record per pin, note and entry, so two open tabs never overwrite each other's work.
  // Where the browser refuses storage, everything works until the page closes, and Setup says so.
  const db = (() => {
    const STORES = ['pins', 'notes', 'entries', 'prefs'];
    let conn = null;
    const ask = (r) => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    function open() {
      conn ??= new Promise((ok, no) => {
        const r = indexedDB.open('server-triage', 1);
        r.onupgradeneeded = () => { for (const s of STORES) r.result.createObjectStore(s, { keyPath: 'id' }); };
        r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); ok(r.result); };
        r.onerror = () => no(r.error);
      });
      return conn;
    }
    async function write(stores, fn) {
      const t = (await open()).transaction(stores, 'readwrite');
      const done = new Promise((ok, no) => { t.oncomplete = ok; t.onerror = () => no(t.error); t.onabort = () => no(t.error); });
      fn((s) => t.objectStore(s));
      t.commit?.(); // commit now, not at the end of the task: a tab closed right after a change keeps it
      return done;
    }
    return {
      async all() {
        const t = (await open()).transaction(STORES);
        return Object.fromEntries(await Promise.all(STORES.map(async (s) => [s, await ask(t.objectStore(s).getAll())])));
      },
      put: (store, rec) => write([store], (s) => s(store).put(rec)),
      del: (store, id) => write([store], (s) => s(store).delete(id)),
      batch: (fn) => write(STORES, fn), // an import or a wipe: all of it or none of it
    };
  })();

  const state = { pins: new Map(), notes: new Map(), entries: new Map(), values: {}, filters: { read: false, distro: '', versions: {} }, kept: true };

  // Everything that reaches the state passes here: a file you import, and what the database hands back. Unknown
  // fields are dropped, sizes are capped, and text only ever reaches the page as text.
  const ID = /^[a-z0-9][a-z0-9-]{0,119}$/;
  const MINE = /^mine-[0-9a-f]{16}$/;
  const VER = /^\d{1,4}(?:\.\d{1,4}){0,3}$/;
  const str = (v, max) => typeof v === 'string' && v.length <= max;
  const list = (v) => (Array.isArray(v) ? v.slice(0, 5000) : []);
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const time = (v) => (Number.isFinite(v) ? v : Date.now());
  // Characters a screen hides or reorders (controls, zero-width and bidi marks): the command you paste must be the one
  // you read. A file that holds them is refused and typing drops them; a value is one line, so tab and newline too.
  const IN_CODE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
  const IN_VALUE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
  const shown = (v, max, re) => str(v, max) && v.replace(re, '') === v;
  const MAX_ENTRIES = 1000;
  function clean(raw) {
    const o = obj(raw);
    const f = obj(o.filters);
    return {
      pins: list(o.pins).filter((p) => str(p?.id, 120) && ID.test(p.id)).map((p) => ({ id: p.id, at: time(p.at) })),
      notes: list(o.notes).filter((n) => str(n?.id, 120) && ID.test(n.id) && str(n.text, 4000) && n.text.trim())
        .map((n) => ({ id: n.id, text: n.text })),
      entries: list(o.entries)
        .filter((e) => str(e?.id, 21) && MINE.test(e.id) && ['cmd', 'err'].includes(e.kind) && shown(e.code, 4000, IN_CODE) && e.code.trim() && str(e.text ?? '', 4000))
        .map((e) => ({ id: e.id, kind: e.kind, code: e.code, text: e.text ?? '', at: time(e.at) })),
      values: Object.fromEntries(Object.entries(obj(o.values)).filter(([k, v]) => BLANKS.includes(k) && shown(v, 200, IN_VALUE) && v.trim())),
      filters: {
        read: f.read === true,
        distro: ['deb', 'rhel'].includes(f.distro) ? f.distro : '',
        versions: Object.fromEntries(Object.entries(obj(f.versions)).filter(([k, v]) => ENGINES.includes(k) && str(v, 19) && VER.test(v))),
      },
    };
  }

  function adopt(c) {
    state.pins = new Map(c.pins.map((p) => [p.id, p.at]));
    state.notes = new Map(c.notes.map((n) => [n.id, n.text]));
    state.entries = new Map(c.entries.map((e) => [e.id, e]));
    state.values = c.values;
    state.filters = c.filters;
  }

  async function load() {
    try {
      // A database that never answers (another tab mid-upgrade, a stuck profile) must not hold the sheet back.
      const all = await Promise.race([db.all(), new Promise((_, no) => { setTimeout(() => no(new Error('no answer')), 4000); })]);
      const pref = (id) => all.prefs.find((p) => p.id === id)?.value;
      adopt(clean({ ...all, values: pref('values'), filters: pref('filters') }));
    } catch {
      state.kept = false;
    }
  }

  let chan = null;
  try { chan = new BroadcastChannel('server-triage'); } catch { /* no other tab hears of changes */ }
  let persisted = false;
  // Saves in the background; a refusal turns the page into a session-only one, and Setup says so.
  function keep(p) {
    p.then(() => {
      chan?.postMessage('changed');
      if (!persisted) { persisted = true; navigator.storage?.persist?.().catch(() => {}); } // ask once not to be evicted
    }).catch(() => { state.kept = false; summary(); });
  }
  const savePref = (id) => keep(db.put('prefs', { id, value: state[id] }));

  // ---------------------------------------------------------------------------------------------------------------
  // Rows: the actions each one gets, drawn icons, and the key a row answers to (a pinned copy points at its original).
  const PATHS = {
    pin: 'M7.25 4h9.5c.41 0 .75.34.75.75V20l-5.5-3.75L6.5 20V4.75c0-.41.34-.75.75-.75z',
    note: 'M4.75 19.25h3.5L18.6 8.9a1.77 1.77 0 0 0 0-2.5l-1-1a1.77 1.77 0 0 0-2.5 0L4.75 15.75v3.5zM13.5 7l3.5 3.5',
    link: 'M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-.75.75M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l.75-.75',
    trash: 'M5 7h14M10 7V4.75h4V7M7 7l.85 12.25h8.3L17 7M10.25 10.5v5.5M13.75 10.5v5.5',
  };
  const drawn = {};
  function icon(name) {
    if (!drawn[name]) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', PATHS[name]);
      svg.append(path);
      drawn[name] = svg;
    }
    return drawn[name].cloneNode(true);
  }
  function button(act, label, glyph) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'act';
    b.dataset.act = act;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.append(icon(glyph));
    return b;
  }
  function actions(row, own) {
    const box = document.createElement('div');
    box.className = 'acts';
    if (own) {
      box.append(button('edit', 'Edit this entry', 'note'), button('remove', 'Delete this entry', 'trash'));
    } else {
      const pin = button('pin', 'Pin', 'pin');
      pin.setAttribute('aria-pressed', 'false');
      box.append(pin, button('note', 'Add a note', 'note'), button('link', 'Copy a link to this entry', 'link'));
    }
    row.append(box);
  }
  const key = (row) => row.id || row.dataset.ref;
  function copyable(code) {
    code.tabIndex = 0;
    code.setAttribute('role', 'button');
    code.title = 'Copy';
  }
  for (const code of $$('main .r > code')) copyable(code);
  for (const row of $$('main .r[id]')) actions(row, false);

  // A blank in your own entry becomes a fillable one, as the build marks them on the sheet.
  function blanks(code, text) {
    const parts = BLANK ? text.split(BLANK) : [text]; // split keeps the captured names at the odd places
    parts.forEach((p, i) => {
      if (i % 2) {
        const v = document.createElement('var');
        v.dataset.p = p;
        v.textContent = p;
        code.append(v);
      } else if (p) code.append(p);
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Showing the state: your entries, the pinned copies, the notes, your values in the blanks.
  const mineList = $('#mine-list');
  const pinList = $('#pinned-list');

  function showMine() {
    mineList.replaceChildren(...[...state.entries.values()].sort((a, b) => a.at - b.at).map((e) => {
      const row = document.createElement('div');
      row.className = e.kind === 'err' ? 'r x' : 'r';
      row.id = e.id;
      row.dataset.in = 'Your entries';
      const code = document.createElement('code');
      code.className = 'k';
      if (e.kind === 'cmd') blanks(code, e.code); else code.textContent = e.code;
      copyable(code);
      const m = document.createElement('div');
      m.className = 'm';
      const p = document.createElement('p');
      p.textContent = e.text || 'No meaning written yet.';
      if (!e.text) p.className = 'empty';
      m.append(p);
      row.append(code, m);
      actions(row, true);
      return row;
    }));
  }

  function showPins() {
    for (const b of $$('main .r[id] [data-act="pin"]')) b.setAttribute('aria-pressed', String(state.pins.has(key(b.closest('.r')))));
    pinList.replaceChildren(...[...state.pins].sort((a, b) => a[1] - b[1]).map(([id]) => {
      const original = document.getElementById(id);
      if (!original?.matches('main section:not(.own) .r')) return null; // a pin whose entry changed: kept, not shown
      const copy = original.cloneNode(true);
      copy.removeAttribute('id');
      copy.hidden = false;
      copy.dataset.ref = id;
      copy.dataset.in = `Pinned ${original.dataset.in}`;
      $('.note-edit', copy)?.remove();
      return copy;
    }).filter(Boolean));
  }

  function showNotes() {
    for (const row of $$('main .r')) {
      if (row.closest('#mine')) continue;
      const text = state.notes.get(key(row));
      const m = $('.m', row);
      let note = $('.note', m);
      if (text && !note) {
        note = document.createElement('p');
        note.className = 'note';
        const label = document.createElement('b');
        label.textContent = 'Your note';
        note.append(label, document.createElement('span'));
        const tags = $('.tags', m);
        if (tags) tags.before(note); else m.append(note);
      }
      if (text) note.lastChild.textContent = text;
      else note?.remove();
      const b = $('[data-act="note"]', row);
      b?.setAttribute('aria-label', text ? 'Edit your note' : 'Add a note');
      if (b) b.title = b.getAttribute('aria-label');
      b?.classList.toggle('on', Boolean(text));
    }
  }

  function fill() {
    for (const v of $$('var[data-p]')) {
      const value = state.values[v.dataset.p];
      v.textContent = value || v.dataset.p;
      v.classList.toggle('set', Boolean(value));
    }
  }

  function summary() {
    const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
    const parts = [
      state.pins.size && n(state.pins.size, 'pin', 'pins'),
      state.notes.size && n(state.notes.size, 'note', 'notes'),
      state.entries.size && n(state.entries.size, 'entry', 'entries'),
      Object.keys(state.values).length && n(Object.keys(state.values).length, 'value', 'values'),
    ].filter(Boolean);
    $('#data-sum').textContent = parts.length
      ? `${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]}, kept on this device.`
      : 'Nothing saved yet.';
    $('#store-note').hidden = state.kept;
    const on = [state.filters.read, state.filters.distro, ...Object.values(state.filters.versions)].filter(Boolean).length;
    const pill = $('#setup-on');
    pill.hidden = !on;
    pill.textContent = `${on} ${on === 1 ? 'filter' : 'filters'} on`;
    for (const a of $$('.toc [data-own]')) a.hidden = !(a.dataset.own === 'pinned' ? pinList.children.length : mineList.children.length);
  }

  function render() {
    showMine();
    showPins();
    showNotes();
    fill();
    texts = new WeakMap();
    search();
    summary();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Search: every word must match, in any order, where a word also matches its synonyms ("oom" finds "out of memory")
  // and its singular. The filters from Setup apply first. Matches are highlighted without touching the page's text.
  const SYNONYMS = [
    ['oom', 'out of memory', 'oom-kill', 'oomkilled', 'killed process'],
    ['502', 'bad gateway'], ['503', 'service unavailable'], ['504', 'gateway timeout'], ['499', 'client closed'],
    ['refused', 'econnrefused'], ['timeout', 'timed out', 'etimedout'], ['reset', 'econnreset'],
    ['cert', 'certificate', 'x509', 'tls', 'ssl'], ['k8s', 'kubernetes', 'kubectl'],
    ['pg', 'postgres', 'postgresql', 'psql'], ['mysql', 'mariadb'], ['mongo', 'mongodb', 'mongosh'],
    ['es', 'elasticsearch', 'opensearch'], ['mssql', 'sql server', 'sqlcmd'], ['redis', 'valkey'],
    ['disk', 'enospc', 'no space left'], ['inode', 'inodes'], ['dns', 'resolve', 'nxdomain', 'servfail'],
    ['slow', 'latency'], ['lock', 'deadlock', 'blocked'], ['replica', 'replication', 'standby', 'secondary'],
    ['crash', 'crashloopbackoff', 'segfault', 'core dump'], ['perm', 'permission', 'eacces', 'denied'],
    ['fd', 'file descriptor', 'emfile', 'too many open files'], ['mem', 'memory'], ['fw', 'firewall', 'iptables', 'nftables'],
    ['ntp', 'clock', 'chrony', 'skew'], ['rabbit', 'rabbitmq'], ['jvm', 'java', 'heap'],
    ['aws', 'ec2'], ['gcp', 'gcloud', 'google cloud'], ['azure', 'az vm'],
  ];
  function expand(w) {
    const alts = new Set([w]);
    if (w.length > 4 && w.endsWith('s')) alts.add(w.slice(0, -1));
    // A synonym shorter than 3 letters matches too much inside other words: it is matched only when you type it.
    for (const g of SYNONYMS) if (g.includes(w)) for (const s of g) if (s.length >= 3) alts.add(s);
    return [...alts];
  }

  let texts = new WeakMap();
  // A row's searchable text: where it sits, its code with the blanks' names (not your values), its meaning, its note.
  function textOf(row) {
    let t = texts.get(row);
    if (t === undefined) {
      const code = $('code', row);
      const plain = code ? [...code.childNodes].map((n) => (n.nodeName === 'VAR' ? n.dataset.p : n.textContent)).join('') : '';
      const rest = [...row.children].filter((c) => c !== code && !c.matches('.acts')).map((c) => c.textContent).join(' ');
      t = `${row.dataset.in} ${plain} ${rest}`.toLowerCase();
      texts.set(row, t);
    }
    return t;
  }

  const newer = (need, have) => {
    const [a, b] = [need.split('.').map(Number), have.split('.').map(Number)];
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    return false;
  };
  function allowed(row) {
    const f = state.filters;
    for (const t of (row.dataset.tags ?? '').split(' ')) {
      if (f.read && (t === 'changes' || t === 'danger')) return false;
      if (f.distro && (t === 'deb' || t === 'rhel') && t !== f.distro) return false;
      const v = /^([a-z0-9]+?)(\d+(?:\.\d+)*)\+$/.exec(t);
      if (v && f.versions[v[1]] && newer(v[2], f.versions[v[1]])) return false;
    }
    return true;
  }

  const filterNote = document.createElement('span');
  filterNote.textContent = ' Some entries that match are hidden by your filters in Setup.';
  none.append(filterNote);
  const paint = window.CSS?.highlights && typeof Highlight === 'function';

  function search() {
    const words = q.value.toLowerCase().split(/\s+/).filter(Boolean).map(expand);
    let shown = 0;
    let held = 0;
    for (const row of $$('main [data-in]')) {
      const text = textOf(row);
      const hit = words.every((alts) => alts.some((w) => text.includes(w)));
      const ok = hit && allowed(row);
      if (hit && !ok) held++;
      row.hidden = !ok;
      if (ok) shown++;
    }
    for (const g of $$('main .grp')) g.hidden = !$('[data-in]:not([hidden])', g);
    for (const s of $$('main section')) s.hidden = !$('.grp:not([hidden])', s) && !(s.id === 'mine' && !form.hidden);
    none.hidden = shown > 0;
    filterNote.hidden = !held;
    const more = held ? `; your filters hide ${held} more` : '';
    status.textContent = words.length ? `${shown} ${shown === 1 ? 'entry matches' : 'entries match'}${more}` : '';
    if (paint) highlight(words);
  }

  function highlight(words) {
    CSS.highlights.delete('hit');
    if (!words.length) return;
    const needles = [...new Set(words.flat())].sort((a, b) => b.length - a.length);
    const marks = new Highlight();
    let rows = 0;
    for (const row of $$('main [data-in]:not([hidden])')) {
      if (row.closest('[hidden]')) continue;
      if (++rows > 200) break; // past a screenful or two, painting costs more than it shows
      const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement.closest('.acts, .tags, .note-edit') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const t = n.data.toLowerCase();
        for (const w of needles) {
          for (let i = t.indexOf(w); i >= 0; i = t.indexOf(w, i + w.length)) {
            const r = new Range();
            r.setStart(n, i);
            r.setEnd(n, i + w.length);
            marks.add(r);
          }
        }
      }
    }
    CSS.highlights.set('hit', marks);
  }

  q.addEventListener('input', search);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && q.value) { q.value = ''; search(); }
  });

  // The keyboard: / to search; from the box, the down arrow walks into the results, then the arrows or j and k move
  // between them, Enter or Space copies, and Escape goes back to the box.
  const visible = () => $$('main .r > code').filter((c) => !c.closest('[hidden]'));
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
    if (e.key === '/' && !typing) { e.preventDefault(); q.focus(); q.select(); return; }
    if (e.target === q && e.key === 'ArrowDown') {
      const first = visible()[0];
      if (first) { e.preventDefault(); first.focus(); }
      return;
    }
    const code = e.target.closest?.('.r > code');
    if (!code) return;
    const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[e.key];
    if (step) {
      e.preventDefault();
      const all = visible();
      const next = all[all.indexOf(code) + step];
      if (next) next.focus(); else if (step < 0) q.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      q.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      copy(code);
    }
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Copy: a click, or Enter or Space on a focused command, copies it with your values in its blanks. Where the
  // clipboard is refused, the command is selected for Ctrl+C instead.
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

  // A link names the entry's anchor. Opened from disk, it points at the public copy, so it still works when shared.
  async function copyLink(id) {
    const url = `${served ? location.origin + location.pathname : HOME}#${id}`;
    try {
      await navigator.clipboard.writeText(url);
      say('Link copied');
    } catch {
      history.replaceState(null, '', `#${id}`);
      say('The link is in the address bar');
    }
  }

  function togglePin(id) {
    const unpin = state.pins.has(id);
    if (unpin) {
      state.pins.delete(id);
      keep(db.del('pins', id));
    } else {
      const at = Date.now();
      state.pins.set(id, at);
      keep(db.put('pins', { id, at }));
    }
    const lost = document.activeElement?.closest('#pinned-list');
    render();
    if (lost) $(`[id="${id}"] [data-act="pin"]`)?.focus(); // the copy you unpinned from is gone: focus the original
    say(unpin ? 'Unpinned' : 'Pinned to the top');
  }

  // A note opens in place, under the meaning: Save keeps it, Escape or Cancel drops the edit, an empty note deletes.
  function editNote(row) {
    const m = $('.m', row);
    const open = $('.note-edit', m);
    if (open) { $('textarea', open).focus(); return; }
    const id = key(row);
    const edit = document.createElement('form');
    edit.className = 'note-edit';
    const area = document.createElement('textarea');
    area.rows = 3;
    area.maxLength = 4000;
    area.value = state.notes.get(id) ?? '';
    area.setAttribute('aria-label', 'Your note on this entry');
    const btns = document.createElement('div');
    btns.className = 'btns';
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'btn primary';
    save.textContent = 'Save note';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    btns.append(save, cancel);
    edit.append(area, btns);
    m.append(edit);
    const close = () => { edit.remove(); $('[data-act="note"]', row)?.focus(); };
    cancel.addEventListener('click', close);
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); edit.requestSubmit(); }
    });
    edit.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = area.value.trim();
      if (text) {
        state.notes.set(id, text);
        keep(db.put('notes', { id, text }));
      } else {
        state.notes.delete(id);
        keep(db.del('notes', id));
      }
      close();
      render();
      say(text ? 'Note saved' : 'Note deleted');
    });
    area.focus();
  }

  // A button that acts on the second click within a few seconds: for deleting, with no dialog in the way.
  function armed(b, ask, act) {
    if (b.dataset.armed) {
      clearTimeout(Number(b.dataset.armed));
      delete b.dataset.armed;
      act();
      return;
    }
    const label = b.getAttribute('aria-label');
    const text = b.classList.contains('act') ? null : b.textContent;
    b.dataset.armed = String(setTimeout(() => {
      delete b.dataset.armed;
      if (label) b.setAttribute('aria-label', label);
      if (text) b.textContent = text;
    }, 4000));
    if (text) b.textContent = ask; else b.setAttribute('aria-label', ask);
    say(ask);
  }

  document.addEventListener('click', (e) => {
    const code = e.target.closest?.('.r > code');
    if (code && !String(getSelection())) { copy(code); return; } // a drag that selects part of a command is left alone
    const b = e.target.closest?.('button.act');
    if (!b) return;
    const row = b.closest('.r');
    const id = key(row);
    const act = b.dataset.act;
    if (act === 'pin') togglePin(id);
    else if (act === 'note') editNote(row);
    else if (act === 'link') copyLink(id);
    else if (act === 'edit') openForm(state.entries.get(id));
    else if (act === 'remove') {
      armed(b, 'Click again to delete this entry', () => {
        state.entries.delete(id);
        keep(db.del('entries', id));
        render();
        say('Entry deleted');
      });
    }
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Your entries: the form in their section adds one or edits one.
  const kindName = () => { $('#code-name').textContent = form.elements.kind.value === 'err' ? 'Error or state' : 'Command'; };
  function openForm(rec) {
    form.hidden = false;
    form.dataset.id = rec?.id ?? '';
    form.elements.kind.value = rec?.kind ?? 'cmd';
    form.elements.code.value = rec?.code ?? '';
    form.elements.text.value = rec?.text ?? '';
    $('#mine-form-h').textContent = rec ? 'Edit your entry' : 'Add an entry';
    kindName();
    if ('hidePopover' in setup && setup.matches(':popover-open')) setup.hidePopover();
    search();
    form.scrollIntoView({ block: 'center' });
    form.elements.code.focus({ preventScroll: true });
  }
  function closeForm() {
    form.reset();
    form.hidden = true;
    search();
  }
  form.addEventListener('change', kindName);
  $('[data-act="cancel"]', form).addEventListener('click', () => { closeForm(); q.focus(); });
  form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeForm(); q.focus(); } });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = form.elements.code.value.replace(IN_CODE, '').replace(/\s+$/, '');
    if (!code.trim()) { form.elements.code.focus(); return; }
    const old = state.entries.get(form.dataset.id);
    if (!old && state.entries.size >= MAX_ENTRIES) { say(`${MAX_ENTRIES} entries is the most this page keeps`); return; }
    const hex = [...crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, '0')).join('');
    const rec = { id: old?.id ?? `mine-${hex}`, kind: form.elements.kind.value === 'err' ? 'err' : 'cmd', code, text: form.elements.text.value.trim(), at: old?.at ?? Date.now() };
    state.entries.set(rec.id, rec);
    keep(db.put('entries', rec));
    closeForm();
    render();
    document.getElementById(rec.id)?.querySelector('code')?.focus();
    say(old ? 'Entry updated' : 'Entry saved');
  });
  $('#add-entry').addEventListener('click', () => openForm(null));

  // ---------------------------------------------------------------------------------------------------------------
  // Setup: your values, the filters, and your data out and in.
  // Every keystroke saves: writes to one store land in order, and a tab closed mid-word keeps what was typed.
  for (const input of $$('input[data-p]', setup)) {
    input.addEventListener('input', () => {
      const v = input.value.replace(IN_VALUE, '').trim();
      if (v) state.values[input.dataset.p] = v; else delete state.values[input.dataset.p];
      fill();
      summary();
      savePref('values');
    });
  }
  const read = $('#f-read');
  const distro = $('#f-distro');
  function filtersChanged() {
    savePref('filters');
    search();
    summary();
  }
  read.addEventListener('change', () => { state.filters.read = read.checked; filtersChanged(); });
  distro.addEventListener('change', () => { state.filters.distro = distro.value; filtersChanged(); });
  for (const input of $$('input[data-engine]', setup)) {
    input.addEventListener('input', () => {
      const v = input.value.trim();
      const ok = !v || VER.test(v);
      input.toggleAttribute('aria-invalid', !ok);
      if (!ok) return; // a half-typed version keeps the last good one
      if (v) state.filters.versions[input.dataset.engine] = v; else delete state.filters.versions[input.dataset.engine];
      filtersChanged();
    });
  }
  function showSetup() {
    for (const input of $$('input[data-p]', setup)) input.value = state.values[input.dataset.p] ?? '';
    read.checked = state.filters.read;
    distro.value = state.filters.distro;
    for (const input of $$('input[data-engine]', setup)) {
      input.value = state.filters.versions[input.dataset.engine] ?? '';
      input.removeAttribute('aria-invalid');
    }
  }

  const today = () => new Date().toISOString().slice(0, 10);
  $('#export').addEventListener('click', () => {
    const out = {
      app: 'server-triage',
      format: 1,
      exported: new Date().toISOString(),
      pins: [...state.pins].map(([id, at]) => ({ id, at })),
      notes: [...state.notes].map(([id, text]) => ({ id, text })),
      entries: [...state.entries.values()],
      values: state.values,
      filters: state.filters,
    };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`${JSON.stringify(out, null, 2)}\n`], { type: 'application/json' }));
    a.download = `server-triage-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    say('Exported');
  });

  // An import adds what the file holds: pins join yours, and a note, an entry or a value with the same name replaces
  // yours. The file is checked before anything is written, and it is written in one go or not at all. A file can come
  // from someone else, so values that would go into every command, new filters and replaced notes are asked about first.
  const importer = $('#import');
  importer.addEventListener('change', async () => {
    const file = importer.files?.[0];
    importer.value = '';
    if (!file) return;
    let raw;
    try {
      if (file.size > 5_000_000) throw new Error('too big');
      raw = JSON.parse(await file.text());
    } catch {
      say('That file is not a Server Triage export');
      return;
    }
    if (raw?.app !== 'server-triage' || raw.format !== 1) { say('That file is not a Server Triage export'); return; }
    const c = clean(raw);
    if (state.entries.size + c.entries.filter((e) => !state.entries.has(e.id)).length > MAX_ENTRIES) {
      say(`That file would take you past ${MAX_ENTRIES} entries`);
      return;
    }
    const values = Object.entries(c.values).filter(([k, v]) => state.values[k] !== v);
    const filters = raw.filters !== undefined && JSON.stringify(c.filters) !== JSON.stringify(state.filters);
    const replaced = c.notes.filter((x) => state.notes.has(x.id) && state.notes.get(x.id) !== x.text).length;
    if (values.length || filters || replaced) {
      const ask = [`Import ${file.name}?`];
      if (values.length) ask.push('', 'These values go into every command you copy:', ...values.map(([k, v]) => `${k} = ${v}`));
      if (filters) ask.push('', "Your filters are replaced by the file's.");
      if (replaced) ask.push('', `${replaced} of your notes are replaced.`);
      if (!window.confirm(ask.join('\n'))) { say('Nothing imported'); return; }
    }
    for (const p of c.pins) if (!state.pins.has(p.id)) state.pins.set(p.id, p.at);
    for (const n of c.notes) state.notes.set(n.id, n.text);
    for (const e of c.entries) state.entries.set(e.id, e);
    Object.assign(state.values, c.values);
    if (raw.filters !== undefined) state.filters = c.filters;
    keep(db.batch((s) => {
      for (const p of c.pins) s('pins').put({ id: p.id, at: state.pins.get(p.id) });
      for (const n of c.notes) s('notes').put(n);
      for (const e of c.entries) s('entries').put(e);
      s('prefs').put({ id: 'values', value: state.values });
      s('prefs').put({ id: 'filters', value: state.filters });
    }));
    showSetup();
    render();
    const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
    say(`Imported ${n(c.pins.length, 'pin', 'pins')}, ${n(c.notes.length, 'note', 'notes')} and ${n(c.entries.length, 'entry', 'entries')}`);
  });

  $('#wipe').addEventListener('click', (e) => {
    armed(e.currentTarget, 'Click again to delete it all', () => {
      adopt(clean({}));
      keep(db.batch((s) => { for (const name of ['pins', 'notes', 'entries', 'prefs']) s(name).clear(); }));
      showSetup();
      render();
      say('Your data is deleted');
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Links: an anchor to an entry scrolls to it, clearing a search that hides it. An entry whose code changed since
  // the link was made has a new anchor, so the link falls back to its section.
  function go() {
    let id;
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) {
      const section = id.replace(/-[0-9a-f]{6}$/, '');
      if (section !== id && document.getElementById(section)?.matches('main section')) {
        location.replace(`#${section}`);
        say('That entry changed since the link was made. Here is its section');
      }
      return;
    }
    if (el.closest('[hidden]') && q.value) { q.value = ''; search(); }
    if (el.closest('[hidden]')) { say('Your filters in Setup hide that entry'); return; }
    el.scrollIntoView({ block: 'start' });
    if (el.matches('.r')) $('code', el)?.focus({ preventScroll: true });
  }
  addEventListener('hashchange', go);

  chan?.addEventListener('message', () => load().then(() => { showSetup(); render(); }));

  // ---------------------------------------------------------------------------------------------------------------
  // The app's manifest and offline copy, over http(s) only: a page opened from disk is offline already, and the
  // browser refuses a manifest there. Trusted Types guard the worker's URL, as the page's policy requires.
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

  $('#setup-btn').hidden = !('showPopover' in HTMLElement.prototype); // a browser without popovers keeps the plain sheet
  search();
  load().then(() => {
    showSetup();
    render();
    go();
    document.documentElement.dataset.ready = '1';
  });
})();
