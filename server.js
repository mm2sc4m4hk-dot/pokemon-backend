const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cardmarket = require('./cardmarket');

const app = express();
app.set('trust proxy', 1); // hinter Render: echte Client-IP für das Rate-Limit

// CORS: auf Render unter ALLOWED_ORIGINS (kommagetrennt, z. B. https://deine-app.vercel.app) eintragen.
// Ohne die Variable bleibt alles offen wie bisher. Anfragen ohne Origin (Cron, curl) gehen immer durch.
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
app.use(['/api/cards', '/api/card', '/api/card-meta', '/api/prices'], rateLimit(120));
app.use('/api/img', rateLimit(600));

// --- Datenquelle: TCGdex (https://tcgdex.dev) ---
// Kostenlos, kein API-Key, echte Cardmarket-Preise (EUR) direkt im
// Card-Objekt, Karten nativ in mehreren Sprachen (u.a. Deutsch).
const TCGDEX_BASE = 'https://api.tcgdex.net/v2';

// Zweite Datenquelle (Cardmarket-Dateien) im Hintergrund laden und täglich erneuern
cardmarket.init();

app.get('/api/cardmarket-status', (req, res) => res.json(cardmarket.meta));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Bild-Proxy (nur TCGdex-Assets): erlaubt dem Frontend, Kartenbilder in ein Canvas zu zeichnen
// ("Binder-Seite als Bild teilen"), falls der Direktabruf wegen CORS nicht klappt.
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

// ---------------------------------------------------------------------
// Suchbegriff zerlegen: "Glumanda 044", "Glumanda 44/102", "Pikachu SV044",
// "Glumanda #044" -> Name + Kartennummer (wie bei Cardmarket).
// Steht am Ende KEINE Nummer, wird ganz normal nur nach dem Namen gesucht.
// ---------------------------------------------------------------------
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
          digits: String(parseInt(m[2], 10)), // "044" -> "44"
          suffix: m[3].toLowerCase(),         // "195a" -> "a"
          total: m[4] ? String(parseInt(m[4].replace(/\D/g, ''), 10)) : null
        }
      };
    }
  }
  return { name: tokens.join(' '), number: null };
}

// localId aus TCGdex ("044", "44", "SV044", "TG05") in Prefix + Zahl ohne
// führende Nullen zerlegen, damit "044" und "44" als gleich gelten.
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

// Baut aus einem TCGdex-Kartenobjekt die Form, die das Frontend erwartet.
function normalizeCard(card, lang) {
  const img = card.image ? `${card.image}/high.webp` : '';
  const imgSmall = card.image ? `${card.image}/low.webp` : '';
  const cm = card.pricing?.cardmarket || {};

  return {
    id: card.id,
    name: card.name,
    number: card.localId || null,
    images: { small: imgSmall || img, large: img },
    // Angriffsnamen (für den Preisabgleich mit Cardmarket)
    attacks: (card.attacks || []).map(a => a.name).filter(Boolean),
    set: {
      id: card.set?.id || null,
      name: card.set?.name || null,
      total: card.set?.cardCount?.official ?? null
    },
    // Welche Druckvarianten es laut TCGdex gibt, z.B.
    // { normal: true, reverse: true, holo: false, firstEdition: false }
    variants: card.variants || null,
    // Pokédex-Nummer(n) und Zeichner (für Pokédex-/Artist-Ansicht)
    dexId: Array.isArray(card.dexId) ? card.dexId.map(Number).filter(Number.isFinite) : [],
    illustrator: card.illustrator || null,
    // Cardmarket-Suchlink mit Name + Nummer (so findet Cardmarket die
    // Karte direkt, z.B. "Glumanda 044").
    cardmarket: {
      url: `https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(
        [card.name, card.localId].filter(Boolean).join(' ')
      )}`,
      prices: {
        // Normale (Non-Foil) Preisreihe
        trendPrice: cm.trend ?? cm.avg ?? 0,
        averageSellPrice: cm.avg ?? 0,
        avg1: cm.avg1 ?? 0,
        avg7: cm.avg7 ?? 0,
        avg30: cm.avg30 ?? 0,
        low: cm.low ?? 0,
        // Holo/Foil-Preisreihe (Cardmarket führt "foil" getrennt)
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

// "Dedenne GX" -> auch "Dedenne-GX" probieren (TCGdex nutzt den Bindestrich
// bei GX/EX/V/VMAX/VSTAR-Karten).
function nameVariants(name) {
  const variants = [name];
  const hyphenated = name.replace(/\s+(GX|EX|V|VMAX|VSTAR|VUNION|ex)$/i, '-$1');
  if (hyphenated !== name) variants.push(hyphenated);
  return variants;
}

// Sucht Karten in einer TCGdex-Sprache und liefert die schlanke Brief-Liste
// (id, localId, name, image). Optional mit Nummernfilter (Teilstring-Suche
// auf localId, wird danach in matchesNumber noch exakt geprüft).
async function searchBriefs(lang, name, set, numberDigits, perPage) {
  try {
    const params = new URLSearchParams();
    params.set('name', name); // Default = "laxist" Teilstring-Suche
    if (numberDigits) params.set('localId', numberDigits);
    if (set) params.set('set.name', `like:${set}`);
    params.set('pagination:itemsPerPage', String(perPage));

    const res = await axios.get(`${TCGDEX_BASE}/${lang}/cards?${params.toString()}`, { timeout: 10000 });
    return Array.isArray(res.data) ? res.data : [];
  } catch (e) {
    // Eine fehlschlagende Sprache darf die andere nicht mit runterreißen.
    console.error(`TCGdex Brief-Suche (${lang}) fehlgeschlagen:`, e.response?.status || e.message);
    return [];
  }
}

async function fetchDetail(lang, id) {
  const res = await axios.get(`${TCGDEX_BASE}/${lang}/cards/${id}`, { timeout: 10000 });
  const normalized = normalizeCard(res.data, lang);

  // Manche (v.a. deutsche) Karten haben noch kein Bild -> Bild (und
  // Varianten/Preise, falls dort leer) von der englischen Version holen.
  if (!normalized.images.small && lang !== 'en') {
    try {
      const enRes = await axios.get(`${TCGDEX_BASE}/en/cards/${id}`, { timeout: 10000 });
      const enNormalized = normalizeCard(enRes.data, 'en');
      normalized.images = enNormalized.images;
    } catch (e) {
      // kein Bild verfügbar -> Frontend zeigt einen Platzhalter
    }
  }

  return normalized;
}

// Deutsch UND Englisch parallel durchsuchen und über die sprachunabhängige
// Karten-ID zusammenführen (deutsch bevorzugt, sonst englisch).
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

  const keep = (b) => !parsed.number || matchesNumber(b.localId, parsed.number);

  const idToLang = new Map();
  deBriefs.filter(keep).forEach(b => idToLang.set(b.id, 'de'));
  enBriefs.filter(keep).forEach(b => { if (!idToLang.has(b.id)) idToLang.set(b.id, 'en'); });
  return idToLang;
}

// Englischer Name + Angriffe einer Karte (Cardmarket-Namen sind englisch). Wird gemerkt.
const englishCache = new Map();
async function getEnglish(card) {
  if (card._lang === 'en') return { name: card.name, attacks: card.attacks || [] };
  if (englishCache.has(card.id)) return englishCache.get(card.id);
  const res = await axios.get(`${TCGDEX_BASE}/en/cards/${card.id}`, { timeout: 10000 });
  const en = { name: res.data.name, attacks: (res.data.attacks || []).map(a => a.name).filter(Boolean) };
  englishCache.set(card.id, en);
  return en;
}

// Sucht zur TCGdex-Karte das passende Cardmarket-Produkt (gleiches Set, gleicher
// Name, bei mehreren Versionen gleiche Angriffe) und nimmt dessen Tagespreise.
async function enrichWithCardmarket(card) {
  try {
    await cardmarket.ready(); // nach einem Kaltstart erst den Cardmarket-Index abwarten
    const setId = card.set?.id;
    if (!setId || !cardmarket.hasSet(setId)) return card;
    const en = await getEnglish(card);
    const cands = cardmarket.candidates(setId, en.name);
    if (cands.length === 0) return card;
    const product = cands.length === 1 ? cands[0] : cardmarket.pickByAttacks(cands, en.attacks);
    return product ? cardmarket.applyProduct(card, product) : card;
  } catch (e) {
    return card; // Abgleich ist nur ein Bonus: bei Fehlern bleibt der TCGdex-Preis
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n]); }
  }));
  return out;
}

// Kartenliste eines Sets (für den Set-Fortschritt im Frontend)
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

// ---------------------------------------------------------------------
// Preis-Aktualisierung: das Frontend schickt die Karten-IDs der Collection
// und Watchlist und bekommt die aktuellen Cardmarket-Preise zurück.
// Ergebnisse bleiben bis zur nächsten Cardmarket-Tagesdatei im Speicher, damit mehrfaches
// Aktualisieren (oder mehrere Nutzer) TCGdex nicht unnötig belasten.
// ---------------------------------------------------------------------
// Cardmarket aktualisiert nur einmal täglich: ein Eintrag gilt, solange die Tagesdatei (priceGuideDate)
// dieselbe ist (höchstens 12 Stunden als Sicherheitsnetz). Der Tages-Job (jobs.js) wärmt den Cache vor.
const priceCache = new Map(); // id -> { at, date, data }
const PRICE_TTL_MS = 12 * 60 * 60 * 1000;

async function refreshOne(id, force = false) {
  const hit = priceCache.get(id);
  if (!force && hit && hit.date === (cardmarket.meta.priceGuideDate || null) && Date.now() - hit.at < PRICE_TTL_MS) return hit.data;

  let data = null;
  if (id.startsWith('cm-')) {
    // Treffer, die nur aus der Cardmarket-Datei stammen
    data = cardmarket.pricesOfProduct(Number(id.slice(3)));
  } else if (!id.startsWith('custom-')) {
    let card = null;
    for (const lang of ['en', 'de']) {
      try { card = await fetchDetail(lang, id); break; } catch (e) { /* nächste Sprache */ }
    }
    if (card) {
      card = await enrichWithCardmarket(card);
      data = {
        prices: card.cardmarket.prices,
        productId: card.cardmarket.productId || null,
        priceSource: card.cardmarket.priceSource || 'tcgdex',
        priceDate: card.cardmarket.priceDate || null
      };
    }
  }
  if (data) priceCache.set(id, { at: Date.now(), date: cardmarket.meta.priceGuideDate || null, data });
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
      } catch (e) { /* einzelne Karte überspringen */ }
    });
    res.json({ prices, priceGuideDate: cardmarket.meta.priceGuideDate });
  } catch (e) {
    console.error('Preis-Refresh Fehler:', e.message);
    res.status(500).json({ error: 'Preise konnten nicht aktualisiert werden.' });
  }
});

// ---------------------------------------------------------------------
// Artist-, Pokédex- und Karten-Endpunkte für Artist-Ansicht, Pokédex und Binder
// ---------------------------------------------------------------------
const DAY_MS = 24 * 60 * 60 * 1000;

// Set-Namen und Reihenfolge (aus der Karten-ID wird die Set-ID abgeleitet)
let setsIndex = { at: 0, names: new Map(), order: new Map() };
async function getSetsIndex() {
  if (setsIndex.names.size && Date.now() - setsIndex.at < 6 * 60 * 60 * 1000) return setsIndex;
  const r = await axios.get(`${TCGDEX_BASE}/en/sets`, { timeout: 20000 });
  const names = new Map(); const order = new Map();
  (Array.isArray(r.data) ? r.data : []).forEach((s, i) => { names.set(s.id, s.name); order.set(s.id, i); });
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
      const r = await axios.get(`${TCGDEX_BASE}/en/illustrators`, { timeout: 20000 });
      const list = (Array.isArray(r.data) ? r.data : [])
        .map((x) => (typeof x === 'string' ? x : x && x.name)).filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
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

// Alle Karten eines Pokémon (nationale Pokédex-Nummer)
app.get('/api/dex/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Ungültige Pokédex-Nummer.' });
    const r = await axios.get(`${TCGDEX_BASE}/en/dex-ids/${id}`, { timeout: 25000 });
    const idx = await getSetsIndex().catch(() => ({ names: new Map(), order: new Map() }));
    res.json({ id, cards: briefsToCards(r.data && r.data.cards, idx) });
  } catch (e) {
    const status = e.response?.status === 404 ? 404 : 502;
    if (status === 404) return res.json({ id: parseInt(req.params.id, 10), cards: [] });
    res.status(502).json({ error: 'Karten konnten nicht geladen werden.' });
  }
});

// Pokédex-Liste (Nummer + Name, deutsch wenn verfügbar) aus der PokéAPI, 1x pro Tag
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
  // Fallback: REST-Liste (nur englische Namen)
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

// Einzelne Karte komplett (inkl. Cardmarket-Preise) – z. B. zum Hinzufügen zur Watchlist
app.get('/api/card/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    let card = null;
    for (const lang of ['de', 'en']) {
      try { card = await fetchDetail(lang, id); break; } catch (e) { /* nächste Sprache */ }
    }
    if (!card) return res.status(404).json({ error: 'Karte nicht gefunden.' });
    res.json(await enrichWithCardmarket(card));
  } catch (e) {
    res.status(502).json({ error: 'Karte konnte nicht geladen werden.' });
  }
});

// Pokédex-Nummer(n) und Artist für viele Karten (einmaliges Nachladen für ältere Collection-Einträge)
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
        } catch (e) { /* nächste Sprache */ }
      }
    });
    res.json({ meta });
  } catch (e) {
    res.status(500).json({ error: 'Karten-Daten konnten nicht geladen werden.' });
  }
});

// Mehrere Karten auf einmal komplett laden (inkl. Cardmarket-Preise) – z. B. "Alle in die Wishlist"
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
          try { card = await fetchDetail(lang, id); break; } catch (e) { /* nächste Sprache */ }
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

    // Fallback: falls der Nummernfilter der API nichts findet (z.B. wegen
    // abweichender Nummern-Schreibweise), ohne Filter suchen und die
    // Nummer selbst vergleichen.
    if (idToLang.size === 0 && parsed.number) {
      idToLang = await collectIds(parsed, cleanSet, false);
    }

    // TCGdex kennt die Karte nicht -> in den Cardmarket-Dateien suchen
    // (ohne Bild und ohne Nummernfilter, dafür mit echtem Preis).
    if (idToLang.size === 0) {
      return res.json(cardmarket.search(parsed.name));
    }

    // Auf max. 40 Karten begrenzen, um nicht zu viele Detailanfragen
    // gleichzeitig zu feuern.
    const entries = Array.from(idToLang.entries()).slice(0, 40);

    const detailed = await Promise.all(
      entries.map(async ([id, lang]) => {
        try {
          return await fetchDetail(lang, id);
        } catch (e) {
          return null; // einzelne kaputte Karte überspringen
        }
      })
    );

    let results = detailed.filter(Boolean);
    if (results.length === 0) return res.json(cardmarket.search(parsed.name));

    // "Glumanda 044/102": zusätzlich nach der Set-Gesamtzahl filtern, wenn
    // TCGdex sie kennt (Karten ohne Angabe bleiben drin).
    if (parsed.number?.total) {
      results = results.filter(c => c.set.total == null || String(c.set.total) === parsed.number.total);
    }

    results = await mapLimit(results, 8, enrichWithCardmarket);

    results.sort((a, b) =>
      (a.name || '').localeCompare(b.name || '') || (a.set?.name || '').localeCompare(b.set?.name || '')
    );
    res.json(results);
  } catch (error) {
    const status = error.response?.status;
    console.error('TCGdex API Error:', status, error.response ? error.response.data : error.message);
    if (status === 400) {
      return res.status(400).json({ error: 'Ungültige Suchanfrage.' });
    }
    if (error.code === 'ECONNABORTED') {
      return res.status(504).json({ error: 'Zeitüberschreitung bei der Kartendatenbank. Bitte erneut versuchen.' });
    }
    res.status(500).json({ error: 'Fehler beim Abrufen der Karten' });
  }
});

// Täglicher Job: Preis-Historie, Firestore-Preiscache, Push bei Zielpreis (siehe jobs.js)
require('./jobs')({ cardmarket, refreshOne, mapLimit }).registerRoutes(app);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));