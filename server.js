const express = require('express');
const path = require('path');
const fs = require('fs');

// Usa fetch nativo de Node 18+ (evita el bug "Premature close" de node-fetch v2)
// Si por algún motivo no está disponible, cae a node-fetch
const fetch = globalThis.fetch ?? require('node-fetch');

const app = express();
const PORT    = process.env.PORT    || 3001;
const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'serp_data.json');

// ─── JSON FILE STORAGE ───────────────────────────────────────────────────────
function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { settings: { apiKey: '', domain: 'getlinko.com' }, keywords: [], nextId: 1, logs: [], urls: [], nextUrlId: 1 };
  }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Returns active API keys array (supports legacy single apiKey)
function getApiKeys(settings) {
  if (Array.isArray(settings.apiKeys) && settings.apiKeys.length > 0) {
    return settings.apiKeys.map(k => (typeof k === 'string' ? k : k.key)).filter(Boolean);
  }
  if (settings.apiKey) return [settings.apiKey];
  return [];
}

function isQuotaError(data) {
  const msg = (data.error || '').toLowerCase();
  return msg.includes('ran out') || msg.includes('quota') || msg.includes('credits') || msg.includes('plan');
}

async function fetchWithKeyRotation(buildParams, settings) {
  const keys = getApiKeys(settings);
  if (keys.length === 0) throw new Error('No SerpAPI key configured');

  for (const key of keys) {
    const params = buildParams(key);
    const res = await fetch(`https://serpapi.com/search.json?${params}`);
    const data = await res.json();
    if (!res.ok || data.error) {
      if (isQuotaError(data)) {
        console.log(`[SerpAPI] Key ending in ...${key.slice(-6)} quota exhausted, trying next key`);
        continue; // try next key
      }
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }
  throw new Error('All SerpAPI keys have run out of searches');
}

async function fetchSerpPosition(kw, settings) {
  const domain = (settings.domain || 'getlinko.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const MAX_PAGES = 10; // check up to position 100

  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * 10;
    const data = await fetchWithKeyRotation(key => {
      const p = new URLSearchParams({
        api_key: key,
        engine: kw.engine || 'google',
        q: kw.q,
        num: '10',
        start: String(start),
        no_cache: 'true',
      });
      if (kw.location)      p.set('location', kw.location);
      if (kw.google_domain) p.set('google_domain', kw.google_domain);
      if (kw.hl)            p.set('hl', kw.hl);
      if (kw.gl)            p.set('gl', kw.gl);
      if (kw.device)        p.set('device', kw.device);
      return p;
    }, settings);

    const organic = data.organic_results || [];
    if (organic.length === 0) break;

    for (let i = 0; i < organic.length; i++) {
      const result = organic[i];
      const link = (result.link || result.url || '').replace(/^https?:\/\//, '');
      if (link.startsWith(domain) || link.includes(domain + '/') || link === domain) {
        return { position: start + i + 1, url: result.link || result.url };
      }
    }

    if (page < MAX_PAGES - 1) await sleep(300);
  }

  return { position: null, url: null };
}

function todayStr() { return new Date().toISOString().split('T')[0]; }

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── SETTINGS ────────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  const db = loadDB();
  res.json(db.settings || {});
});

app.post('/api/settings', (req, res) => {
  const db = loadDB();
  db.settings = { ...db.settings, ...req.body };
  saveDB(db);
  res.json({ ok: true });
});

// Check balance of a specific SerpAPI key
app.get('/api/serpapi-balance', async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    const r = await fetch(`https://serpapi.com/account?api_key=${encodeURIComponent(key)}`);
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error });
    res.json({
      searches_per_month: data.plan_searches_left ?? data.searches_per_month ?? null,
      total_searches_left: data.total_searches_left ?? null,
      plan: data.plan_name || data.plan || null,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── KEYWORDS ────────────────────────────────────────────────────────────────
app.get('/api/keywords', (req, res) => {
  const db = loadDB();
  const sorted = [...db.keywords].sort((a, b) =>
    (b.active - a.active) || a.q.localeCompare(b.q)
  );
  res.json(sorted);
});

app.post('/api/keywords', (req, res) => {
  const { engine, q, location, google_domain, hl, gl, device, num } = req.body;
  if (!q) return res.status(400).json({ error: 'q is required' });
  const db = loadDB();
  const kw = {
    id: db.nextId++,
    engine: engine || 'google',
    q: q.trim(),
    location: location || null,
    google_domain: google_domain || null,
    hl: hl || null,
    gl: gl || null,
    device: device || 'desktop',
    num: Number(num) || 100,
    active: 1,
    created_at: todayStr(),
    history: []
  };
  db.keywords.push(kw);
  saveDB(db);
  res.json(kw);
});

app.put('/api/keywords/:id', (req, res) => {
  const id = Number(req.params.id);
  const { engine, q, location, google_domain, hl, gl, device, num } = req.body;
  const db = loadDB();
  const kw = db.keywords.find(k => k.id === id);
  if (!kw) return res.status(404).json({ error: 'Not found' });
  Object.assign(kw, {
    engine: engine || 'google', q: q.trim(),
    location: location || null, google_domain: google_domain || null,
    hl: hl || null, gl: gl || null,
    device: device || 'desktop', num: Number(num) || 100
  });
  saveDB(db);
  res.json(kw);
});

app.delete('/api/keywords/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = loadDB();
  db.keywords = db.keywords.filter(k => k.id !== id);
  saveDB(db);
  res.json({ ok: true });
});

app.post('/api/keywords/:id/toggle', (req, res) => {
  const id = Number(req.params.id);
  const db = loadDB();
  const kw = db.keywords.find(k => k.id === id);
  if (!kw) return res.status(404).json({ error: 'Not found' });
  kw.active = kw.active ? 0 : 1;
  saveDB(db);
  res.json({ active: kw.active });
});

// ─── SERP DEBUG ───────────────────────────────────────────────────────────────
app.get('/api/keywords/:id/serp-debug', async (req, res) => {
  const id = Number(req.params.id);
  const db = loadDB();
  const kw = db.keywords.find(k => k.id === id);
  if (!kw) return res.status(404).json({ error: 'Not found' });
  const keys = getApiKeys(db.settings);
  if (!keys.length) return res.status(400).json({ error: 'No SerpAPI key' });
  const domain = (db.settings.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  try {
    let allOrganic = [];
    for (let page = 0; page < 10; page++) {
      const start = page * 10;
      const data = await fetchWithKeyRotation(key => {
        const p = new URLSearchParams({ api_key: key, engine: kw.engine || 'google', q: kw.q, num: '10', start: String(start), no_cache: 'true' });
        if (kw.location)      p.set('location', kw.location);
        if (kw.google_domain) p.set('google_domain', kw.google_domain);
        if (kw.hl)            p.set('hl', kw.hl);
        if (kw.gl)            p.set('gl', kw.gl);
        if (kw.device)        p.set('device', kw.device);
        return p;
      }, db.settings);
      const pageOrganic = (data.organic_results || []).map((x, i) => ({
        organic_rank: start + i + 1,
        serpapi_position: x.position,
        url: x.link || x.url,
        is_ours: (x.link || x.url || '').replace(/^https?:\/\//, '').startsWith(domain),
      }));
      if (pageOrganic.length === 0) break;
      allOrganic = allOrganic.concat(pageOrganic);
      if (pageOrganic.find(x => x.is_ours)) break;
      if (page < 9) await sleep(300);
    }
    res.json({ q: kw.q, location: kw.location, google_domain: kw.google_domain, domain_looking_for: domain, organic: allOrganic });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── REFRESH ─────────────────────────────────────────────────────────────────
app.post('/api/keywords/:id/refresh', async (req, res) => {
  const id = Number(req.params.id);
  const db = loadDB();
  const kw = db.keywords.find(k => k.id === id);
  if (!kw) return res.status(404).json({ error: 'Not found' });
  if (!db.settings.apiKey) return res.status(400).json({ error: 'No SerpAPI key configured' });

  try {
    const result = await fetchSerpPosition(kw, db.settings);
    const today = todayStr();
    if (!kw.history) kw.history = [];
    const idx = kw.history.findIndex(h => h.date === today);
    const entry = { date: today, position: result.position, url: result.url };
    if (idx >= 0) kw.history[idx] = entry;
    else kw.history.unshift(entry);
    // Keep last 365 entries
    kw.history = kw.history.slice(0, 365);
    saveDB(db);
    res.json({ position: result.position, url: result.url, date: today });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/refresh-all', async (req, res) => {
  const db = loadDB();
  if (!db.settings.apiKey) return res.status(400).json({ error: 'No SerpAPI key configured' });
  const { ids } = req.body || {};
  let active = db.keywords.filter(k => k.active);
  if (ids && ids.length) active = active.filter(k => ids.includes(k.id));
  const results = [];
  const today = todayStr();
  const logEntry = { date: today, ts: new Date().toISOString(), processed: active.length, ok: 0, errors: 0, up: 0, down: 0, appeared: 0, disappeared: 0 };

  console.log(`\n[refresh-all] ${new Date().toISOString()} — ${active.length} keywords, fecha: ${today}`);

  for (const kw of active) {
    // Posición previa (entrada más reciente que NO sea de hoy)
    const prevEntry = (kw.history || []).find(h => h.date !== today);
    const prevPos = prevEntry ? prevEntry.position : null;
    const hasPrev = prevEntry !== undefined;

    try {
      const result = await fetchSerpPosition(kw, db.settings);
      const newPos = result.position;
      if (!kw.history) kw.history = [];
      const idx = kw.history.findIndex(h => h.date === today);
      const entry = { date: today, position: newPos, url: result.url };
      if (idx >= 0) kw.history[idx] = entry;
      else kw.history.unshift(entry);
      kw.history = kw.history.slice(0, 365);
      results.push({ id: kw.id, ok: true, position: newPos });
      logEntry.ok++;
      if (hasPrev) {
        if (newPos !== null && prevPos === null)               logEntry.appeared++;
        else if (newPos === null && prevPos !== null)          logEntry.disappeared++;
        else if (newPos !== null && prevPos !== null && newPos < prevPos) logEntry.up++;
        else if (newPos !== null && prevPos !== null && newPos > prevPos) logEntry.down++;
      }
      console.log(`  ✓ [${kw.id}] "${kw.q}" (${kw.location}) → ${newPos !== null ? '#'+newPos : 'N/A'}${hasPrev && prevPos !== null ? ' (antes: #'+prevPos+')' : ''}`);
    } catch (e) {
      results.push({ id: kw.id, ok: false, error: e.message });
      logEntry.errors++;
      console.log(`  ✗ [${kw.id}] "${kw.q}" → ERROR: ${e.message}`);
    }
    await sleep(500);
  }

  if (!db.logs) db.logs = [];
  db.logs.unshift(logEntry);
  db.logs = db.logs.slice(0, 100);

  try {
    saveDB(db);
    console.log(`[refresh-all] Guardado OK — ${logEntry.ok} ok, ${logEntry.errors} err | ↑${logEntry.up} ↓${logEntry.down} +${logEntry.appeared} -${logEntry.disappeared}\n`);
  } catch (e) {
    console.error(`[refresh-all] ERROR al guardar: ${e.message}`);
  }

  res.json(results);
});

// ─── LOGS ─────────────────────────────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
  const db = loadDB();
  res.json(db.logs || []);
});

// ─── AHREFS METRICS ───────────────────────────────────────────────────────────
app.get('/api/ahrefs-metrics', async (req, res) => {
  const db = loadDB();
  if (!db.settings.ahrefsKey) return res.status(400).json({ error: 'No Ahrefs API key configured' });
  const domain = (db.settings.domain || 'getlinko.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const days   = parseInt(req.query.days) || 0;
  const today  = todayStr();
  const key    = db.settings.ahrefsKey;
  const hdrs   = { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' };

  const ahrefsGet = async (endpoint, params) => {
    const url = `https://api.ahrefs.com/v3/site-explorer/${endpoint}?${new URLSearchParams(params)}`;
    const r = await fetch(url, { headers: hdrs });
    if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.message||e.error||`HTTP ${r.status}`); }
    return r.json();
  };

  const fetchAll = async (date) => {
    const [metrics, bkStats, dr] = await Promise.all([
      ahrefsGet('metrics',         { target: domain, date, mode: 'domain' }).catch(() => ({})),
      ahrefsGet('backlinks-stats', { target: domain, date, mode: 'domain' }).catch(() => ({})),
      ahrefsGet('domain-rating',   { target: domain, date, mode: 'domain' }).catch(() => ({})),
    ]);
    const bk = bkStats.metrics ?? {};
    return {
      org_traffic:   (metrics.metrics ?? metrics).org_traffic    ?? null,
      org_keywords:  (metrics.metrics ?? metrics).org_keywords   ?? null,
      backlinks:     bk.live                                     ?? null,
      refdomains:    bk.live_refdomains                          ?? null,
      domain_rating: dr.domain_rating?.domain_rating             ?? null,
    };
  };

  try {
    const current = await fetchAll(today);
    let previous  = null;
    if (days > 0) {
      const prevDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
      previous = await fetchAll(prevDate).catch(() => null);
    }
    console.log('[ahrefs] current:', JSON.stringify(current));
    res.json({ current, previous });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GOOGLE SEARCH CONSOLE (Service Account) ──────────────────────────────────
const crypto = require('crypto');
const SA_FILE = path.join(__dirname, 'service-account.json');

function loadSA() {
  try { return JSON.parse(fs.readFileSync(SA_FILE, 'utf8')); }
  catch { return null; }
}

// Cache de token en memoria (caduca en 1h)
let _gscToken = null, _gscExpiry = 0;

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

async function getGscToken() {
  if (_gscToken && _gscExpiry > Date.now() + 60000) return _gscToken;
  const sa = loadSA();
  if (!sa) throw new Error('service-account.json no encontrado');
  const now = Math.floor(Date.now() / 1000);
  const header  = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = b64url(Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now,
  })));
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const jwt = `${header}.${payload}.${b64url(sign.sign(sa.private_key))}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error_description || data.error);
  _gscToken  = data.access_token;
  _gscExpiry = Date.now() + (data.expires_in * 1000);
  return _gscToken;
}

// Helper: llama a GSC Search Analytics
async function gscQuery(siteUrl, body) {
  const token = await getGscToken();
  const r = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.rows || [];
}

// Detecta la siteUrl correcta (domain property o URL prefix)
async function resolveSiteUrl(domain) {
  const token = await getGscToken();
  const r = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await r.json();
  const sites = (data.siteEntry || []).map(s => s.siteUrl);
  const clean = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return sites.find(s => s === `sc-domain:${clean}`)
      || sites.find(s => s.includes(clean))
      || `sc-domain:${clean}`;
}

app.get('/api/gsc/status', async (req, res) => {
  const sa = loadSA();
  if (!sa) return res.json({ connected: false });
  try {
    await getGscToken();
    res.json({ connected: true, email: sa.client_email });
  } catch(e) {
    res.json({ connected: false, error: e.message });
  }
});

async function gscEndpoint(req, res, dimension) {
  try {
    const db       = loadDB();
    const days     = Math.max(parseInt(req.query.days) || 28, 7);
    const limit    = parseInt(req.query.limit) || 25;
    const today    = todayStr();
    const dateFrom = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
    const domain   = (db.settings.domain || 'getlinko.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const siteUrl  = await resolveSiteUrl(domain);
    const rows     = await gscQuery(siteUrl, {
      startDate: dateFrom, endDate: today,
      dimensions: [dimension], rowLimit: limit,
      orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }],
    });
    res.json(rows.map(r => ({
      [dimension]: r.keys[0],
      clicks:      r.clicks,
      impressions: r.impressions,
      ctr:         +(r.ctr * 100).toFixed(1),
      position:    +r.position.toFixed(1),
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
}

app.get('/api/gsc/queries', (req, res) => gscEndpoint(req, res, 'query'));
app.get('/api/gsc/pages',   (req, res) => gscEndpoint(req, res, 'page'));

// ─── URLS CRUD ────────────────────────────────────────────────────────────────
app.get('/api/urls', (req, res) => {
  const db = loadDB();
  res.json(db.urls || []);
});

app.post('/api/urls', (req, res) => {
  const db = loadDB();
  if (!db.urls)      db.urls      = [];
  if (!db.nextUrlId) db.nextUrlId = 1;
  const { url, country } = req.body;
  if (!url) return res.status(400).json({ error: 'url requerida' });
  // Prevent duplicates (same url + country)
  const exists = db.urls.find(u => u.url === url.trim() && u.country === (country || '').trim());
  if (exists) return res.status(400).json({ error: 'Esta URL+país ya existe' });
  const entry = { id: db.nextUrlId++, url: url.trim(), country: (country || '').trim() };
  db.urls.push(entry);
  saveDB(db);
  res.json(entry);
});

app.delete('/api/urls/:id', (req, res) => {
  const db = loadDB();
  const id = parseInt(req.params.id);
  db.urls = (db.urls || []).filter(u => u.id !== id);
  saveDB(db);
  res.json({ ok: true });
});

// Detail queries for a specific page URL + optional country filter
app.get('/api/gsc/page-detail', async (req, res) => {
  try {
    const db      = loadDB();
    const days    = Math.max(parseInt(req.query.days) || 28, 7);
    const pageUrl = req.query.url;
    const country = (req.query.country || '').trim().toLowerCase();
    if (!pageUrl) return res.json({ summary: null, queries: [] });

    const today    = todayStr();
    const dateFrom = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
    const domain   = (db.settings.domain || 'getlinko.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const siteUrl  = await resolveSiteUrl(domain);

    const filters = [{ dimension: 'page', expression: pageUrl, operator: 'equals' }];
    if (country) filters.push({ dimension: 'country', expression: country, operator: 'equals' });

    // Queries breakdown
    const queryRows = await gscQuery(siteUrl, {
      startDate: dateFrom, endDate: today,
      dimensions: ['query'],
      dimensionFilterGroups: [{ filters }],
      rowLimit: 50,
      orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }],
    });

    // Aggregate summary (page dimension so we get totals for this url+country)
    const summaryRows = await gscQuery(siteUrl, {
      startDate: dateFrom, endDate: today,
      dimensions: ['page'],
      dimensionFilterGroups: [{ filters }],
      rowLimit: 1,
    });

    const s = summaryRows[0] || null;
    res.json({
      summary: s ? {
        clicks:      s.clicks,
        impressions: s.impressions,
        ctr:         +(s.ctr * 100).toFixed(1),
        position:    +s.position.toFixed(1),
      } : null,
      queries: queryRows.map(r => ({
        query:       r.keys[0],
        clicks:      r.clicks,
        impressions: r.impressions,
        ctr:         +(r.ctr * 100).toFixed(1),
        position:    +r.position.toFixed(1),
      })),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Time series for specific queries on a page  GET /api/gsc/page-timeseries
app.get('/api/gsc/page-timeseries', async (req, res) => {
  try {
    const db       = loadDB();
    const days     = Math.max(parseInt(req.query.days) || 28, 7);
    const pageUrl  = req.query.url;
    const country  = (req.query.country || '').trim().toLowerCase();
    const queries  = (req.query.queries || '').split('|||').map(q => q.trim()).filter(Boolean);
    if (!pageUrl || !queries.length) return res.json({});

    const today    = todayStr();
    const dateFrom = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
    const domain   = (db.settings.domain || 'getlinko.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const siteUrl  = await resolveSiteUrl(domain);

    // Fetch date+query breakdown for this page+country, one call
    const baseFilters = [{ dimension: 'page', expression: pageUrl, operator: 'equals' }];
    if (country) baseFilters.push({ dimension: 'country', expression: country, operator: 'equals' });

    const rows = await gscQuery(siteUrl, {
      startDate: dateFrom, endDate: today,
      dimensions: ['date', 'query'],
      dimensionFilterGroups: [{ filters: baseFilters }],
      rowLimit: 5000,
    });

    // Structure: { [query]: { dates:[], clicks:[], impressions:[], ctr:[], position:[] } }
    const result = {};
    queries.forEach(q => {
      result[q] = { dates: [], clicks: [], impressions: [], ctr: [], position: [] };
    });

    // Build sorted date list
    const dateSet = new Set(rows.map(r => r.keys[0]));
    const allDates = [...dateSet].sort();

    // Index rows by date+query
    const idx = {};
    rows.forEach(r => {
      const [date, query] = r.keys;
      if (!idx[query]) idx[query] = {};
      idx[query][date] = r;
    });

    queries.forEach(q => {
      result[q].dates = allDates;
      allDates.forEach(d => {
        const r = (idx[q] || {})[d];
        result[q].clicks.push(r ? r.clicks : 0);
        result[q].impressions.push(r ? r.impressions : 0);
        result[q].ctr.push(r ? +(r.ctr * 100).toFixed(1) : 0);
        result[q].position.push(r ? +r.position.toFixed(1) : null);
      });
    });

    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── AHREFS HISTORY ───────────────────────────────────────────────────────────
app.get('/api/ahrefs-history', async (req, res) => {
  const db = loadDB();
  if (!db.settings.ahrefsKey) return res.status(400).json({ error: 'No Ahrefs API key configured' });
  const domain   = (db.settings.domain || 'getlinko.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const days     = parseInt(req.query.days) || 30;
  const today    = todayStr();
  const dateFrom = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  const key      = db.settings.ahrefsKey;
  const hdrs     = { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' };
  // Ahrefs devuelve datos mensuales por defecto; granularity no cambia mucho
  const history  = days <= 14 ? 'daily' : days <= 90 ? 'weekly' : 'monthly';

  const ahrefsGet = async (endpoint, params) => {
    const url = `https://api.ahrefs.com/v3/site-explorer/${endpoint}?${new URLSearchParams(params)}`;
    const r = await fetch(url, { headers: hdrs });
    if (!r.ok) return null;
    return r.json().catch(() => null);
  };

  const base = { target: domain, date_from: dateFrom, date_to: today, mode: 'domain', history };

  try {
    const [drH, rfH, mH] = await Promise.all([
      ahrefsGet('domain-rating-history', base),
      ahrefsGet('refdomains-history',    base),
      ahrefsGet('metrics-history',       base),
    ]);

    const fmtDate = d => (d.date || d).split('T')[0];
    const mapDR = (drH?.domain_ratings || []).map(d => ({ date: fmtDate(d), value: d.domain_rating }));
    const mapRF = (rfH?.refdomains     || []).map(d => ({ date: fmtDate(d), value: d.refdomains   }));
    const mArr  = mH?.metrics || [];
    const mapTR = mArr.map(d => ({ date: fmtDate(d), value: d.org_traffic }));

    res.json({ domain_rating: mapDR, refdomains: mapRF, org_traffic: mapTR, org_keywords: [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── AHREFS DEBUG (temporal) ──────────────────────────────────────────────────
app.get('/api/ahrefs-debug', async (req, res) => {
  const db = loadDB();
  if (!db.settings.ahrefsKey) return res.status(400).json({ error: 'No key' });
  const domain   = (db.settings.domain || 'getlinko.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const today    = todayStr();
  const dateFrom = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const hdrs     = { 'Authorization': `Bearer ${db.settings.ahrefsKey}`, 'Accept': 'application/json' };
  const get = async (url) => { try { const r = await fetch(url, { headers: hdrs }); return await r.json(); } catch(e) { return { error: e.message }; } };
  const [drH, rfH, mH] = await Promise.all([
    get(`https://api.ahrefs.com/v3/site-explorer/domain-rating-history?target=${domain}&date_from=${dateFrom}&date_to=${today}&mode=domain`),
    get(`https://api.ahrefs.com/v3/site-explorer/refdomains-history?target=${domain}&date_from=${dateFrom}&date_to=${today}&mode=domain`),
    get(`https://api.ahrefs.com/v3/site-explorer/metrics-history?target=${domain}&date_from=${dateFrom}&date_to=${today}&mode=domain`),
  ]);
  res.json({ domain_rating_history: drH, refdomains_history: rfH, metrics_history: mH });
});

// ─── IMPORT ───────────────────────────────────────────────────────────────────
app.post('/api/import', (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows must be array' });
  const db = loadDB();
  let added = 0;
  for (const row of rows) {
    if (!row.q) continue;
    db.keywords.push({
      id: db.nextId++,
      engine: row.engine || 'google',
      q: row.q.trim(),
      location: row.location || null,
      google_domain: row.google_domain || null,
      hl: row.hl || null,
      gl: row.gl || null,
      device: row.device || 'desktop',
      num: Number(row.num) || 100,
      active: 1,
      created_at: todayStr(),
      history: []
    });
    added++;
  }
  saveDB(db);
  res.json({ added });
});

// ─── EXPORT ───────────────────────────────────────────────────────────────────
app.get('/api/export', (req, res) => {
  const db = loadDB();
  const sorted = [...db.keywords].sort((a, b) => a.q.localeCompare(b.q));
  let csv = 'engine,q,location,google_domain,hl,gl,device,num,active\n';
  sorted.forEach(kw => {
    csv += `${kw.engine},"${(kw.q||'').replace(/"/g,'""')}",${kw.location||''},${kw.google_domain||''},${kw.hl||''},${kw.gl||''},${kw.device},${kw.num},${kw.active}\n`;
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="serp-keywords.csv"');
  res.send('﻿' + csv);
});

app.get('/api/template', (req, res) => {
  const csv = 'engine,q,location,google_domain,hl,gl,device,num\ngoogle,comprar backlinks,Spain,google.es,es,es,desktop,100\ngoogle,linkbuilding españa,Spain,google.es,es,es,desktop,100\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="template-keywords.csv"');
  res.send('﻿' + csv);
});

// ─── DEDUPLICATION ───────────────────────────────────────────────────────────
// Key: lowercase q + lowercase location (or gl as fallback)
app.post('/api/keywords/deduplicate', (req, res) => {
  const db = loadDB();
  const seen = new Map();
  const toDelete = [];

  // Sort ascending by id (oldest first) so we keep the oldest on duplicates
  const sorted = [...db.keywords].sort((a, b) => a.id - b.id);
  sorted.forEach(kw => {
    const key = `${kw.q.trim().toLowerCase()}|||${(kw.location || kw.gl || '').trim().toLowerCase()}`;
    if (seen.has(key)) {
      toDelete.push(kw.id); // this one is newer → delete
    } else {
      seen.set(key, kw.id);
    }
  });

  db.keywords = db.keywords.filter(k => !toDelete.includes(k.id));
  saveDB(db);
  res.json({ removed: toDelete.length, remaining: db.keywords.length });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  SERP Tracker → http://localhost:${PORT}`);
  console.log(`📁  Datos: ${DB_FILE}`);
  console.log(`🌐  Entorno: ${process.env.NODE_ENV || 'development'}\n`);
});
