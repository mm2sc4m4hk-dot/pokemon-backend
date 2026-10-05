const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cardmarket = require('./cardmarket');

const app = express();
app.set('trust proxy', 1); // hinter Render: echte Client-IP für das Rate-Limit

// CORS: auf Render unter ALLOWED_ORIGINS (kommagetrennt, z. B. https://deine-app.vercel.app) eintragen.
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
app.use(cors(allowedOrigins.length
  ? { origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)) }
  : undefined));
app.use(express.json({ limit: '100kb' }));

// Kleines Rate-Limit ohne Zusatzpaket: max. N Anfragen pro Minute und IP
function rateLimit(max, windowMs = 60 * 1000) {
  const hits = new Map(); // ip -> { count, resetAt }
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    const h = hits.get(req.ip);
    if (!h || h.resetAt <= now) { hits.set(req.ip, { count: 1, resetAt: now + windowMs }); return next(); }
    h.count += 1;
    if (h.count > max) {
      res.set('Retry-After', String(Math.ceil((h.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Zu viele Anfragen. Bitte kurz warten.' });
    }
    next();
  };
}
app.use(['/api/cards', '/api/card', '/api/card-meta', '/api/prices', '/api/wantlist-names'], rateLimit(120));
app.use('/api/img', rateLimit(600));

// --- Datenquelle: TCGdex (https://tcgdex.dev) ---
const TCGDEX_BASE = 'https://api.tcgdex.net/v2';

// Zweite Datenquelle (Cardmarket-Dateien) im Hintergrund laden und täglich erneuern
cardmarket.init();

app.get('/api/cardmarket-status', (req, res) => res.json(cardmarket.meta));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Bild-Proxy (nur TCGdex-Assets)
app.get('/api/img', async (req, res) => {
  try {
    const u = new URL(String(req.query.u || ''));
    if (u.protocol !== 'https:' || u.hostname !== 'assets.tcgdex.net') return res.status(400).end();
    const r = await axios.get(u.toString(), { responseType: 'arraybuffer', timeout: 15000 });
    res.set('Content-Type', r.headers['content-type'] || 'image/webp');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(r.data));
  } catch (e) {
    res.status(502).end();
  }
});

function parseQuery(raw) {
  const tokens = raw.trim().replace(/#/g, ' ').split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    const m = last.match(/^([A-Za-z]{0,4})(\d{1,3})([A-Za-z]?)(?:\/([A-Za-z]{0,4}\d{1,3}))?$/);
    if (m) {
      return {
        name: tokens.slice(0, -1).join(' '),
        number: {
          prefix: m[1].toUpperCase(),
          digits: String(parseInt(m[2], 10)),
          suffix: m[3].toLowerCase(),
          total: m[4] ? String(parseInt(m[4].replace(/\D/g, ''), 10)) : null
        }
      };
    }
  }
  return { name: tokens.join(' '), number: null };
}

function splitLocalId(localId) {
  const m = String(localId || '').match(/^([A-Za-z]*)(\d+)([A-Za-z]?)$/);
  if (!m) return null;
  return { prefix: m[1].toUpperCase(), digits: String(parseInt(m[2], 10)), suffix: m[3].toLowerCase() };
}

function matchesNumber(localId, number) {
  const parts = splitLocalId(localId);
  if (!parts) return false;
  return parts.digits === number.digits && parts.prefix === number.prefix && parts.suffix === (number.suffix || '');
}

function normalizeCard(card, lang) {
  const img = card.image ? `${card.image}/high.webp` : '';
  const imgSmall = card.image ? `${card.image}/low.webp` : '';
  const cm = card.pricing?.cardmarket || {};

  return {
    id: card.id,
    name: card.name,
    number: card.localId || null,
    images: { small: imgSmall || img, large: img },
    attacks: (card.attacks || []).map(a => a.name).filter(Boolean),
    set: {
      id: card.set?.id || null,
      name: card.set?.name || null,
      total: card.set?.cardCount?.official ?? null
    },
    variants: card.variants || null,
    dexId: Array.isArray(card.dexId) ? card.dexId.map(Number).filter(Number.isFinite) : [],
    illustrator: card.illustrator || null,
    cardmarket: {
      url: `https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(
        [card.name, card.localId].filter(Boolean).join(' ')
      )}`,
      prices: {
        trendPrice: cm.trend ?? cm.avg ?? 0,
        averageSellPrice: cm.avg ?? 0,
        avg1: cm.avg1 ?? 0,
        avg7: cm.avg7 ?? 0,
        avg30: cm.avg30 ?? 0,
        low: cm.low ?? 0,
        trendPriceHolo: cm['trend-holo'] ?? cm['avg-holo'] ?? 0,
        avg1Holo: cm['avg1-holo'] ?? 0,
        avg7Holo: cm['avg7-holo'] ?? 0,
        avg30Holo: cm['avg30-holo'] ?? 0,
        lowHolo: cm['low-holo'] ?? 0
      }
    },
    _lang: lang
  };
}

function nameVariants(name) {
  const variants = [name];
  const hyphenated = name.replace(/\s+(GX|EX|V|VMAX|VSTAR|VUNION|ex)$/i, '-$1');
  if (hyphenated !== name) variants.push(hyphenated);
  return variants;
}

async function searchBriefs(lang, name, set, numberDigits, perPage) {
  try {
    const params = new URLSearchParams();
    params.set('name', name);
    if (numberDigits) params.set('localId', numberDigits);
    if (set) params.set('set.name', `like:${set}`);
    params.set('pagination:itemsPerPage', String(perPage));

    const res = await axios.get(`${TCGDEX_BASE}/${lang}/cards?${params.toString()}`, { timeout: 10000 });
    return Array.isArray(res.data) ? res.data : [];
  } catch (e) {
    console.error(`TCGdex Brief-Suche (${lang}) fehlgeschlagen:`, e.response?.status || e.message);
    return [];
  }
}

async function fetchDetail(lang, id) {
  const res = await axios.get(`${TCGDEX_BASE}/${lang}/cards/${id}`, { timeout: 10000 });
  const normalized = normalizeCard(res.data, lang);

  if (!normalized.images.small && lang !== 'en') {
    try {
      const enRes = await axios.get(`${TCGDEX_BASE}/en/cards/${id}`, { timeout: 10000 });
      const enNormalized = normalizeCard(enRes.data, 'en');
      normalized.images = enNormalized.images;
    } catch (e) {}
  }

  return normalized;
}

async function collectIds(parsed, set, useServerNumberFilter) {
  const perPage = parsed.number ? 100 : 48;
  const numberDigits = parsed.number && useServerNumberFilter ? parsed.number.digits : null;

  const variants = nameVariants(parsed.name);
  const lists = await Promise.all(
    ['de', 'en'].map(async (lang) =>
      (await Promise.all(variants.map(v => searchBriefs(lang, v, set, numberDigits, perPage)))).flat()
    )
  );
  const [deBriefs, enBriefs] = lists;

  const promoMatch = (b) => {
    const n = parsed.number;
    if (!n || !n.prefix) return false;
    if (!String(b.id || '').toLowerCase().startsWith(`${n.prefix.toLowerCase()}-`)) return false;
    const p = splitLocalId(b.localId);
    return !!p && p.prefix === '' && p.digits === n.digits && p.suffix === (n.suffix || '');
  };
  const keep = (b) => !parsed.number || matchesNumber(b.localId, parsed.number) || promoMatch(b);

  const idToLang = new Map();
  deBriefs.filter(keep).forEach(b => idToLang.set(b.id, 'de'));
  enBriefs.filter(keep).forEach(b => { if (!idToLang.has(b.id)) idToLang.set(b.id, 'en'); });
  return idToLang;
}

const englishCache = new Map();
async function getEnglish(card) {
  if (card._lang === 'en') return { name: card.name, attacks: card.attacks || [] };
  if (englishCache.has(card.id)) return englishCache.get(card.id);
  const res = await axios.get(`${TCGDEX_BASE}/en/cards/${card.id}`, { timeout: 10000 });
  const en = { name: res.data.name, attacks: (res.data.attacks || []).map(a => a.name).filter(Boolean) };
  if (englishCache.size > 5000) englishCache.clear();
  englishCache.set(card.id, en);
  return en;
}

const setAbbrCache = new Map();
async function getSetAbbr(setId) {
  if (!setId) return null;
  if (setAbbrCache.has(setId)) return setAbbrCache.get(setId);
  try {
    const r = await axios.get(`${TCGDEX_BASE}/en/sets/${encodeURIComponent(setId)}`, { timeout: 10000 });
    const abbr = r.data?.abbreviation?.official || null;
    setAbbrCache.set(setId, abbr);
    return abbr;
  } catch (e) {
    return null;
  }
}

const padNumber = (n) => (/^\d+$/.test(String(n)) ? String(n).padStart(3, '0') : String(n));

async function withCmLink(card) {
  try {
    if (!card.number || !card.set?.id) return card;
    const abbr = await getSetAbbr(card.set.id);
    if (!abbr) return card;
    const en = await getEnglish(card);
    const q = `${en.name} (${abbr} ${padNumber(card.number)})`;
    return {
      ...card,
      cardmarket: {
        ...card.cardmarket,
        url: `https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(q)}`
      }
    };
  } catch (e) {
    return card;
  }
}

async function enrichPrices(card) {
  try {
    await cardmarket.ready();
    const setId = card.set?.id;
    if (!setId || !cardmarket.hasSet(setId)) return card;
    const en = await getEnglish(card);
    const cands = cardmarket.candidates(setId, en.name);
    if (cands.length === 0) return card;
    const product = cands.length === 1 ? cands[0] : cardmarket.pickByAttacks(cands, en.attacks);
    return product ? cardmarket.applyProduct(card, product) : card;
  } catch (e) {
    return card;
  }
}

async function enrichWithCardmarket(card) {
  return withCmLink(await enrichPrices(card));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n]); }
  }));
  return out;
}

let setsListCache = { at: 0, list: [] };
app.get('/api/sets-list', async (req, res) => {
  try {
    if (!setsListCache.list.length || Date.now() - setsListCache.at > 6 * 60 * 60 * 1000) {
      const r = await axios.get(`${TCGDEX_BASE}/en/sets`, { timeout: 20000 });
      const list = (Array.isArray(r.data) ? r.data : []).map((s) => ({
        id: s.id,
        name: s.name,
        total: s.cardCount?.total ?? s.cardCount?.official ?? 0
      }));
      setsListCache = { at: Date.now(), list };
    }
    res.json(setsListCache.list);
  } catch (e) {
    res.status(502).json({ error: 'Set-Liste konnte nicht geladen werden.' });
  }
});

app.get('/api/sets/:id', async (req, res) => {
  try {
    const r = await axios.get(`${TCGDEX_BASE}/en/sets/${encodeURIComponent(req.params.id)}`, { timeout: 15000 });
    const d = r.data || {};
    res.json({
      id: d.id,
      name: d.name,
      total: d.cardCount?.official ?? null,
      cards: (d.cards || []).map(c => ({
        id: c.id,
        localId: c.localId,
        name: c.name,
        image: c.image ? `${c.image}/low.webp` : ''
      }))
    });
  } catch (e) {
    const status = e.response?.status === 404 ? 404 : 502;
    res.status(status).json({ error: 'Set konnte nicht geladen werden.' });
  }
});

const priceCache = new Map();
const PRICE_TTL_MS = 12 * 60 * 60 * 1000;

async function refreshOne(id, force = false) {
  const hit = priceCache.get(id);
  if (!force && hit && hit.date === (cardmarket.meta.priceGuideDate || null) && Date.now() - hit.at < PRICE_TTL_MS) return hit.data;

  let data = null;
  if (id.startsWith('cm-')) {
    data = cardmarket.pricesOfProduct(Number(id.slice(3)));
  } else if (!id.startsWith('custom-')) {
    let card = null;
    for (const lang of ['en', 'de']) {
      try { card = await fetchDetail(lang, id); break; } catch (e) {}
    }
    if (card) {
      card = await enrichPrices(card);
      data = {
        prices: card.cardmarket.prices,
        productId: card.cardmarket.productId || null,
        priceSource: card.cardmarket.priceSource || 'tcgdex',
        priceDate: card.cardmarket.priceDate || null
      };
    }
  }
  if (data) {
    if (priceCache.size > 8000) priceCache.clear();
    priceCache.set(id, { at: Date.now(), date: cardmarket.meta.priceGuideDate || null, data });
  }
  return data;
}

app.post('/api/prices', async (req, res) => {
  try {
    const raw = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = [...new Set(raw.map(String))].slice(0, 60);
    if (ids.length === 0) return res.status(400).json({ error: 'ids fehlen' });

    const prices = {};
    await mapLimit(ids, 6, async (id) => {
      try {
        const d = await refreshOne(id);
        if (d) prices[id] = d;
      } catch (e) {}
    });
    res.json({ prices, priceGuideDate: cardmarket.meta.priceGuideDate });
  } catch (e) {
    console.error('Preis-Refresh Fehler:', e.message);
    res.status(500).json({ error: 'Preise konnten nicht aktualisiert werden.' });
  }
});

const DAY_MS = 24 * 60 * 60 * 1000;

let setsIndex = { at: 0, names: new Map(), order: new Map() };
async function getSetsIndex() {
  if (setsIndex.names.size && Date.now() - setsIndex.at < 6 * 60 * 60 * 1000) return setsIndex;
  
  const [deRes, enRes] = await Promise.all([
    axios.get(`${TCGDEX_BASE}/de/sets`, { timeout: 20000 }).catch(() => ({ data: [] })),
    axios.get(`${TCGDEX_BASE}/en/sets`, { timeout: 20000 }).catch(() => ({ data: [] }))
  ]);

  const names = new Map();
  const order = new Map();

  const deList = Array.isArray(deRes.data) ? deRes.data : [];
  const enList = Array.isArray(enRes.data) ? enRes.data : [];

  enList.forEach((s, i) => {
    if (s && s.id) {
      names.set(s.id, s.name);
      order.set(s.id, i);
    }
  });

  deList.forEach((s, i) => {
    if (s && s.id) {
      if (s.name) names.set(s.id, s.name);
      if (!order.has(s.id)) order.set(s.id, i);
    }
  });

  setsIndex = { at: Date.now(), names, order };
  return setsIndex;
}

function briefsToCards(briefs, idx) {
  const num = (v) => parseInt(String(v).replace(/\D/g, ''), 10);
  return (briefs || []).filter((b) => b && b.id).map((b) => {
    const i = b.id.lastIndexOf('-');
    const setId = i > 0 ? b.id.slice(0, i) : b.id;
    return {
      id: b.id,
      localId: b.localId,
      name: b.name,
      image: b.image ? `${b.image}/low.webp` : '',
      setId,
      setName: idx.names.get(setId) || setId,
      setOrder: idx.order.has(setId) ? idx.order.get(setId) : 99999
    };
  }).sort((a, b) =>
    a.setOrder - b.setOrder || a.setId.localeCompare(b.setId) ||
    ((num(a.localId) || 0) - (num(b.localId) || 0)) || String(a.localId).localeCompare(String(b.localId))
  );
}

let illustratorCache = { at: 0, list: [] };
app.get('/api/illustrators', async (req, res) => {
  try {
    if (!illustratorCache.list.length || Date.now() - illustratorCache.at > DAY_MS) {
      const [deRes, enRes] = await Promise.all([
        axios.get(`${TCGDEX_BASE}/de/illustrators`, { timeout: 20000 }).catch(() => ({ data: [] })),
        axios.get(`${TCGDEX_BASE}/en/illustrators`, { timeout: 20000 }).catch(() => ({ data: [] }))
      ]);

      const rawDe = Array.isArray(deRes.data) ? deRes.data : [];
      const rawEn = Array.isArray(enRes.data) ? enRes.data : [];

      const set = new Set();
      [...rawDe, ...rawEn].forEach((x) => {
        const name = typeof x === 'string' ? x : x && x.name;
        if (name) set.add(name.trim());
      });

      const list = Array.from(set).sort((a, b) => a.localeCompare(b));
      illustratorCache = { at: Date.now(), list };
    }
    res.json(illustratorCache.list);
  } catch (e) {
    console.error('Illustrator-Liste:', e.response?.status || e.message);
    res.status(502).json({ error: 'Artist-Liste konnte nicht geladen werden.' });
  }
});

app.get('/api/illustrators/:name', async (req, res) => {
  try {
    const r = await axios.get(`${TCGDEX_BASE}/en/illustrators/${encodeURIComponent(req.params.name)}`, { timeout: 25000 });
    const idx = await getSetsIndex().catch(() => ({ names: new Map(), order: new Map() }));
    const cards = briefsToCards(r.data && r.data.cards, idx);
    if (cards.length === 0) return res.status(404).json({ error: 'Keine Karten für diesen Artist.' });
    res.json({ name: (r.data && r.data.name) || req.params.name, cards });
  } catch (e) {
    const status = e.response?.status === 404 ? 404 : 502;
    res.status(status).json({ error: status === 404 ? 'Artist nicht gefunden.' : 'Artist konnte nicht geladen werden.' });
  }
});

app.get('/api/dex/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Ungültige Pokédex-Nummer.' });

    const [deRes, enRes, idx] = await Promise.all([
      axios.get(`${TCGDEX_BASE}/de/dex-ids/${id}`, { timeout: 25000 }).catch(() => ({ data: { cards: [] } })),
      axios.get(`${TCGDEX_BASE}/en/dex-ids/${id}`, { timeout: 25000 }).catch(() => ({ data: { cards: [] } })),
      getSetsIndex().catch(() => ({ names: new Map(), order: new Map() }))
    ]);

    const deCards = (deRes.data && Array.isArray(deRes.data.cards)) ? deRes.data.cards : [];
    const enCards = (enRes.data && Array.isArray(enRes.data.cards)) ? enRes.data.cards : [];

    const cardMap = new Map();
    deCards.forEach((c) => { if (c && c.id) cardMap.set(c.id, c); });
    enCards.forEach((c) => { if (c && c.id && !cardMap.has(c.id)) cardMap.set(c.id, c); });

    const combinedCards = Array.from(cardMap.values());

    res.json({ id, cards: briefsToCards(combinedCards, idx) });
  } catch (e) {
    const status = e.response?.status === 404 ? 404 : 502;
    if (status === 404) return res.json({ id: parseInt(req.params.id, 10), cards: [] });
    res.status(502).json({ error: 'Karten konnten nicht geladen werden.' });
  }
});

let pokedexCache = { at: 0, data: null };
async function gql(url, query) {
  const r = await axios.post(url, { query }, { timeout: 30000, headers: { 'Content-Type': 'application/json' } });
  if (r.data && r.data.errors) throw new Error(JSON.stringify(r.data.errors).slice(0, 200));
  return r.data.data;
}

async function loadPokedex() {
  const attempts = [
    ['https://graphql.pokeapi.co/v1beta2', 'pokemonspecies', 'pokemonspeciesnames'],
    ['https://beta.pokeapi.co/graphql/v1beta', 'pokemon_v2_pokemonspecies', 'pokemon_v2_pokemonspeciesnames']
  ];
  for (const [url, t, rel] of attempts) {
    try {
      const data = await gql(url, `{ ${t}(order_by: {id: asc}) { id ${rel}(where: {language_id: {_in: [6, 9]}}) { language_id name } } }`);
      const rows = data[t] || [];
      if (rows.length < 100) continue;
      return { lang: 'de', list: rows.map((r) => {
        const names = r[rel] || [];
        const de = (names.find((n) => n.language_id === 6) || {}).name;
        const en = (names.find((n) => n.language_id === 9) || {}).name;
        return { id: r.id, name: de || en || `#${r.id}`, nameEn: en || de || `#${r.id}` };
      }) };
    } catch (e) {
      console.error('Pokédex GraphQL fehlgeschlagen:', url, e.message);
    }
  }

  const r = await axios.get('https://pokeapi.co/api/v2/pokemon-species?limit=3000', { timeout: 30000 });
  const list = (r.data.results || []).map((s) => {
    const id = Number(String(s.url).split('/').filter(Boolean).pop());
    const name = s.name.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('-');
    return { id, name, nameEn: name };
  }).filter((x) => x.id).sort((a, b) => a.id - b.id);
  return { lang: 'en', list };
}

app.get('/api/pokedex', async (req, res) => {
  try {
    if (!pokedexCache.data || Date.now() - pokedexCache.at > DAY_MS) {
      pokedexCache = { at: Date.now(), data: await loadPokedex() };
    }
    res.json(pokedexCache.data);
  } catch (e) {
    console.error('Pokédex laden fehlgeschlagen:', e.message);
    res.status(502).json({ error: 'Pokédex-Liste konnte nicht geladen werden.' });
  }
});

app.get('/api/card/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    let card = null;
    let foundLang = null;

    for (const lang of ['de', 'en']) {
      try { 
        card = await fetchDetail(lang, id); 
        if (card) {
          foundLang = lang;
          break; 
        }
      } catch (e) {}
    }

    if (!card) return res.status(404).json({ error: 'Karte nicht gefunden.' });

    card.language = foundLang;

    try {
      card = await enrichWithCardmarket(card);
    } catch (cmError) {
      console.warn(`Cardmarket-Enrichment fehlgeschlagen für ${id}:`, cmError.message);
      card.cardmarket = card.cardmarket || null;
    }

    res.json(card);
  } catch (e) {
    console.error(`Fehler in /api/card/${req.params.id}:`, e.message);
    res.status(502).json({ error: 'Karte konnte nicht geladen werden.' });
  }
});

const metaCache = new Map();
app.post('/api/card-meta', async (req, res) => {
  try {
    const raw = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = [...new Set(raw.map(String))].slice(0, 60);
    const meta = {};
    await mapLimit(ids, 6, async (id) => {
      if (metaCache.has(id)) { meta[id] = metaCache.get(id); return; }
      if (id.startsWith('custom-') || id.startsWith('cm-')) { meta[id] = { dexId: [], illustrator: null }; return; }
      for (const lang of ['en', 'de']) {
        try {
          const r = await axios.get(`${TCGDEX_BASE}/${lang}/cards/${encodeURIComponent(id)}`, { timeout: 10000 });
          const m = {
            dexId: Array.isArray(r.data.dexId) ? r.data.dexId.map(Number).filter(Number.isFinite) : [],
            illustrator: r.data.illustrator || null
          };
          metaCache.set(id, m); meta[id] = m;
          return;
        } catch (e) {}
      }
    });
    res.json({ meta });
  } catch (e) {
    res.status(500).json({ error: 'Karten-Daten konnten nicht geladen werden.' });
  }
});

app.post('/api/cards/bulk', async (req, res) => {
  try {
    const raw = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = [...new Set(raw.map(String))].filter((id) => id && !id.startsWith('custom-')).slice(0, 40);
    if (ids.length === 0) return res.status(400).json({ error: 'ids fehlen' });
    await cardmarket.ready();
    const found = await mapLimit(ids, 6, async (id) => {
      try {
        if (id.startsWith('cm-')) return cardmarket.cardOfProduct(Number(id.slice(3)));
        let card = null;
        for (const lang of ['de', 'en']) {
          try { card = await fetchDetail(lang, id); break; } catch (e) {}
        }
        return card ? await enrichWithCardmarket(card) : null;
      } catch (e) {
        return null;
      }
    });
    res.json({ cards: found.filter(Boolean) });
  } catch (e) {
    console.error('Bulk-Karten Fehler:', e.message);
    res.status(500).json({ error: 'Karten konnten nicht geladen werden.' });
  }
});

// ---------------------------------------------------------------------
// KARTEN-SUCHE (TCGdex + Cardmarket Fallback)
// ---------------------------------------------------------------------
app.get('/api/cards', async (req, res) => {
  try {
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    const set = typeof req.query.set === 'string' ? req.query.set : '';

    if (!name.trim()) {
      return res.status(400).json({ error: 'Name ist erforderlich' });
    }

    const parsed = parseQuery(name);
    if (!parsed.name) {
      return res.status(400).json({ error: 'Bitte einen Kartennamen angeben (z.B. "Glumanda 044").' });
    }

    const cleanSet = set ? set.trim() : '';
    let idToLang = await collectIds(parsed, cleanSet, true);

    if (idToLang.size === 0 && parsed.number) {
      idToLang = await collectIds(parsed, cleanSet, false);
    }

    if (idToLang.size === 0) {
      return res.json(cardmarket.search(parsed.name));
    }

    const entries = Array.from(idToLang.entries()).slice(0, 40);

    const detailed = await Promise.all(
      entries.map(async ([id, lang]) => {
        try {
          return await fetchDetail(lang, id);
        } catch (e) {
          return null;
        }
      })
    );

    let results = detailed.filter(Boolean);
    if (results.length === 0) return res.json(cardmarket.search(parsed.name));

    if (parsed.number?.total) {
      results = results.filter(c => c.set?.total == null || String(c.set.total) === parsed.number.total);
    }

    results = await mapLimit(results, 8, enrichWithCardmarket);

    results.sort((a, b) =>
      (a.name || '').localeCompare(b.name || '') || (a.set?.name || '').localeCompare(b.set?.name || '')
    );

    return res.json(results);
  } catch (error) {
    console.error('Fehler bei /api/cards:', error);
    return res.status(500).json({ error: 'Fehler beim Laden der Karten' });
  }
});

const wantCache = new Map();
app.post('/api/wantlist-names', async (req, res) => {
  try {
    const raw = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = [...new Set(raw.map(String))].filter((id) => id && !id.startsWith('custom-') && !id.startsWith('cm-')).slice(0, 100);
    const names = {};
    await mapLimit(ids, 6, async (id) => {
      if (wantCache.has(id)) { names[id] = wantCache.get(id); return; }
      try {
        const r = await axios.get(`${TCGDEX_BASE}/en/cards/${encodeURIComponent(id)}`, { timeout: 10000 });
        const v = {
          name: r.data.name,
          set: r.data.set?.name || null,
          abbr: await getSetAbbr(r.data.set?.id),
          number: r.data.localId || null,
          abilities: (r.data.abilities || []).map((a) => a.name).filter(Boolean),
          attacks: (r.data.attacks || []).map((a) => a.name).filter(Boolean)
        };
        if (wantCache.size > 5000) wantCache.clear();
        wantCache.set(id, v); names[id] = v;
      } catch (e) {}
    });
    res.json({ names });
  } catch (e) {
    res.status(500).json({ error: 'Namen konnten nicht geladen werden.' });
  }
});

require('./jobs')({ cardmarket, refreshOne, mapLimit }).registerRoutes(app);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));