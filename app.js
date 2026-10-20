/* ============================================================
 * SALON ASTERIA INVENTORY — FRONT END
 * Backend: /api, a Vercel Function on Neon Postgres (see api/index.js)
 *
 * Writes never go straight to the network. Every mutation is applied
 * locally, appended to a durable queue in localStorage, and flushed
 * with backoff. Nothing leaves the queue until the server confirms it,
 * so a count survives a dead signal, a locked phone, or a reload.
 * ============================================================ */
'use strict';

const SCRIPT_URL = '/api';

/* Known categories order the Order list and seed the pickers, but they no
   longer decide what is allowed to exist — anything present in the sheet
   is shown too. See catalogCategories(). */
const KNOWN_CATEGORIES = ['Retail', 'Back Bar', 'Color', 'Developer', 'Bleach & Treatment', 'Supplies'];

const SEARCH_CAP = 40;   // one cap everywhere, and it is always stated
const LS = {
  token:   'asteria_token',
  queue:   'asteria_queue',
  session: 'asteria_session',
  ordered: 'asteria_ordered',
  data:    'asteria_data',
  log:     'asteria_log'
};

// ---------- App state ----------
let S = {
  token: localStorage.getItem(LS.token) || null,
  products: [], zones: [], counts: [], snapshots: [], restocks: [],
  view: 'count', zoneId: null,
  countSearch: '', browseSearch: '', browseCat: 'All', restockSearch: '',
  touched: {},          // "productId|zoneId" -> true, for this counting session
  ordered: {},          // productId -> ISO date marked as ordered
  report: null,
  history: null,        // usageHistory: units used per counting period, for the report's trend lines
  flushing: false,
  savedAt: 0
};
let pin = '';

const $  = id => document.getElementById(id);
const now = () => new Date().toISOString();
const uid = p => p + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/* ============================================================
 * ERROR LOG — a ring buffer the salon can hand back to us.
 * Replaces `catch (e) {}`, which threw away every clue.
 * ============================================================ */
const Log = {
  items: [],
  load() { try { this.items = JSON.parse(localStorage.getItem(LS.log)) || []; } catch (e) { this.items = []; } },
  save() { try { localStorage.setItem(LS.log, JSON.stringify(this.items.slice(-40))); } catch (e) {} },
  add(where, err, extra) {
    const entry = {
      at: now(),
      where: where,
      msg: (err && (err.message || err.toString())) || String(err),
      extra: extra || null,
      online: navigator.onLine
    };
    this.items.push(entry);
    if (this.items.length > 40) this.items = this.items.slice(-40);
    this.save();
    if (window.console && console.warn) console.warn('[asteria]', where, err, extra || '');
    return entry;
  },
  clear() { this.items = []; this.save(); }
};
Log.load();

window.addEventListener('error', e => Log.add('window.error', e.error || e.message, { file: e.filename, line: e.lineno }));
window.addEventListener('unhandledrejection', e => Log.add('unhandledrejection', e.reason));

/* ============================================================
 * API
 * ============================================================ */
async function apiGet(action, params) {
  const q = new URLSearchParams(Object.assign({ action: action, token: S.token }, params || {}));
  const res = await fetch(SCRIPT_URL + '?' + q.toString());
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (data.error === 'AUTH') { logout(); throw new Error('AUTH'); }
  if (data.error) throw new Error(data.error);
  return data;
}

// Raw POST. Callers go through Q.push() rather than calling this directly.
async function apiPost(action, data) {
  const res = await fetch(SCRIPT_URL, {
    method: 'POST',
    body: JSON.stringify({ token: S.token, action: action, data: data })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const out = await res.json();
  if (out.error === 'AUTH') { logout(); throw new Error('AUTH'); }
  if (out.error) throw new Error(out.error);
  return out;
}

/* ============================================================
 * WRITE QUEUE
 * Durable, ordered, coalescing. Survives reload and signal loss.
 * ============================================================ */
const Q = {
  items: [],
  timer: null,
  backoff: 0,

  load() {
    try { this.items = JSON.parse(localStorage.getItem(LS.queue)) || []; }
    catch (e) { this.items = []; }
  },
  save() {
    try { localStorage.setItem(LS.queue, JSON.stringify(this.items)); }
    catch (e) { Log.add('queue.save', e); }
  },
  pending() { return this.items.length; },
  hasKey(key) { return this.items.some(i => i.key === key); },

  /* key: when supplied, a later write to the same key replaces the earlier
     one instead of stacking. Tapping + eleven times sends one write. */
  push(action, data, key) {
    if (key) {
      const existing = this.items.find(i => i.key === key && !i.inflight);
      if (existing) {
        existing.data = data;
        existing.at = now();
        this.save(); this.kick(); renderSaveState(); return existing;
      }
    }
    const item = { id: uid('q'), action: action, data: data, key: key || null, at: now(), tries: 0 };
    this.items.push(item);
    this.save(); this.kick(); renderSaveState();
    return item;
  },

  kick(delay) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay == null ? 350 : delay);
  },

  async flush() {
    if (S.flushing || !this.items.length || !S.token) return;
    if (!navigator.onLine) { renderSaveState(); return; }

    S.flushing = true;
    renderSaveState();

    while (this.items.length) {
      const item = this.items[0];
      item.inflight = true;
      try {
        const out = await apiPost(item.action, item.data);
        item.inflight = false;
        this.items.shift();
        this.backoff = 0;
        this.save();
        onWriteConfirmed(item, out);
      } catch (err) {
        item.inflight = false;
        item.tries++;
        item.lastError = (err && err.message) || String(err);
        Log.add('queue.flush:' + item.action, err, { tries: item.tries });
        this.save();

        if (err && err.message === 'AUTH') break;           // logout() already fired

        // Malformed writes would block the queue forever. Park them after
        // enough attempts so the rest of the count can still sync.
        if (item.tries >= 8) {
          this.items.shift();
          this.items.push(Object.assign({}, item, { parked: true }));
          this.save();
        }
        this.backoff = Math.min(this.backoff ? this.backoff * 2 : 2000, 60000);
        S.flushing = false;
        renderSaveState();
        this.kick(this.backoff);
        return;
      }
    }

    S.flushing = false;
    S.savedAt = Date.now();
    renderSaveState();
    refreshPendingMarks();
  },

  /* Replay queued mutations onto freshly fetched server data, so a refresh
     never discards work that has not synced yet. */
  applyLocally() {
    this.items.forEach(item => {
      const d = item.data || {};
      if (item.action === 'setCount') {
        setCountRow(d.productId, d.zoneId, d.qty);
      } else if (item.action === 'removeFromZone') {
        S.counts = S.counts.filter(c => !(c.ProductID === d.productId && c.ZoneID === d.zoneId));
      } else if (item.action === 'addProduct') {
        if (!S.products.some(p => p.ProductID === d.clientId)) {
          S.products.push(productFromDraft(d));
          if (d.zoneId) setCountRow(d.clientId, d.zoneId, d.qty || 0);
        }
      } else if (item.action === 'updateProduct') {
        const p = S.products.find(p => p.ProductID === d.productId);
        if (p) applyProductPatch(p, d);
      } else if (item.action === 'addZone') {
        if (!S.zones.some(z => z.ZoneID === d.clientId)) {
          S.zones.push({ ZoneID: d.clientId, Name: d.name, SortOrder: d.sortOrder || 99, Active: 'Y' });
        }
      } else if (item.action === 'updateZone') {
        const z = S.zones.find(z => z.ZoneID === d.zoneId);
        if (z) {
          if (d.name != null) z.Name = d.name;
          if (d.sortOrder != null) z.SortOrder = d.sortOrder;
          if (d.active === false) z.Active = '';
        }
      } else if (item.action === 'restock') {
        if (!S.restocks.some(r => r.RestockID === d.clientId)) {
          S.restocks.push({ RestockID: d.clientId, Date: d.date || item.at, ProductID: d.productId, Qty: d.qty, Note: '' });
        }
      } else if (item.action === 'deleteRestock') {
        S.restocks = S.restocks.filter(r => String(r.RestockID) !== String(d.restockId));
      }
    });
  },

  retryNow() {
    this.items.forEach(i => { i.tries = 0; delete i.parked; });
    this.backoff = 0;
    this.save();
    this.flush();
  },

  discardAll() {
    this.items = [];
    this.save();
    renderSaveState();
  }
};

/* The server assigns real IDs. Anything created offline carries a client ID
   until its write lands, then every reference is remapped in place. */
function onWriteConfirmed(item, out) {
  const d = item.data || {};
  if (item.action === 'addProduct' && out && out.productId && d.clientId && out.productId !== d.clientId) {
    remapId('product', d.clientId, out.productId);
  }
  if (item.action === 'addZone' && out && out.zoneId && d.clientId && out.zoneId !== d.clientId) {
    remapId('zone', d.clientId, out.zoneId);
  }
  if (item.action === 'restock' && out && out.restockId && d.clientId) {
    const r = S.restocks.find(r => String(r.RestockID) === String(d.clientId));
    if (r) r.RestockID = out.restockId;
  }
}

function remapId(kind, from, to) {
  if (kind === 'product') {
    const p = S.products.find(p => p.ProductID === from); if (p) p.ProductID = to;
    S.counts.forEach(c => { if (c.ProductID === from) c.ProductID = to; });
    S.restocks.forEach(r => { if (r.ProductID === from) r.ProductID = to; });
    if (S.ordered[from]) { S.ordered[to] = S.ordered[from]; delete S.ordered[from]; saveOrdered(); }
  } else {
    const z = S.zones.find(z => z.ZoneID === from); if (z) z.ZoneID = to;
    S.counts.forEach(c => { if (c.ZoneID === from) c.ZoneID = to; });
    if (S.zoneId === from) S.zoneId = to;
  }
  // Anything still queued must point at the real ID before it is sent.
  Q.items.forEach(i => {
    const d = i.data || {};
    if (kind === 'product') {
      if (d.productId === from) d.productId = to;
      if (d.clientId === from && i.action !== 'addProduct') d.clientId = to;
    } else if (d.zoneId === from) d.zoneId = to;
    if (i.key) i.key = i.key.split(from).join(to);
  });
  Object.keys(S.touched).forEach(k => {
    if (k.indexOf(from) !== -1) { S.touched[k.split(from).join(to)] = true; delete S.touched[k]; }
  });
  Q.save(); saveSession();
  render();
}

/* ============================================================
 * SAVE STATE — reports what the queue actually did, not what was attempted.
 * ============================================================ */
function renderSaveState() {
  const el = $('save-status');
  if (!el) return;
  const n = Q.pending();
  el.className = 'savechip';

  if (S.flushing) {
    el.hidden = false;
    el.classList.add('is-saving');
    el.innerHTML = '<span class="savechip__dot"></span>Saving…';
    el.disabled = true;
    el.removeAttribute('aria-label');
  } else if (n > 0) {
    el.hidden = false;
    el.classList.add(navigator.onLine ? 'is-pending' : 'is-offline');
    const label = navigator.onLine
      ? n + (n === 1 ? ' change waiting' : ' changes waiting')
      : 'Offline · ' + n + ' waiting';
    el.innerHTML = '<span class="savechip__dot"></span>' + esc(label);
    el.disabled = false;
    el.setAttribute('aria-label', label + '. Tap for details.');
  } else if (Date.now() - S.savedAt < 2500) {
    el.hidden = false;
    el.classList.add('is-saved');
    el.innerHTML = '<span class="savechip__dot"></span>Saved';
    el.disabled = true;
    setTimeout(() => { if (!Q.pending() && !S.flushing) renderSaveState(); }, 2600);
  } else {
    el.hidden = true;
    el.disabled = true;
  }
  refreshPendingMarks();
}

// Amber dot beside any row whose write has not been confirmed.
function refreshPendingMarks() {
  document.querySelectorAll('[data-pending-key]').forEach(el => {
    el.hidden = !Q.hasKey(el.getAttribute('data-pending-key'));
  });
}

function openPendingSheet() {
  const rows = Q.items.map(i => {
    const d = i.data || {};
    let what = i.action;
    if (i.action === 'setCount') {
      const p = S.products.find(p => p.ProductID === d.productId);
      what = 'Count · ' + (p ? prodName(p) : d.productId) + ' in ' + zoneName(d.zoneId) + ' → ' + fmtQty(d.qty);
    } else if (i.action === 'restock')       what = 'Received +' + fmtQty(d.qty);
    else if (i.action === 'addProduct')      what = 'New product · ' + [d.brand, d.line, d.shade].filter(Boolean).join(' ');
    else if (i.action === 'updateProduct')   what = 'Product details changed';
    else if (i.action === 'removeFromZone')  what = 'Removed from ' + zoneName(d.zoneId);
    else if (i.action === 'addZone')         what = 'New zone · ' + d.name;
    else if (i.action === 'updateZone')      what = 'Zone changed';
    else if (i.action === 'deleteRestock')   what = 'Undid a delivery';
    return `<div class="row"><div class="row__main"><div class="row__title"><span>${esc(what)}</span></div>
      <div class="row__sub">${esc(fmtWhen(i.at))}${i.tries ? ' · ' + i.tries + ' failed ' + (i.tries === 1 ? 'attempt' : 'attempts') : ''}${i.parked ? ' · parked' : ''}</div></div></div>`;
  }).join('');

  showModal(`
    <div class="modal__title" id="modal-title">${Q.pending()} ${Q.pending() === 1 ? 'change' : 'changes'} not saved yet</div>
    <div class="modal__sub">${navigator.onLine
      ? 'These are still queued. They send automatically — you can keep counting.'
      : 'You are offline. These are safe on this phone and will send when you have signal again.'}</div>
    <div class="rows">${rows}</div>
    <div class="modal__actions">
      <button type="button" class="btn btn--ghost" data-act="closeModal">Keep waiting</button>
      <button type="button" class="btn btn--gold" data-act="retryQueue">Try again now</button>
    </div>`);
}

/* ============================================================
 * SESSION — counting progress survives a reload or a locked phone.
 * ============================================================ */
function saveSession() {
  try {
    localStorage.setItem(LS.session, JSON.stringify({
      touched: S.touched, zoneId: S.zoneId, view: S.view, at: now()
    }));
  } catch (e) { Log.add('session.save', e); }
}
function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(LS.session));
    if (!s) return;
    // A counting session is a day's work, not a permanent state.
    if (Date.now() - new Date(s.at).getTime() > 36 * 3600 * 1000) return;
    S.touched = s.touched || {};
    S.zoneId = s.zoneId || null;
  } catch (e) { Log.add('session.load', e); }
}
function clearSession() {
  S.touched = {}; S.zoneId = null;
  try { localStorage.removeItem(LS.session); } catch (e) {}
}
function saveOrdered() {
  try { localStorage.setItem(LS.ordered, JSON.stringify(S.ordered)); } catch (e) {}
}
function loadOrdered() {
  try { S.ordered = JSON.parse(localStorage.getItem(LS.ordered)) || {}; } catch (e) { S.ordered = {}; }
}

/* ============================================================
 * PIN
 * ============================================================ */
function renderPinDots() {
  $('pin-dots').innerHTML = [0, 1, 2, 3]
    .map(i => `<div class="pin__dot${i < pin.length ? ' is-on' : ''}"></div>`).join('');
}
function pinDigit(d) {
  if (pin.length >= 4) return;
  pin += d; renderPinDots();
  if (pin.length === 4) submitPin();
}
function pinBack() {
  pin = pin.slice(0, -1); renderPinDots();
  $('pin-error').textContent = '';
}
async function submitPin() {
  try {
    const res = await fetch(SCRIPT_URL, {
      method: 'POST',
      body: JSON.stringify({ action: 'login', data: { password: pin } })
    });
    const out = await res.json();
    if (out.success) {
      S.token = out.token;
      localStorage.setItem(LS.token, out.token);
      $('pin-screen').classList.add('hidden');
      boot();
    } else if (out.locked) {
      $('pin-error').textContent = 'Too many tries. Wait 15 minutes.';
      pin = ''; renderPinDots();
    } else {
      $('pin-error').textContent = 'Wrong PIN — try again';
      pin = ''; renderPinDots();
    }
  } catch (e) {
    Log.add('login', e);
    $('pin-error').textContent = 'Connection error — try again';
    pin = ''; renderPinDots();
  }
}
function logout() {
  if (Q.pending()) {
    // Never sign out over the top of unsaved work without saying so.
    showModal(`
      <div class="modal__title" id="modal-title">${Q.pending()} ${Q.pending() === 1 ? 'change has' : 'changes have'} not saved</div>
      <div class="modal__sub">Signing out now would lose them. Get back online and let them send first.</div>
      <div class="modal__actions">
        <button type="button" class="btn btn--ghost" data-act="closeModal">Stay signed in</button>
        <button type="button" class="btn btn--dark" data-act="forceLogout">Sign out anyway</button>
      </div>`);
    return;
  }
  doLogout();
}
function doLogout() {
  closeModal();
  localStorage.removeItem(LS.token);
  Q.discardAll();
  clearSession();
  S.token = null; pin = '';
  $('app').classList.add('hidden');
  $('loading').classList.add('hidden');
  $('pin-screen').classList.remove('hidden');
  renderPinDots();
}

/* ============================================================
 * BOOT
 * The last good payload is kept on the phone, so opening the app in a
 * stockroom with no signal shows the salon's data rather than nothing.
 * ============================================================ */
function cacheData() {
  try {
    localStorage.setItem(LS.data, JSON.stringify({
      at: now(),
      products: S.products, zones: S.zones, counts: S.counts,
      snapshots: S.snapshots, restocks: S.restocks
    }));
  } catch (e) { Log.add('data.cache', e); }   // quota: not fatal, just no offline copy
}
function restoreData() {
  try {
    const d = JSON.parse(localStorage.getItem(LS.data));
    if (!d || !d.products) return null;
    S.products = d.products; S.zones = d.zones; S.counts = d.counts;
    S.snapshots = d.snapshots; S.restocks = d.restocks;
    return d.at;
  } catch (e) { Log.add('data.restore', e); return null; }
}

function applyBoot(d) {
  S.products = d.products || [];
  S.zones = d.zones || [];
  S.counts = d.counts || [];
  S.snapshots = d.snapshots || [];
  S.restocks = d.restocks || [];
}

async function boot() {
  $('loading').classList.remove('hidden');
  try {
    const d = await apiGet('boot');
    applyBoot(d);
    cacheData();                    // cache the clean server state...
    Q.applyLocally();               // ...then let unsynced work win over it
    $('loading').classList.add('hidden');
    $('app').classList.remove('hidden');
    render();
    Q.kick(200);
  } catch (e) {
    $('loading').classList.add('hidden');
    if (e.message === 'AUTH') return;

    Log.add('boot', e);
    const cachedAt = restoreData();
    if (cachedAt) {
      Q.applyLocally();
      $('app').classList.remove('hidden');
      render();
      toast(navigator.onLine
        ? 'Couldn’t reach the server — showing the copy from ' + fmtWhen(cachedAt)
        : 'Offline — showing the copy from ' + fmtWhen(cachedAt), true);
    } else {
      $('app').classList.remove('hidden');
      render();
      toast(navigator.onLine
        ? 'Couldn’t load — tap refresh to retry'
        : 'Offline, and there’s no copy on this phone yet', true);
    }
  }
}
async function refreshData() {
  if (Q.pending()) { await Q.flush(); }
  await boot();
  if (!Q.pending()) toast('Up to date');
}

/* ============================================================
 * DATA HELPERS
 * ============================================================ */
const activeProducts = () => S.products.filter(p => p.Active === 'Y');
const activeZones = () => S.zones.filter(z => z.Active === 'Y')
  .sort((a, b) => Number(a.SortOrder) - Number(b.SortOrder));
const zoneName = id => { const z = S.zones.find(z => z.ZoneID === id); return z ? z.Name : (id || '—'); };
const countRow = (pid, zid) => S.counts.find(c => c.ProductID === pid && c.ZoneID === zid);
const zoneEntries = zid => S.counts.filter(c => c.ZoneID === zid)
  .map(c => ({ c: c, p: S.products.find(p => p.ProductID === c.ProductID) }))
  .filter(x => x.p && x.p.Active === 'Y');
const totalFor = pid => S.counts.filter(c => c.ProductID === pid)
  .reduce((s, c) => s + (Number(c.Qty) || 0), 0);

function setCountRow(pid, zid, qty) {
  const c = countRow(pid, zid);
  if (c) c.Qty = qty;
  else S.counts.push({ ProductID: pid, ZoneID: zid, Qty: qty, LastUpdated: '' });
}

const fmtQty = q => {
  const n = Number(q) || 0;
  if (n % 1 === 0) return String(n);
  const s = n.toFixed(1);
  if (s.slice(-2) === '.5') {
    const whole = s.slice(0, -2);
    return whole === '0' ? '½' : whole + '½';
  }
  return s;
};
const fmtDate = iso => iso
  ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
function fmtWhen(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  if (mins < 24 * 60) return Math.round(mins / 60) + ' hr ago';
  return fmtDate(iso);
}
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function prodName(p) {
  if (!p) return '(unknown)';
  return [p.Shade, p.SubType && !p.Shade ? p.SubType : '', !p.Shade && !p.SubType ? p.Line : '']
    .filter(Boolean).join(' ') || p.Brand || '(unnamed)';
}
function prodSub(p) { return [p.Brand, p.Line, p.Shade ? p.SubType : ''].filter(Boolean).join(' · '); }
function prodFull(p) { return [p.Brand, p.Line, p.SubType, p.Shade].filter(Boolean).join(' '); }
function matches(p, q) { return prodFull(p).toLowerCase().includes(q.toLowerCase()); }

/* Categories come from the data, not from a constant. Anything typed into
   the sheet still shows up; the known six just sort first. */
function catalogCategories() {
  const seen = [];
  S.products.forEach(p => {
    const c = (p.Category || '').trim();
    if (c && seen.indexOf(c) === -1 && KNOWN_CATEGORIES.indexOf(c) === -1) seen.push(c);
  });
  return KNOWN_CATEGORIES.concat(seen.sort());
}

function lastSnapshot() {
  const closed = S.snapshots.filter(s => s.Status === 'closed')
    .sort((a, b) => Number(a.SnapshotID) - Number(b.SnapshotID));
  return closed.length ? closed[closed.length - 1] : null;
}

function groupSort(list) {
  const groups = {};
  list.forEach(x => {
    const key = [x.p.Category, x.p.Brand, x.p.Line, x.p.Shade ? x.p.SubType : '']
      .filter(Boolean).join(' — ') || 'Other';
    (groups[key] = groups[key] || []).push(x);
  });
  return Object.keys(groups).sort().map(k => ({
    label: k,
    items: groups[k].sort((a, b) =>
      prodName(a.p).localeCompare(prodName(b.p), undefined, { numeric: true, sensitivity: 'base' }))
  }));
}

// ---- near-duplicate detection ------------------------------------------
function normName(s) {
  return String(s || '').toLowerCase()
    .replace(/\bno\.?\s*/g, '').replace(/#/g, '').replace(/\bnumber\s*/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function similarProducts(draft) {
  const target = normName([draft.brand, draft.line, draft.subType, draft.shade].filter(Boolean).join(' '));
  if (!target) return [];
  const tTokens = target.split(' ').filter(Boolean);
  return activeProducts().map(p => {
    const cand = normName(prodFull(p));
    if (!cand) return null;
    if (cand === target) return { p: p, score: 1 };
    const cTokens = cand.split(' ').filter(Boolean);
    const shared = tTokens.filter(t => cTokens.indexOf(t) !== -1).length;
    const score = shared / Math.max(tTokens.length, cTokens.length);
    return score >= 0.7 ? { p: p, score: score } : null;
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 4);
}

function productFromDraft(d) {
  return {
    ProductID: d.clientId, Category: d.category, Brand: d.brand, Line: d.line,
    SubType: d.subType, Shade: d.shade, Par: d.par, Price: d.price,
    Verify: '', Notes: d.notes, Active: 'Y'
  };
}
function applyProductPatch(p, d) {
  if (d.category != null) p.Category = d.category;
  if (d.brand != null) p.Brand = d.brand;
  if (d.line != null) p.Line = d.line;
  if (d.subType != null) p.SubType = d.subType;
  if (d.shade != null) p.Shade = d.shade;
  if (d.par != null) p.Par = d.par;
  if (d.notes != null) p.Notes = d.notes;
  if (d.verify !== undefined) p.Verify = d.verify ? 'Y' : '';
  if (d.active === false) p.Active = '';
  if ('price' in d) p.Price = d.price === null ? '' : d.price;
}

/* ============================================================
 * NAVIGATION / RENDER
 * ============================================================ */
const NAV_MAP = {
  count: 'count', zone: 'count', browse: 'browse', restock: 'restock',
  order: 'order', more: 'more', report: 'more', zones: 'more',
  howto: 'more', problems: 'more'
};

/* Back closes the modal, then leaves the zone, then leaves the tab — never
   the app. Without this, Android's back button and iOS edge-swipe dropped
   the user out of a half-finished count entirely. */
let modalHasHistory = false;
let ignoreNextPop = false;

function go(view, zoneId, opts) {
  opts = opts || {};
  S.view = view;
  if (zoneId !== undefined) S.zoneId = zoneId;
  S.countSearch = ''; S.browseSearch = ''; S.restockSearch = '';
  saveSession();
  if (!opts.pop) history.pushState({ v: view, z: S.zoneId }, '');
  render();
  window.scrollTo(0, 0);
}

window.addEventListener('popstate', e => {
  if (ignoreNextPop) { ignoreNextPop = false; return; }
  if (modal().open) {                 // back dismisses the sheet first
    modalHasHistory = false;
    modal().close();
    return;
  }
  const st = e.state || {};
  go(st.v || 'count', st.z, { pop: true });
});

function render() {
  document.querySelectorAll('.tab').forEach(b => b.classList.remove('is-active'));
  const nb = $('nav-' + (NAV_MAP[S.view] || 'count'));
  if (nb) nb.classList.add('is-active');

  const last = lastSnapshot();
  $('header-sub').textContent = last ? 'Last full count: ' + fmtDate(last.Date) : '';

  const v = $('view');
  if (S.view === 'count')        v.innerHTML = viewCount();
  else if (S.view === 'zone')    v.innerHTML = viewZone();
  else if (S.view === 'browse')  v.innerHTML = viewBrowse();
  else if (S.view === 'restock') v.innerHTML = viewRestock();
  else if (S.view === 'order')   v.innerHTML = viewOrder();
  else if (S.view === 'more')    v.innerHTML = viewMore();
  else if (S.view === 'zones')   v.innerHTML = viewZones();
  else if (S.view === 'howto')   v.innerHTML = viewHowto();
  else if (S.view === 'problems')v.innerHTML = viewProblems();
  else if (S.view === 'report')  { v.innerHTML = viewReportLoading(); loadReport(); }

  announceScreen();
  refreshPendingMarks();
}

/* Announce the screen name, not the whole rebuilt view. */
function announceScreen() {
  const el = $('screen-announce');
  if (!el) return;
  const h = $('view').querySelector('.screen-title');
  const name = h ? h.textContent.trim() : S.view;
  const n = Q.pending();
  el.textContent = name + (n ? ` · ${n} ${n === 1 ? 'change' : 'changes'} not saved` : '');
}

const icon = (name, cls) => `<svg class="${cls || 'icon'}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const backBtn = view => `<button type="button" class="icon-btn" data-act="go" data-view="${view}" aria-label="Back">${icon('back')}</button>`;

/* Every screen goes through here, so none of them can drift out of the
   heading + blurb pattern the way Browse and More used to. */
function page(o) {
  return `
    ${o.back
      ? `<div class="screen-head">${backBtn(o.back)}<h2 class="screen-title">${esc(o.title)}</h2></div>`
      : `<h2 class="screen-title">${esc(o.title)}</h2>`}
    ${o.blurb ? `<p class="screen-blurb">${o.blurb}</p>` : ''}
    ${o.body || ''}`;
}

/* One empty state, always with a face: an icon, a plain-language title,
   a sentence of orientation, and — where there is one — the button that
   resolves it. */
function empty(o) {
  return `<div class="empty">
    <div class="empty__icon">${icon(o.icon || 'info', 'icon')}</div>
    <div class="empty__title">${esc(o.title)}</div>
    ${o.body ? `<div class="empty__body">${o.body}</div>` : ''}
    ${o.action || ''}</div>`;
}

/* ==================== FIRST RUN ==================== */
/* Day one used to be a PIN screen followed by a list of empty zones.
   Until there is something to count, the app asks for one thing at a time. */
function isFirstRun() { return !activeZones().length || !activeProducts().length; }

function viewFirstRun() {
  const hasZones = activeZones().length > 0;
  return page({
    title: 'Let’s set the salon up',
    blurb: 'Two steps, once. After this you just walk and count.',
    body: `
      <div class="card" style="padding:6px 18px 14px">
        <div class="howto">
          <div class="howto__step">
            <div class="howto__n">${hasZones ? icon('check', 'icon icon--sm') : '1'}</div>
            <div>
              <div class="howto__t">Name your stops</div>
              <div class="howto__b">${hasZones
                ? `Done — ${activeZones().length} ${activeZones().length === 1 ? 'zone' : 'zones'}: ${esc(activeZones().map(z => z.Name).join(', '))}.`
                : 'A zone is somewhere you stand while counting — the colour bar, the retail shelf, the stockroom.'}</div>
              ${hasZones
                ? `<button type="button" class="btn btn--ghost btn--sm" data-act="go" data-view="zones" style="margin-top:8px">Edit zones</button>`
                : `<button type="button" class="btn btn--gold btn--sm" data-act="go" data-view="zones" style="margin-top:8px">Add your first zone</button>`}
            </div>
          </div>
          <div class="howto__step">
            <div class="howto__n">2</div>
            <div>
              <div class="howto__t">Put products on the shelves</div>
              <div class="howto__b">${hasZones
                ? 'Open a zone, search for anything in front of you, and add it. You do not need a full list first — build it as you walk.'
                : 'You can only do this once there is a zone to put them in.'}</div>
              ${hasZones ? `<button type="button" class="btn btn--gold btn--sm" data-act="openZone" data-zone="${esc(activeZones()[0].ZoneID)}" style="margin-top:8px">Start with ${esc(activeZones()[0].Name)}</button>` : ''}
            </div>
          </div>
        </div>
      </div>
      <button type="button" class="linkbtn linkbtn--block" data-act="go" data-view="howto" style="margin-top:14px">How the whole thing works</button>`
  });
}

/* ==================== COUNT: zone picker ==================== */
function viewCount() {
  if (isFirstRun()) return viewFirstRun();

  const zones = activeZones();
  const totalTouched = Object.keys(S.touched).length;

  const list = zones.map(z => {
    const entries = zoneEntries(z.ZoneID);
    const touched = entries.filter(x => S.touched[x.p.ProductID + '|' + z.ZoneID]).length;
    const done = entries.length > 0 && touched === entries.length;
    return `<button type="button" class="row row--lg is-tappable" data-act="openZone" data-zone="${esc(z.ZoneID)}">
      <div class="row__main">
        <div class="row__title"><span>${esc(z.Name)}</span>${done ? `<span class="badge badge--good">Done</span>` : ''}</div>
        <div class="row__sub">${entries.length} ${entries.length === 1 ? 'product' : 'products'}${
          touched ? ` · <span class="good">${touched} counted</span>` : ''}</div>
      </div>
      <span class="menu__chev">${icon('next')}</span>
    </button>`;
  }).join('');

  const resume = totalTouched && S.zoneId
    ? `<button type="button" class="row is-tappable" data-act="openZone" data-zone="${esc(S.zoneId)}" style="border:1px solid var(--sage)">
         <div class="row__main">
           <div class="row__title"><span>Pick up where you left off</span></div>
           <div class="row__sub">${esc(zoneName(S.zoneId))} · ${totalTouched} counted this session</div>
         </div>
         <span class="menu__chev">${icon('next')}</span>
       </button>`
    : '';

  return page({
    title: 'Where are you standing?',
    blurb: 'Pick a zone and count what you see. When the whole walk is done, finish the count below.',
    body: `
      ${resume ? `<div class="rows" style="margin-bottom:14px">${resume}</div>` : ''}
      <div class="rows">${list}</div>
      <button type="button" class="btn btn--dark btn--block btn--lg" data-act="confirmFinish" style="margin-top:18px">Finish count — save snapshot</button>
      <p class="screen-blurb center" style="margin-top:8px">This freezes today’s numbers and starts a fresh usage period.</p>`
  });
}

/* ==================== COUNT: inside a zone ==================== */
function viewZone() {
  return page({
    back: 'count',
    title: zoneName(S.zoneId),
    body: `
      <input class="field" id="zone-search" data-search="countSearch" data-body="zone-body"
        placeholder="Search anything — add it to this zone" value="${esc(S.countSearch)}"
        autocomplete="off" aria-label="Search products to add to this zone">
      <div id="zone-body" style="margin-top:10px">${zoneBody()}</div>`
  });
}

function zoneBody() {
  const zid = S.zoneId;
  const q = S.countSearch.trim();

  if (q) {
    const inZone = new Set(zoneEntries(zid).map(x => x.p.ProductID));
    const all = activeProducts().filter(p => matches(p, q));
    const results = all.slice(0, SEARCH_CAP);
    const rows = results.map(p => {
      if (inZone.has(p.ProductID)) return rowHTML(p, zid);
      const elsewhere = S.counts
        .filter(c => c.ProductID === p.ProductID && Number(c.Qty) > 0)
        .map(c => zoneName(c.ZoneID) + ' ' + fmtQty(c.Qty)).join(', ');
      return `<div class="row">
        <div class="row__main">
          <div class="row__title"><span>${esc(prodName(p))}</span></div>
          <div class="row__sub">${esc(prodSub(p))}${elsewhere ? ' · also in ' + esc(elsewhere) : ''}</div>
        </div>
        <button type="button" class="btn btn--gold btn--sm" data-act="addHere" data-pid="${esc(p.ProductID)}">Add here</button>
      </div>`;
    }).join('');

    return `
      ${all.length ? '' : empty({
        icon: 'browse',
        title: `Nothing matches “${esc(q)}”`,
        body: 'Check the spelling, or add it as a new product below.'
      })}
      <div class="rows">${rows}</div>
      ${countNote(all.length, results.length)}
      <button type="button" class="btn btn--ghost btn--block" data-act="addProduct" data-zone="${esc(zid)}" style="margin-top:10px">
        ${icon('plus', 'icon icon--sm')} Add “${esc(q)}” as a new product
      </button>`;
  }

  const groups = groupSort(zoneEntries(zid));
  if (!groups.length) {
    return empty({
      icon: 'pin',
      title: 'Nothing in this zone yet',
      body: 'Search above for anything on the shelf in front of you — it gets added here.'
    });
  }
  return groups.map(g =>
    `<div class="section-label">${esc(g.label)}</div>
     <div class="rows">${g.items.map(x => rowHTML(x.p, zid)).join('')}</div>`).join('');
}

function countNote(total, shown) {
  if (total <= shown) return '';
  return `<p class="screen-blurb center" style="margin:10px 0 0">Showing ${shown} of ${total} — keep typing to narrow it down.</p>`;
}

function rowHTML(p, zid) {
  const c = countRow(p.ProductID, zid);
  const qty = c ? Number(c.Qty) || 0 : 0;
  const touched = S.touched[p.ProductID + '|' + zid];
  const key = 'setCount:' + p.ProductID + '|' + zid;
  const pid = esc(p.ProductID), z = esc(zid);

  return `<div class="row" data-row="${pid}|${z}">
    ${p.Verify === 'Y'
      ? `<button type="button" class="verify-btn" data-act="verify" data-pid="${pid}" aria-label="Needs verification: ${esc(prodFull(p))}">${icon('alert', 'icon icon--sm')}</button>`
      : ''}
    <div class="row__main">
      <div class="row__title">
        <span>${esc(prodName(p))}</span>
        ${touched ? `<span class="good" aria-label="Counted this session">${icon('check', 'icon icon--sm')}</span>` : ''}
        <span class="dot-pending" data-pending-key="${esc(key)}" ${Q.hasKey(key) ? '' : 'hidden'} title="Not saved yet"></span>
      </div>
      <div class="row__sub">${esc(prodSub(p))}</div>
    </div>
    <button type="button" class="icon-btn icon-btn--bare" data-act="editProduct" data-pid="${pid}"
      aria-label="Edit ${esc(prodFull(p))}">${icon('info', 'icon icon--sm')}</button>
    <button type="button" class="stepper" data-act="bump" data-pid="${pid}" data-zone="${z}" data-delta="-1"
      aria-label="One fewer ${esc(prodName(p))}" ${qty <= 0 ? 'disabled' : ''}>${icon('minus', 'icon icon--sm')}</button>
    <button type="button" class="row__qty" data-act="qtyPad" data-pid="${pid}" data-zone="${z}"
      id="qty-${pid}-${z}" aria-label="${esc(prodName(p))}: ${fmtQty(qty)}. Tap to set exactly">${fmtQty(qty)}</button>
    <button type="button" class="stepper" data-act="bump" data-pid="${pid}" data-zone="${z}" data-delta="1"
      aria-label="One more ${esc(prodName(p))}">${icon('plus', 'icon icon--sm')}</button>
  </div>`;
}

/* Surgical update: touch the number, the minus button and the pending dot.
   Rebuilding the whole zone on every tap was destroying the button the
   thumb was still resting on. */
function paintCount(pid, zid, qty) {
  const row = document.querySelector(`[data-row="${cssEsc(pid + '|' + zid)}"]`);
  const el = $('qty-' + pid + '-' + zid);
  if (el) {
    el.textContent = fmtQty(qty);
    const p = S.products.find(p => p.ProductID === pid);
    el.setAttribute('aria-label', `${p ? prodName(p) : ''}: ${fmtQty(qty)}. Tap to set exactly`);
  }
  if (row) {
    const minus = row.querySelector('[data-delta="-1"]');
    if (minus) minus.disabled = qty <= 0;
    const title = row.querySelector('.row__title');
    if (title && !title.querySelector('.good')) {
      const tick = document.createElement('span');
      tick.className = 'good';
      tick.setAttribute('aria-label', 'Counted this session');
      tick.innerHTML = icon('check', 'icon icon--sm');
      title.insertBefore(tick, title.querySelector('.dot-pending'));
    }
  }
  refreshPendingMarks();
}
const cssEsc = s => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');

function bump(pid, zid, delta) {
  const c = countRow(pid, zid);
  let qty = (c ? Number(c.Qty) || 0 : 0) + delta;
  if (qty < 0) qty = 0;
  setLocalCount(pid, zid, qty, true);
}

function setLocalCount(pid, zid, qty, surgical) {
  qty = Math.round(qty * 2) / 2;
  if (qty < 0) qty = 0;
  setCountRow(pid, zid, qty);
  S.touched[pid + '|' + zid] = true;
  saveSession();
  Q.push('setCount', { productId: pid, zoneId: zid, qty: qty }, 'setCount:' + pid + '|' + zid);
  if (surgical) paintCount(pid, zid, qty);
  else render();
}

function addHere(pid) {
  setLocalCount(pid, S.zoneId, 1);
  S.countSearch = '';
  render();
  toast('Added to ' + zoneName(S.zoneId));
}

/* Quantity pad */
function openQtyPad(pid, zid) {
  const p = S.products.find(p => p.ProductID === pid);
  const quick = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  showModal(`
    <div class="modal__title" id="modal-title">${esc(prodName(p))}</div>
    <div class="modal__sub">${esc(prodSub(p))} · ${esc(zoneName(zid))}</div>
    <div class="quickpad">
      ${quick.map(n => `<button type="button" class="btn btn--ghost" data-act="setQty"
        data-pid="${esc(pid)}" data-zone="${esc(zid)}" data-qty="${n}">${fmtQty(n)}</button>`).join('')}
    </div>
    <form class="inline-form" data-act="setQtyCustom" data-pid="${esc(pid)}" data-zone="${esc(zid)}">
      <input id="qty-custom" type="number" step="0.5" min="0" inputmode="decimal" class="field"
        placeholder="Other amount" aria-label="Other amount">
      <button type="submit" class="btn btn--gold">Set</button>
    </form>
    <button type="button" class="linkbtn linkbtn--danger linkbtn--block" data-act="removeFromZone"
      data-pid="${esc(pid)}" data-zone="${esc(zid)}" style="margin-top:14px">Remove from this zone</button>`);
}

function removeFromZoneUI(pid, zid) {
  closeModal();
  const prev = countRow(pid, zid);
  const prevQty = prev ? Number(prev.Qty) || 0 : 0;
  S.counts = S.counts.filter(c => !(c.ProductID === pid && c.ZoneID === zid));
  delete S.touched[pid + '|' + zid];
  saveSession();
  Q.push('removeFromZone', { productId: pid, zoneId: zid });
  render();
  const p = S.products.find(p => p.ProductID === pid);
  toastUndo(`Removed ${prodName(p)} from ${zoneName(zid)}`, () => {
    setLocalCount(pid, zid, prevQty);
    toast('Put back');
  });
}

/* Sets an absolute quantity and offers a way back to the previous one. */
function setQtyWithUndo(pid, zid, qty) {
  const cur = countRow(pid, zid);
  const prevQty = cur ? Number(cur.Qty) || 0 : 0;
  const existed = !!cur;
  setLocalCount(pid, zid, qty);
  const p = S.products.find(p => p.ProductID === pid);
  if (Math.round(prevQty * 2) / 2 === Math.round(qty * 2) / 2) return;
  toastUndo(`${prodName(p)} set to ${fmtQty(qty)}`, () => {
    if (!existed && prevQty === 0) removeFromZoneUI(pid, zid);
    else { setLocalCount(pid, zid, prevQty); toast(`Back to ${fmtQty(prevQty)}`); }
  });
}

/* ==================== VERIFY ==================== */
function openVerify(pid) {
  const p = S.products.find(p => p.ProductID === pid);
  showModal(`
    <div class="modal__title" id="modal-title">Verify: ${esc(prodFull(p))}</div>
    <div class="modal__sub">${esc(p.Notes || 'Transcribed from handwritten notes — double-check the details.')}</div>
    <div class="form-cell">
      <label class="form-label" for="verify-price">Price (fix if wrong)</label>
      <input id="verify-price" type="number" step="0.01" inputmode="decimal" class="field"
        value="${p.Price !== '' && p.Price != null ? esc(p.Price) : ''}" placeholder="No price on file">
    </div>
    <div class="modal__actions">
      <button type="button" class="btn btn--ghost" data-act="editProduct" data-pid="${esc(pid)}">Edit details</button>
      <button type="button" class="btn btn--gold" data-act="markVerified" data-pid="${esc(pid)}">Looks right</button>
    </div>`);
}

function markVerified(pid) {
  const raw = $('verify-price').value.trim();
  const p = S.products.find(p => p.ProductID === pid);
  const d = { productId: pid, verify: false };
  // Explicit null clears the price. Omitting the key would silently keep it.
  d.price = raw === '' ? null : Number(raw);
  applyProductPatch(p, d);
  closeModal();
  Q.push('updateProduct', d, 'updateProduct:' + pid);
  render();
  toast('Verified');
}

/* ==================== ADD / EDIT PRODUCT ==================== */
function datalist(id, values) {
  return `<datalist id="${id}">${
    [...new Set(values.filter(Boolean))].sort().map(v => `<option value="${esc(v)}"></option>`).join('')
  }</datalist>`;
}

function categoryOptions(current) {
  // Always include the product's own category, even if the sheet has drifted
  // from the known list — otherwise saving silently rewrites it to the first
  // option in the select.
  const cats = catalogCategories().slice();
  const cur = (current || '').trim();
  if (cur && cats.indexOf(cur) === -1) cats.unshift(cur);
  return cats.map(c => `<option value="${esc(c)}"${c === cur ? ' selected' : ''}>${esc(c)}</option>`).join('');
}

function openAddProduct(zoneId) {
  const zid = zoneId || S.zoneId || (activeZones()[0] || {}).ZoneID;
  const guess = S.countSearch.trim() || S.browseSearch.trim() || S.restockSearch.trim();
  showModal(`
    <div class="modal__title" id="modal-title">New product</div>
    <div class="modal__sub">Only the name matters right now — par and price can wait.</div>
    <form class="form-grid" data-act="saveNewProduct">
      <div class="form-cell form-cell--full">
        <label class="form-label" for="np-cat">Category</label>
        <select id="np-cat" class="field">${categoryOptions(KNOWN_CATEGORIES[0])}</select>
      </div>
      <div class="form-cell">
        <label class="form-label" for="np-brand">Brand</label>
        <input id="np-brand" class="field" list="dl-brand" value="${esc(guess)}" autocomplete="off">
        ${datalist('dl-brand', S.products.map(p => p.Brand))}
      </div>
      <div class="form-cell">
        <label class="form-label" for="np-line">Line</label>
        <input id="np-line" class="field" list="dl-line" autocomplete="off">
        ${datalist('dl-line', S.products.map(p => p.Line))}
      </div>
      <div class="form-cell">
        <label class="form-label" for="np-sub">Type</label>
        <input id="np-sub" class="field" list="dl-sub" autocomplete="off">
        ${datalist('dl-sub', S.products.map(p => p.SubType))}
      </div>
      <div class="form-cell">
        <label class="form-label" for="np-shade">Shade / Variant</label>
        <input id="np-shade" class="field" autocomplete="off">
      </div>
      <div class="form-cell">
        <label class="form-label" for="np-price">Price ($)</label>
        <input id="np-price" type="number" step="0.01" inputmode="decimal" class="field">
      </div>
      <div class="form-cell">
        <label class="form-label" for="np-par">Par (reorder at)</label>
        <input id="np-par" type="number" step="0.5" inputmode="decimal" class="field" value="1">
      </div>
      <div class="form-cell">
        <label class="form-label" for="np-zone">Zone</label>
        <select id="np-zone" class="field">${
          activeZones().map(z => `<option value="${esc(z.ZoneID)}"${z.ZoneID === zid ? ' selected' : ''}>${esc(z.Name)}</option>`).join('')
        }</select>
      </div>
      <div class="form-cell">
        <label class="form-label" for="np-qty">How many here now</label>
        <input id="np-qty" type="number" step="0.5" inputmode="decimal" class="field" value="1">
      </div>
      <div class="form-cell form-cell--full">
        <label class="form-label" for="np-notes">Notes</label>
        <input id="np-notes" class="field">
      </div>
      <button type="submit" class="btn btn--gold btn--block btn--lg form-cell--full">Add product</button>
    </form>`);
}

function readDraft() {
  const g = id => ($(id) ? $(id).value.trim() : '');
  return {
    category: g('np-cat'), brand: g('np-brand'), line: g('np-line'), subType: g('np-sub'),
    shade: g('np-shade'),
    price: g('np-price') !== '' ? Number(g('np-price')) : '',
    par: Number(g('np-par') || 1),
    notes: g('np-notes'), zoneId: g('np-zone'), qty: Number(g('np-qty') || 0)
  };
}

function saveNewProduct() {
  const d = readDraft();
  if (!d.brand && !d.line && !d.shade) { toast('Give it at least a brand or a name', true); return; }
  const dupes = similarProducts(d);
  if (dupes.length) { confirmDuplicate(d, dupes); return; }
  commitNewProduct(d);
}

function confirmDuplicate(draft, dupes) {
  const name = [draft.brand, draft.line, draft.subType, draft.shade].filter(Boolean).join(' ');
  showModal(`
    <div class="modal__title" id="modal-title">Is this the same thing?</div>
    <div class="modal__sub">You already have ${dupes.length === 1 ? 'a product' : 'products'} that ${dupes.length === 1 ? 'looks' : 'look'} like
      “${esc(name)}”. Two entries for one bottle will throw off every count.</div>
    <div class="rows">
      ${dupes.map(x => `<div class="row">
        <div class="row__main">
          <div class="row__title"><span>${esc(prodFull(x.p))}</span></div>
          <div class="row__sub">have ${fmtQty(totalFor(x.p.ProductID))}${x.score === 1 ? ' · exact match' : ''}</div>
        </div>
        <button type="button" class="btn btn--gold btn--sm" data-act="useExisting" data-pid="${esc(x.p.ProductID)}"
          data-zone="${esc(draft.zoneId)}" data-qty="${draft.qty}">Use this</button>
      </div>`).join('')}
    </div>
    <button type="button" class="btn btn--ghost btn--block" data-act="commitNewAnyway" style="margin-top:14px">
      No — add “${esc(name)}” as a separate product
    </button>`);
  pendingDraft = draft;
}
let pendingDraft = null;

function commitNewProduct(d) {
  closeModal();
  const clientId = uid('tmpP');
  const payload = Object.assign({ clientId: clientId }, d);
  S.products.push(productFromDraft(payload));
  if (d.zoneId) {
    setCountRow(clientId, d.zoneId, d.qty);
    S.touched[clientId + '|' + d.zoneId] = true;
    saveSession();
  }
  Q.push('addProduct', payload);
  render();
  toast('Added');
}

function useExisting(pid, zid, qty) {
  closeModal();
  const cur = countRow(pid, zid);
  const next = (cur ? Number(cur.Qty) || 0 : 0) + (Number(qty) || 0);
  setLocalCount(pid, zid, next);
  pendingDraft = null;
  toast('Counted on the existing product');
}

function openEditProduct(pid) {
  const p = S.products.find(p => p.ProductID === pid);
  if (!p) return;
  const inZones = S.counts.filter(c => c.ProductID === pid)
    .map(c => `${esc(zoneName(c.ZoneID))}: <b>${fmtQty(c.Qty)}</b>`).join(' · ');
  showModal(`
    <div class="modal__title" id="modal-title">Edit product</div>
    <div class="modal__sub">${inZones || 'Not placed in any zone yet'}</div>
    <form class="form-grid" data-act="saveEditProduct" data-pid="${esc(pid)}">
      <div class="form-cell form-cell--full">
        <label class="form-label" for="ep-cat">Category</label>
        <select id="ep-cat" class="field">${categoryOptions(p.Category)}</select>
      </div>
      <div class="form-cell"><label class="form-label" for="ep-brand">Brand</label>
        <input id="ep-brand" class="field" value="${esc(p.Brand)}"></div>
      <div class="form-cell"><label class="form-label" for="ep-line">Line</label>
        <input id="ep-line" class="field" value="${esc(p.Line)}"></div>
      <div class="form-cell"><label class="form-label" for="ep-sub">Type</label>
        <input id="ep-sub" class="field" value="${esc(p.SubType)}"></div>
      <div class="form-cell"><label class="form-label" for="ep-shade">Shade / Variant</label>
        <input id="ep-shade" class="field" value="${esc(p.Shade)}"></div>
      <div class="form-cell"><label class="form-label" for="ep-price">Price ($)</label>
        <input id="ep-price" type="number" step="0.01" inputmode="decimal" class="field"
          value="${p.Price !== '' && p.Price != null ? esc(p.Price) : ''}">
        <span class="form-hint">Leave empty to clear it</span></div>
      <div class="form-cell"><label class="form-label" for="ep-par">Par (reorder at)</label>
        <input id="ep-par" type="number" step="0.5" inputmode="decimal" class="field" value="${esc(p.Par)}"></div>
      <div class="form-cell form-cell--full"><label class="form-label" for="ep-notes">Notes</label>
        <input id="ep-notes" class="field" value="${esc(p.Notes)}"></div>
      <div class="checkbox-row">
        <input type="checkbox" id="ep-verify" ${p.Verify === 'Y' ? 'checked' : ''}>
        <label for="ep-verify">Still needs verification</label>
      </div>
      <button type="submit" class="btn btn--gold btn--block btn--lg form-cell--full">Save changes</button>
    </form>
    <button type="button" class="linkbtn linkbtn--danger linkbtn--block" data-act="archiveProduct"
      data-pid="${esc(pid)}" style="margin-top:10px">Archive this product (hide everywhere)</button>`);
}

function saveEditProduct(pid) {
  const g = id => ($(id) ? $(id).value.trim() : '');
  const p = S.products.find(p => p.ProductID === pid);
  const rawPrice = g('ep-price');
  const d = {
    productId: pid, category: g('ep-cat'), brand: g('ep-brand'), line: g('ep-line'),
    subType: g('ep-sub'), shade: g('ep-shade'), par: Number(g('ep-par') || 1),
    notes: g('ep-notes'), verify: $('ep-verify').checked,
    price: rawPrice === '' ? null : Number(rawPrice)
  };
  applyProductPatch(p, d);
  closeModal();
  Q.push('updateProduct', d, 'updateProduct:' + pid);
  render();
  toast('Saved');
}

function archiveProduct(pid) {
  const p = S.products.find(p => p.ProductID === pid);
  showModal(`
    <div class="modal__title" id="modal-title">Archive ${esc(prodName(p))}?</div>
    <div class="modal__sub">It disappears from counting, browsing and the order list. Its history is kept, and Steven can bring it back.</div>
    <div class="modal__actions">
      <button type="button" class="btn btn--ghost" data-act="closeModal">Keep it</button>
      <button type="button" class="btn btn--dark" data-act="archiveProductConfirm" data-pid="${esc(pid)}">Archive</button>
    </div>`);
}
function archiveProductConfirm(pid) {
  const p = S.products.find(p => p.ProductID === pid);
  p.Active = '';
  closeModal();
  Q.push('updateProduct', { productId: pid, active: false }, 'archive:' + pid);
  render();
  toast('Archived');
}

/* ==================== BROWSE ==================== */
function viewBrowse() {
  return page({
    title: 'Browse',
    blurb: 'Everything on the shelves, with what you have of it right now.',
    body: `
      <input class="field" id="browse-search" data-search="browseSearch" data-body="browse-body"
        placeholder="Search all products" value="${esc(S.browseSearch)}" autocomplete="off"
        aria-label="Search all products">
      <div class="chips" role="group" aria-label="Filter by category">
        ${['All'].concat(catalogCategories()).map(c =>
          `<button type="button" class="chip${S.browseCat === c ? ' is-active' : ''}" data-act="browseCat"
            data-cat="${esc(c)}" aria-pressed="${S.browseCat === c}">${esc(c)}</button>`).join('')}
      </div>
      <button type="button" class="btn btn--gold btn--block" data-act="addProduct" style="margin-bottom:6px">
        ${icon('plus', 'icon icon--sm')} Add a product
      </button>
      <div id="browse-body">${browseBody()}</div>`
  });
}

function browseBody() {
  const q = S.browseSearch.trim();
  let list = activeProducts();
  if (S.browseCat !== 'All') list = list.filter(p => (p.Category || '').trim() === S.browseCat);
  if (q) list = list.filter(p => matches(p, q));

  const total = list.length;
  const shown = list.slice(0, SEARCH_CAP);
  if (!total) return empty({
    icon: 'browse',
    title: 'No matches',
    body: q && S.browseCat !== 'All'
      ? `Nothing in ${esc(S.browseCat)} matches “${esc(q)}”. Try All categories.`
      : 'Try a shorter search, or a different category.',
    action: `<button type="button" class="btn btn--ghost btn--sm" data-act="addProduct">${icon('plus', 'icon icon--sm')} Add a product</button>`
  });

  const groups = groupSort(shown.map(p => ({ p: p })));
  return groups.map(g => `
    <div class="section-label">${esc(g.label)}</div>
    <div class="rows">${g.items.map(x => {
      const t = totalFor(x.p.ProductID);
      const below = t < Number(x.p.Par || 0);
      const zs = S.counts.filter(c => c.ProductID === x.p.ProductID && Number(c.Qty) > 0)
        .map(c => zoneName(c.ZoneID)).join(', ');
      return `<button type="button" class="row is-tappable" data-act="editProduct" data-pid="${esc(x.p.ProductID)}">
        ${x.p.Verify === 'Y' ? '<span class="dot-verify" title="Needs verification"></span>' : ''}
        <div class="row__main">
          <div class="row__title"><span>${esc(prodName(x.p))}</span></div>
          <div class="row__sub">${esc(prodSub(x.p))}${zs ? ' · ' + esc(zs) : ''}</div>
        </div>
        <div class="row__meta">
          <div class="row__big${below ? ' danger' : ''}">${fmtQty(t)}</div>
          ${below ? '<div class="badge badge--danger">Below par</div>' : ''}
        </div>
      </button>`;
    }).join('')}</div>`).join('') + countNote(total, shown.length);
}

/* ==================== RESTOCK ==================== */
function viewRestock() {
  return page({
    title: 'Restock',
    blurb: 'Just unpacked an order? Log what arrived — takes seconds, keeps usage numbers honest.',
    body: `
      <input class="field" id="restock-search" data-search="restockSearch" data-body="restock-body"
        placeholder="Search the product that arrived" value="${esc(S.restockSearch)}" autocomplete="off"
        aria-label="Search the product that arrived">
      <div id="restock-body" style="margin-top:10px">${restockBody()}</div>`
  });
}

function restockBody() {
  const q = S.restockSearch.trim();
  const all = q ? activeProducts().filter(p => matches(p, q)) : [];
  const results = all.slice(0, SEARCH_CAP);
  const recent = [...S.restocks].reverse().slice(0, 12);

  const resultsHTML = results.map(p => `
    <div class="row">
      <div class="row__main">
        <div class="row__title"><span>${esc(prodName(p))}</span></div>
        <div class="row__sub">${esc(prodSub(p))} · have ${fmtQty(totalFor(p.ProductID))}</div>
      </div>
      <button type="button" class="btn btn--gold btn--sm" data-act="restockPad" data-pid="${esc(p.ProductID)}">
        ${icon('plus', 'icon icon--sm')} Received
      </button>
    </div>`).join('');

  return `
    ${results.length ? `<div class="rows">${resultsHTML}</div>${countNote(all.length, results.length)}` : ''}
    ${q && !all.length ? empty({
      icon: 'restock',
      title: `No match for “${esc(q)}”`,
      body: 'If it is genuinely new, add it as a product first.',
      action: `<button type="button" class="btn btn--ghost btn--sm" data-act="addProduct">${icon('plus', 'icon icon--sm')} Add a product</button>`
    }) : ''}
    ${!q && !recent.length ? empty({
      icon: 'restock',
      title: 'Nothing logged yet',
      body: 'When a delivery lands, search for it above and log what arrived. That is what keeps the usage report honest.'
    }) : ''}
    ${recent.length ? `<div class="section-label">Recently received</div>
      <div class="rows">${recent.map(r => {
        const p = S.products.find(p => p.ProductID === r.ProductID);
        return `<div class="row">
          <div class="row__main">
            <div class="row__title"><span><b>+${fmtQty(r.Qty)}</b> ${esc(prodName(p))}</span></div>
            <div class="row__sub">${esc(fmtWhen(r.Date))}</div>
          </div>
          <button type="button" class="linkbtn linkbtn--danger" data-act="undoRestock"
            data-rid="${esc(r.RestockID)}">Undo</button>
        </div>`;
      }).join('')}</div>` : ''}`;
}

function openRestockPad(pid) {
  const p = S.products.find(p => p.ProductID === pid);
  const zones = activeZones();
  // Default to wherever this product already lives — usually where it goes back.
  const here = S.counts.filter(c => c.ProductID === pid && Number(c.Qty) > 0)
    .sort((a, b) => Number(b.Qty) - Number(a.Qty))[0];
  const defZone = here ? here.ZoneID : (zones[0] || {}).ZoneID;

  showModal(`
    <div class="modal__title" id="modal-title">Received: ${esc(prodName(p))}</div>
    <div class="modal__sub">${esc(prodSub(p))} · have ${fmtQty(totalFor(pid))} right now</div>
    <div class="form-cell" style="margin-bottom:14px">
      <label class="form-label" for="rs-zone">Put away in</label>
      <select id="rs-zone" class="field">
        ${zones.map(z => `<option value="${esc(z.ZoneID)}"${z.ZoneID === defZone ? ' selected' : ''}>${esc(z.Name)}</option>`).join('')}
        <option value="">Not yet — just log that it arrived</option>
      </select>
      <span class="form-hint">Choosing a zone adds it to that count too, so you don’t have to do this twice.</span>
    </div>
    <div class="quickpad">
      ${[1, 2, 3, 4, 5, 6, 8, 12].map(n =>
        `<button type="button" class="btn btn--ghost" data-act="saveRestock" data-pid="${esc(pid)}" data-qty="${n}">${n}</button>`).join('')}
    </div>
    <form class="inline-form" data-act="saveRestockCustom" data-pid="${esc(pid)}">
      <input id="rs-custom" type="number" step="0.5" min="0.5" inputmode="decimal" class="field"
        placeholder="Other amount" aria-label="Other amount">
      <button type="submit" class="btn btn--gold">Log</button>
    </form>`);
}

function saveRestock(pid, qty) {
  const zoneSel = $('rs-zone');
  const zid = zoneSel ? zoneSel.value : '';
  closeModal();

  const clientId = uid('tmpR');
  S.restocks.push({ RestockID: clientId, Date: now(), ProductID: pid, Qty: qty, Note: '' });
  Q.push('restock', { clientId: clientId, productId: pid, qty: qty, date: now() });

  if (zid) {
    const cur = countRow(pid, zid);
    setLocalCount(pid, zid, (cur ? Number(cur.Qty) || 0 : 0) + Number(qty));
  }

  // Arriving stock closes the loop on anything marked as ordered.
  if (S.ordered[pid]) { delete S.ordered[pid]; saveOrdered(); }

  S.restockSearch = '';
  render();
  toast(zid ? `Logged +${fmtQty(qty)} into ${zoneName(zid)}` : `Logged +${fmtQty(qty)}`);
}

function undoRestock(id) {
  const r = S.restocks.find(r => String(r.RestockID) === String(id));
  S.restocks = S.restocks.filter(r => String(r.RestockID) !== String(id));
  Q.push('deleteRestock', { restockId: id });
  render();
  toast('Undone' + (r ? ' — the count still shows what you entered' : ''));
}

/* ==================== ORDER LIST ==================== */
function belowPar() {
  return activeProducts()
    .map(p => ({ p: p, have: totalFor(p.ProductID) }))
    .filter(x => x.have < Number(x.p.Par || 0));
}

function viewOrder() {
  const below = belowPar();
  const waiting = below.filter(x => S.ordered[x.p.ProductID]);
  const toBuy = below.filter(x => !S.ordered[x.p.ProductID]);

  // Group by whatever categories exist, known ones first. Nothing below par
  // can be invisible because its category is not in a hardcoded list.
  const byCat = {};
  toBuy.forEach(x => {
    const c = (x.p.Category || '').trim() || 'Uncategorised';
    (byCat[c] = byCat[c] || []).push(x);
  });
  const order = catalogCategories().concat(['Uncategorised'])
    .filter((c, i, a) => a.indexOf(c) === i && byCat[c]);

  const est = toBuy.reduce((s, x) =>
    s + (Number(x.p.Price) || 0) * Math.max(0, Number(x.p.Par) - x.have), 0);
  const priced = toBuy.filter(x => Number(x.p.Price) > 0).length;

  if (!below.length) {
    return page({
      title: 'Order list',
      blurb: 'Everything below its reorder level, ready to read off while you order.',
      body: empty({
        icon: 'check',
        title: 'Nothing to order',
        body: 'Everything is at or above its reorder level. This list fills itself in as counts drop.'
      })
    });
  }

  return page({
    title: 'Order list',
    blurb: 'Tap anything you’ve ordered and it moves out of the way until it arrives.',
    body: `
      ${toBuy.length ? `<div class="stat-grid">
        <div class="stat"><div class="stat__num">${toBuy.length}</div><div class="stat__label">to order</div></div>
        <div class="stat"><div class="stat__num">${est ? '$' + est.toFixed(0) : '—'}</div>
          <div class="stat__label">${est ? `est. refill · ${priced} of ${toBuy.length} priced` : 'no prices on file'}</div></div>
      </div>` : ''}
      ${toBuy.length ? `<button type="button" class="btn btn--ghost btn--block" data-act="copyOrder" style="margin-bottom:6px">Copy list to clipboard</button>` : ''}
      ${order.map(c => `
        <div class="section-label">${esc(c)}</div>
        <div class="rows">${byCat[c].map(x => `
          <button type="button" class="row is-tappable" data-act="markOrdered" data-pid="${esc(x.p.ProductID)}"
            aria-label="${esc(prodFull(x.p))}: have ${fmtQty(x.have)}, reorder at ${fmtQty(x.p.Par)}. Mark as ordered">
            <div class="row__main">
              <div class="row__title"><span>${esc(prodName(x.p))}</span></div>
              <div class="row__sub">${esc(prodSub(x.p))}</div>
            </div>
            <div class="row__meta">
              <div class="row__big danger">${fmtQty(x.have)}</div>
              <div class="row__sub">have · reorder at ${fmtQty(x.p.Par)}</div>
            </div>
          </button>`).join('')}</div>`).join('')}
      ${!toBuy.length ? empty({
        icon: 'clock',
        title: 'All ordered',
        body: 'Everything below its reorder level is on its way. Log it in Restock when it lands and it clears itself.'
      }) : ''}
      ${waiting.length ? `<div class="section-label">On the way</div>
        <div class="rows">${waiting.map(x => `
          <div class="row">
            <div class="row__main">
              <div class="row__title">${icon('clock', 'icon icon--sm')}<span>${esc(prodName(x.p))}</span></div>
              <div class="row__sub">Ordered ${esc(fmtWhen(S.ordered[x.p.ProductID]))} · clears itself when you log it in Restock</div>
            </div>
            <button type="button" class="linkbtn" data-act="unmarkOrdered" data-pid="${esc(x.p.ProductID)}">Not ordered</button>
          </div>`).join('')}</div>` : ''}`
  });
}

function markOrdered(pid) {
  S.ordered[pid] = now(); saveOrdered(); render();
  toast('Marked as ordered');
}
function unmarkOrdered(pid) {
  delete S.ordered[pid]; saveOrdered(); render();
}

function copyOrderList() {
  const list = belowPar().filter(x => !S.ordered[x.p.ProductID]);
  const txt = 'Salon Asteria — order list (' + new Date().toLocaleDateString() + ')\n' +
    list.map(x => `• ${prodFull(x.p)} — have ${fmtQty(x.have)}, par ${fmtQty(x.p.Par)}`).join('\n');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(() => toast('Copied'), () => fallbackCopy(txt));
  } else fallbackCopy(txt);
}
function fallbackCopy(txt) {
  showModal(`<div class="modal__title" id="modal-title">Order list</div>
    <div class="modal__sub">Copying isn’t available here — select this and copy it by hand.</div>
    <div class="logline selectable">${esc(txt)}</div>
    <div class="modal__actions"><button type="button" class="btn btn--ghost" data-act="closeModal">Done</button></div>`);
}

/* ==================== FINISH COUNT ==================== */
function confirmFinish() {
  const last = lastSnapshot();
  const zones = activeZones();
  const unwalked = zones.filter(z => {
    const e = zoneEntries(z.ZoneID);
    return e.length && !e.some(x => S.touched[x.p.ProductID + '|' + z.ZoneID]);
  });

  showModal(`
    <div class="modal__title" id="modal-title">Finish this count?</div>
    <div class="modal__sub">Today’s numbers get saved as a snapshot${
      last ? ' and compared against ' + fmtDate(last.Date) + ' to work out what was used' : ''}.</div>
    ${unwalked.length ? `<div class="row" style="background:var(--warn-bg);box-shadow:none;margin-bottom:14px">
      <span class="badge badge--warn">Check</span>
      <div class="row__main"><div class="row__sub" style="color:var(--warn);white-space:normal">
        Nothing was counted in ${esc(unwalked.map(z => z.Name).join(', '))} this session.
      </div></div></div>` : ''}
    ${Q.pending() ? `<div class="row" style="background:var(--warn-bg);box-shadow:none;margin-bottom:14px">
      <span class="badge badge--warn">Wait</span>
      <div class="row__main"><div class="row__sub" style="color:var(--warn);white-space:normal">
        ${Q.pending()} ${Q.pending() === 1 ? 'change hasn’t' : 'changes haven’t'} saved yet. Finish once they’re through, or the snapshot will miss them.
      </div></div></div>` : ''}
    <div class="form-cell">
      <label class="form-label" for="fc-notes">Note (optional)</label>
      <input id="fc-notes" class="field" placeholder="e.g. weekly count">
    </div>
    <div class="modal__actions">
      <button type="button" class="btn btn--ghost" data-act="closeModal">Not yet</button>
      <button type="button" class="btn btn--dark" data-act="doFinish" ${Q.pending() ? 'disabled' : ''}>Save snapshot</button>
    </div>`);
}

async function doFinish() {
  const notes = $('fc-notes').value.trim();
  closeModal();
  $('loading').classList.remove('hidden');
  try {
    // A snapshot must land on the server to mean anything, so this one write
    // is not queued — it is confirmed or it is not taken.
    const out = await apiPost('finishCount', { notes: notes });
    S.snapshots.push({ SnapshotID: out.snapshotId, Date: now(), Status: 'closed', Notes: notes });
    clearSession();
    $('loading').classList.add('hidden');
    toast('Count #' + out.snapshotId + ' saved');
    go('report');
  } catch (e) {
    $('loading').classList.add('hidden');
    Log.add('finishCount', e);
    toast('Couldn’t finish the count — nothing was frozen. Try again when you have signal.', true);
  }
}

/* ==================== REPORT ==================== */
function viewReportLoading() {
  return page({
    back: 'more', title: 'What got used',
    body: `<div class="empty"><div class="spinner"></div><div class="empty__body">Building the report…</div></div>`
  });
}

async function loadReport() {
  try {
    const [report, history] = await Promise.all([apiGet('report'), apiGet('usageHistory')]);
    S.report = report;
    S.history = history;
    $('view').innerHTML = viewReport();
  } catch (e) {
    Log.add('report', e);
    $('view').innerHTML = page({
      back: 'more', title: 'What got used',
      body: empty({
        icon: 'chart',
        title: 'Couldn’t load the report',
        body: navigator.onLine
          ? 'The server didn’t answer. This one needs a live connection — everything else still works.'
          : 'You’re offline. The report is worked out on the server, so it needs a connection.',
        action: navigator.onLine
          ? `<button type="button" class="btn btn--ghost btn--sm" data-act="go" data-view="report">Try again</button>` : ''
      })
    });
  }
}

/* Price by product ID. Unpriced rows are excluded and counted. */
function priceIndex() {
  const ix = {};
  S.products.forEach(p => { ix[p.ProductID] = Number(p.Price) || 0; });
  return ix;
}

/* Units used in each counting period, oldest first, as a small line.
   Drawn once there are three periods; fewer is not a trend. */
function sparkFor(productId) {
  const periods = (S.history && S.history.periods) || [];
  if (periods.length < 3) return '';
  const vals = periods.map(per => Math.max(0, (per.rows.find(r => r.productId === productId) || {}).usage || 0));
  const max = Math.max(...vals) || 1;
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * 60 + 1, 22 - (v / max) * 20]);
  const [lx, ly] = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 62 24" aria-hidden="true">
    <polyline class="spark__line" points="${pts.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ')}"/>
    <circle class="spark__dot" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2"/></svg>`;
}

function viewReport() {
  const r = S.report;

  if (!r || !r.ready) {
    return page({
      back: 'more', title: 'What got used',
      body: empty({
        icon: 'chart',
        title: esc((r && r.message) || 'Two counts needed'),
        body: `Finish a count today and another next week — the second one turns into this:
          <div class="rows" style="width:100%;opacity:.45;pointer-events:none;margin-top:10px" aria-hidden="true">
            <div class="row"><div class="row__main"><div class="row__title"><span>7N Natural Blonde</span></div>
              <div class="row__sub">Wella · Koleston</div></div>
              <div class="row__meta"><div class="row__big">−4</div><div class="row__sub">tubes</div></div></div>
            <div class="row"><div class="row__main"><div class="row__title"><span>No.3 Hair Perfector</span></div>
              <div class="row__sub">Olaplex</div></div>
              <div class="row__meta"><div class="row__big">−2</div><div class="row__sub">bottles</div></div></div>
          </div>`
      })
    });
  }

  const used = r.rows.filter(x => x.usage > 0).sort((a, b) => b.usage - a.usage);
  const odd = r.rows.filter(x => x.usage < 0);

  const ix = priceIndex();
  let cost = 0, pricedRows = 0;
  used.forEach(x => {
    const price = ix[x.productId];
    if (price > 0) { cost += price * x.usage; pricedRows++; }
  });

  const units = used.reduce((s, x) => s + x.usage, 0);
  const days = r.previous && r.current
    ? Math.max(1, Math.round((new Date(r.current.date) - new Date(r.previous.date)) / 86400000))
    : 0;
  const perWeek = days ? (units / days) * 7 : 0;

  return page({
    back: 'more',
    title: 'What got used',
    blurb: `${esc(fmtDate(r.previous.date))} → ${esc(fmtDate(r.current.date))}${
      days ? ` · ${days} ${days === 1 ? 'day' : 'days'}` : ''} · last count + restocks − this count`,
    body: `
    <div class="stat-grid">
      <div class="stat"><div class="stat__num">${fmtQty(units)}</div>
        <div class="stat__label">units used · ${used.length} ${used.length === 1 ? 'product' : 'products'}</div></div>
      ${days ? `<div class="stat"><div class="stat__num">${perWeek.toFixed(1)}</div>
        <div class="stat__label">units per week</div></div>` : ''}
      <div class="stat"><div class="stat__num">${cost ? '$' + cost.toFixed(0) : '—'}</div>
        <div class="stat__label">${cost
          ? `cost of goods used · ${pricedRows} of ${used.length} priced`
          : 'add prices to see cost'}</div></div>
    </div>

    ${used.length ? `<div class="section-label">Biggest movers</div>
      <div class="rows">${used.slice(0, 5).map(x => `
        <div class="row">
          <div class="row__main">
            <div class="row__title"><span>${esc([x.shade, x.subType, x.line].filter(Boolean)[0] || x.brand)}</span></div>
            <div class="row__sub">${esc([x.brand, x.line, x.shade ? x.subType : ''].filter(Boolean).join(' · '))}</div>
          </div>
          <div class="row__meta">${sparkFor(x.productId)}<div class="row__big">−${fmtQty(x.usage)}</div>
            <div class="row__sub">${esc(x.label || '')}${x.restocked ? ' · +' + fmtQty(x.restocked) + ' recvd' : ''}</div></div>
        </div>`).join('')}</div>` : ''}

    ${used.length > 5 ? `<div class="section-label">Everything else</div>
      <div class="rows">${used.slice(5).map(x => `
        <div class="row">
          <div class="row__main">
            <div class="row__title"><span>${esc([x.shade, x.subType, x.line].filter(Boolean)[0] || x.brand)}</span></div>
            <div class="row__sub">${esc([x.brand, x.line, x.shade ? x.subType : ''].filter(Boolean).join(' · '))}</div>
          </div>
          <div class="row__meta">${sparkFor(x.productId)}<div class="row__big">−${fmtQty(x.usage)}</div>
            <div class="row__sub">${esc(x.label || '')}${x.restocked ? ' · +' + fmtQty(x.restocked) + ' recvd' : ''}</div></div>
        </div>`).join('')}</div>` : ''}

    ${!used.length ? empty({
      icon: 'check',
      title: 'Nothing used this period',
      body: 'Every count came back the same. Worth a glance if that seems unlikely.'
    }) : ''}

    ${odd.length ? `<div class="section-label">Check these — count went up without a delivery</div>
      <div class="rows">${odd.map(x => `
        <div class="row"><div class="row__main"><div class="row__title">
          <span>${esc([x.brand, x.line, x.shade].filter(Boolean).join(' '))}</span></div></div>
          <div class="row__meta"><div class="row__big">+${fmtQty(-x.usage)}</div></div></div>`).join('')}</div>
      <p class="screen-blurb" style="margin-top:8px">Usually a delivery that wasn’t logged in Restock, or a counting slip.</p>` : ''}`
  });
}

/* ==================== MORE ==================== */
function viewMore() {
  return page({
    title: 'More',
    blurb: 'Reports, zones and the housekeeping you rarely need.',
    body: `
    <div class="menu">
      <button type="button" class="menu__item" data-act="go" data-view="report">
        ${icon('chart')}<span>Usage report</span><span class="menu__chev">${icon('next')}</span></button>
      <button type="button" class="menu__item" data-act="go" data-view="howto">
        ${icon('book')}<span>How this works</span><span class="menu__chev">${icon('next')}</span></button>
      <button type="button" class="menu__item" data-act="go" data-view="zones">
        ${icon('pin')}<span>Edit zones</span><span class="menu__chev">${icon('next')}</span></button>
      <button type="button" class="menu__item" data-act="refresh">
        ${icon('refresh')}<span>Refresh data</span></button>
      <button type="button" class="menu__item" data-act="go" data-view="problems">
        ${icon('bug')}<span>Report a problem</span>
        ${Log.items.length ? `<span class="badge badge--warn" style="margin-left:auto">${Log.items.length}</span>` : '<span class="menu__chev">' + icon('next') + '</span>'}</button>
      <button type="button" class="menu__item menu__item--danger" data-act="logout">
        ${icon('out')}<span>Sign out</span></button>
    </div>
    <p class="screen-blurb center" style="margin-top:24px">Salon Asteria Inventory</p>`
  });
}

/* ==================== HOW THIS WORKS ==================== */
function viewHowto() {
  return page({
    back: 'more',
    title: 'How this works',
    blurb: 'Four habits. The app does the arithmetic.',
    body: `
    <div class="card" style="padding:6px 18px 14px">
      <div class="howto">
        <div class="howto__step"><div class="howto__n">1</div><div>
          <div class="howto__t">Walk the salon and count</div>
          <div class="howto__b">Zone by zone, count what’s actually on the shelf. Half a tube is ½ — tap the number to set it exactly.</div></div></div>
        <div class="howto__step"><div class="howto__n">2</div><div>
          <div class="howto__t">Finish the count</div>
          <div class="howto__b">That freezes today’s numbers as a snapshot and starts a fresh period. Do it whenever you like — weekly works well.</div></div></div>
        <div class="howto__step"><div class="howto__n">3</div><div>
          <div class="howto__t">Log deliveries as they land</div>
          <div class="howto__b">Restock records what arrived and adds it to the zone you put it in. Skip this and the usage numbers will look wrong.</div></div></div>
        <div class="howto__step"><div class="howto__n">4</div><div>
          <div class="howto__t">Read what you used</div>
          <div class="howto__b">Last count + deliveries − this count = what the salon actually got through. That’s the usage report.</div></div></div>
      </div>
    </div>
    <div class="section-label">Two things worth knowing</div>
    <div class="rows">
      <div class="row"><div class="row__main">
        <div class="row__title"><span>Par is your reorder line</span></div>
        <div class="row__sub" style="white-space:normal">Set it per product. Anything below it shows up on the Order list automatically.</div></div></div>
      <div class="row"><div class="row__main">
        <div class="row__title"><span>You can count with no signal</span></div>
        <div class="row__sub" style="white-space:normal">Changes are saved on the phone and sent when you’re back in range. The header tells you if anything is still waiting.</div></div></div>
    </div>`
  });
}

/* ==================== REPORT A PROBLEM ==================== */
function viewProblems() {
  const items = [...Log.items].reverse();
  return page({
    back: 'more',
    title: 'Report a problem',
    blurb: 'If something didn’t work, copy this and send it over — it says what actually failed.',
    body: `
    ${items.length ? `
      <div class="cluster" style="margin-bottom:12px">
        <button type="button" class="btn btn--gold btn--sm" data-act="copyLog">Copy report</button>
        <button type="button" class="btn btn--ghost btn--sm" data-act="clearLog">Clear</button>
      </div>
      <div class="rows">${items.map(e => `
        <div class="row" style="align-items:flex-start">
          <div class="row__main">
            <div class="row__title"><span>${esc(e.where)}</span></div>
            <div class="row__sub" style="white-space:normal">${esc(e.msg)}</div>
            <div class="row__sub muted">${esc(fmtWhen(e.at))}${e.online ? '' : ' · offline'}</div>
          </div>
        </div>`).join('')}</div>`
    : empty({
        icon: 'check',
        title: 'Nothing has gone wrong',
        body: 'Errors get recorded here automatically if they ever do.'
      })}`
  });
}

function copyLog() {
  const txt = 'Salon Asteria — problem report\n' + new Date().toString() + '\n' +
    'queue: ' + Q.pending() + ' waiting\n' +
    'ua: ' + navigator.userAgent + '\n\n' +
    Log.items.map(e => `${e.at}  ${e.where}\n  ${e.msg}${e.extra ? '\n  ' + JSON.stringify(e.extra) : ''}`).join('\n');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(() => toast('Copied'), () => fallbackCopy(txt));
  } else fallbackCopy(txt);
}

/* ==================== ZONES ==================== */
function viewZones() {
  const zones = activeZones();
  return page({
    back: isFirstRun() ? 'count' : 'more',
    title: 'Zones',
    blurb: 'These are the stops on the inventory walk, in order. Rename, reorder, or add as many as you like.',
    body: `
    ${zones.length ? '' : empty({
      icon: 'pin',
      title: 'No zones yet',
      body: 'Start with somewhere you actually stand — “Colour Bar”, “Retail Shelf”, “Stockroom”. Add them below.'
    })}
    <div class="rows">${zones.map((z, i) => `
      <div class="row">
        <div style="display:flex;flex-direction:column;gap:4px">
          <button type="button" class="nudge" data-act="moveZone" data-zone="${esc(z.ZoneID)}" data-dir="-1"
            ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(z.Name)} up">${icon('up', 'icon icon--sm')}</button>
          <button type="button" class="nudge" data-act="moveZone" data-zone="${esc(z.ZoneID)}" data-dir="1"
            ${i === zones.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(z.Name)} down">${icon('down', 'icon icon--sm')}</button>
        </div>
        <div class="row__main">
          <div class="row__title"><span>${esc(z.Name)}</span></div>
          <div class="row__sub">${zoneEntries(z.ZoneID).length} products</div>
        </div>
        <button type="button" class="btn btn--ghost btn--sm" data-act="renameZone" data-zone="${esc(z.ZoneID)}">Rename</button>
        <button type="button" class="linkbtn linkbtn--danger" data-act="hideZone" data-zone="${esc(z.ZoneID)}">Hide</button>
      </div>`).join('')}</div>
    <form class="inline-form" data-act="createZone" style="margin-top:16px">
      <input id="new-zone" class="field" placeholder="New zone name (e.g. Front Desk Drawer)" aria-label="New zone name">
      <button type="submit" class="btn btn--gold">Add</button>
    </form>`
  });
}

function createZone() {
  const el = $('new-zone');
  const name = el.value.trim();
  if (!name) return;
  const clientId = uid('tmpZ');
  const sortOrder = Math.max(0, ...S.zones.map(z => Number(z.SortOrder) || 0)) + 1;
  S.zones.push({ ZoneID: clientId, Name: name, SortOrder: sortOrder, Active: 'Y' });
  Q.push('addZone', { clientId: clientId, name: name, sortOrder: sortOrder });
  el.value = '';
  render();
  toast('Zone added');
}

function renameZone(zid) {
  const z = S.zones.find(z => z.ZoneID === zid);
  showModal(`
    <div class="modal__title" id="modal-title">Rename zone</div>
    <div class="modal__sub">This is what you’ll see while walking the salon.</div>
    <form class="inline-form" data-act="renameZoneSave" data-zone="${esc(zid)}">
      <input id="rz-name" class="field" value="${esc(z.Name)}" aria-label="Zone name">
      <button type="submit" class="btn btn--gold">Save</button>
    </form>`);
  setTimeout(() => { const i = $('rz-name'); if (i) { i.focus(); i.select(); } }, 30);
}
function renameZoneSave(zid) {
  const name = $('rz-name').value.trim();
  const z = S.zones.find(z => z.ZoneID === zid);
  closeModal();
  if (!name || name === z.Name) return;
  z.Name = name;
  Q.push('updateZone', { zoneId: zid, name: name }, 'zoneName:' + zid);
  render();
  toast('Renamed');
}

function hideZone(zid) {
  const n = zoneEntries(zid).length;
  showModal(`
    <div class="modal__title" id="modal-title">Hide ${esc(zoneName(zid))}?</div>
    <div class="modal__sub">${n
      ? `This zone still has ${n} ${n === 1 ? 'product' : 'products'} in it. They keep their counts, but the zone drops off the walk. Steven can bring it back.`
      : 'It drops off the walk. Steven can bring it back.'}</div>
    <div class="modal__actions">
      <button type="button" class="btn btn--ghost" data-act="closeModal">Keep it</button>
      <button type="button" class="btn btn--dark" data-act="hideZoneConfirm" data-zone="${esc(zid)}">Hide zone</button>
    </div>`);
}
function hideZoneConfirm(zid) {
  const z = S.zones.find(z => z.ZoneID === zid);
  z.Active = '';
  closeModal();
  Q.push('updateZone', { zoneId: zid, active: false }, 'zoneActive:' + zid);
  render();
}

function moveZone(zid, dir) {
  const zones = activeZones();
  const i = zones.findIndex(z => z.ZoneID === zid);
  const j = i + dir;
  if (j < 0 || j >= zones.length) return;
  const a = zones[i], b = zones[j];
  const tmp = a.SortOrder; a.SortOrder = b.SortOrder; b.SortOrder = tmp;
  render();
  // Keyed, so dragging a zone across four positions sends two writes, not eight.
  Q.push('updateZone', { zoneId: a.ZoneID, sortOrder: Number(a.SortOrder) }, 'zoneSort:' + a.ZoneID);
  Q.push('updateZone', { zoneId: b.ZoneID, sortOrder: Number(b.SortOrder) }, 'zoneSort:' + b.ZoneID);
}

/* ============================================================
 * UI UTILITIES
 * ============================================================ */
const modal = () => $('modal');

function showModal(html) {
  const box = $('modal-box');
  box.innerHTML = html;
  const d = modal();
  if (!d.open) {
    d.showModal();                     // focus trap + Escape, free
    history.pushState({ modal: true }, '');
    modalHasHistory = true;
  }
  box.scrollTop = 0;
  const first = box.querySelector('input:not([type=hidden]), select, textarea');
  if (first && window.matchMedia('(min-width: 640px)').matches) first.focus();
}
function closeModal() {
  const d = modal();
  if (d.open) d.close();               // the close handler does the cleanup
}

let toastTimer;
let undoFn = null;

function toast(msg, isError) {
  const t = $('toast');
  undoFn = null;
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' is-error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), isError ? 5000 : 2600);
}

/* Jumping straight to a number — the quick pad, a typed amount, removing a
   product from a zone — is the change with no obvious way back. Stepping
   by one already undoes itself with the other button. */
function toastUndo(msg, fn) {
  const t = $('toast');
  undoFn = fn;
  t.className = 'toast';
  t.innerHTML = `<span>${esc(msg)}</span><button type="button" class="toast__undo" data-act="undoLast">Undo</button>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.add('hidden'); undoFn = null; }, 6000);
}

function runUndo() {
  const fn = undoFn;
  undoFn = null;
  $('toast').classList.add('hidden');
  if (fn) fn();
}

/* ============================================================
 * EVENTS — one delegated handler. No inline onclick, so nothing
 * user-entered is ever interpolated into executable markup.
 * ============================================================ */
const ACTIONS = {
  go:            d => go(d.view),
  openZone:      d => go('zone', d.zone),
  refresh:       () => refreshData(),
  logout:        () => logout(),
  forceLogout:   () => doLogout(),
  closeModal:    () => closeModal(),
  retryQueue:    () => { closeModal(); Q.retryNow(); },
  bump:          d => bump(d.pid, d.zone, Number(d.delta)),
  qtyPad:        d => openQtyPad(d.pid, d.zone),
  setQty:        d => { closeModal(); setQtyWithUndo(d.pid, d.zone, Number(d.qty)); },
  undoLast:      () => runUndo(),
  removeFromZone:d => removeFromZoneUI(d.pid, d.zone),
  addHere:       d => addHere(d.pid),
  addProduct:    d => openAddProduct(d.zone),
  editProduct:   d => openEditProduct(d.pid),
  archiveProduct:d => archiveProduct(d.pid),
  archiveProductConfirm: d => archiveProductConfirm(d.pid),
  verify:        d => openVerify(d.pid),
  markVerified:  d => markVerified(d.pid),
  useExisting:   d => useExisting(d.pid, d.zone, Number(d.qty)),
  commitNewAnyway: () => { if (pendingDraft) commitNewProduct(pendingDraft); },
  browseCat:     d => { S.browseCat = d.cat; render(); },
  restockPad:    d => openRestockPad(d.pid),
  saveRestock:   d => saveRestock(d.pid, Number(d.qty)),
  undoRestock:   d => undoRestock(d.rid),
  markOrdered:   d => markOrdered(d.pid),
  unmarkOrdered: d => unmarkOrdered(d.pid),
  copyOrder:     () => copyOrderList(),
  confirmFinish: () => confirmFinish(),
  doFinish:      () => doFinish(),
  renameZone:    d => renameZone(d.zone),
  hideZone:      d => hideZone(d.zone),
  hideZoneConfirm: d => hideZoneConfirm(d.zone),
  moveZone:      d => moveZone(d.zone, Number(d.dir)),
  copyLog:       () => copyLog(),
  clearLog:      () => { Log.clear(); render(); toast('Cleared'); }
};

document.addEventListener('click', e => {
  const pinKey = e.target.closest('[data-digit]');
  if (pinKey) { pinDigit(pinKey.dataset.digit); return; }
  if (e.target.closest('#pin-back')) { pinBack(); return; }
  if (e.target.closest('#btn-refresh')) { refreshData(); return; }
  if (e.target.closest('#save-status')) { if (Q.pending()) openPendingSheet(); return; }

  const tab = e.target.closest('[data-go]');
  if (tab) { go(tab.dataset.go); return; }

  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'FORM') return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el.dataset, el, e); }
});

// Forms submit rather than relying on a button click, so Enter works too.
document.addEventListener('submit', e => {
  const f = e.target.closest('form[data-act]');
  if (!f) return;
  e.preventDefault();
  const d = f.dataset;
  if (d.act === 'saveNewProduct')   saveNewProduct();
  else if (d.act === 'saveEditProduct') saveEditProduct(d.pid);
  else if (d.act === 'createZone')  createZone();
  else if (d.act === 'renameZoneSave') renameZoneSave(d.zone);
  else if (d.act === 'setQtyCustom') {
    const v = $('qty-custom').value;
    if (v !== '') { closeModal(); setQtyWithUndo(d.pid, d.zone, Number(v)); }
  } else if (d.act === 'saveRestockCustom') {
    const v = $('rs-custom').value;
    if (v !== '') saveRestock(d.pid, Number(v));
  }
});

/* Search: 150ms debounce, and only the results container is rebuilt.
   One component, one cap, one "showing N of M" message. */
const bodyFor = { 'zone-body': zoneBody, 'browse-body': browseBody, 'restock-body': restockBody };
let searchTimer;
document.addEventListener('input', e => {
  const el = e.target.closest('[data-search]');
  if (!el) return;
  S[el.dataset.search] = el.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const fn = bodyFor[el.dataset.body];
    if (fn) { $(el.dataset.body).innerHTML = fn(); refreshPendingMarks(); }
  }, 150);
});

// Click on the backdrop (the dialog itself, outside the sheet) closes it.
document.addEventListener('click', e => { if (e.target === modal()) closeModal(); });

/* One cleanup path for every way a sheet can close — button, backdrop,
   Escape, or the back gesture — so the history entry never leaks. */
modal().addEventListener('close', () => {
  $('modal-box').innerHTML = '';
  pendingDraft = null;
  if (modalHasHistory) { modalHasHistory = false; ignoreNextPop = true; history.back(); }
});

// Flush opportunities
window.addEventListener('online',  () => { renderSaveState(); Q.kick(200); });
window.addEventListener('offline', () => renderSaveState());
document.addEventListener('visibilitychange', () => { if (!document.hidden) Q.kick(300); });
setInterval(() => { if (Q.pending() && !S.flushing) Q.kick(0); }, 30000);

// Last-ditch warning if the tab is closed with work outstanding.
window.addEventListener('beforeunload', e => {
  if (Q.pending()) { e.preventDefault(); e.returnValue = ''; }
});

/* ============================================================
 * START
 * ============================================================ */
Q.load();
loadSession();
loadOrdered();
renderSaveState();
history.replaceState({ v: S.view, z: S.zoneId }, '');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(e => Log.add('sw.register', e));
  });
}

if (S.token) boot();
else { $('pin-screen').classList.remove('hidden'); renderPinDots(); }
