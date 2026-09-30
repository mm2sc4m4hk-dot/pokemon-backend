// Zweite Datenquelle: Cardmarkets täglich veröffentlichte Dateien
// (Price Guide + Produktkatalog "Pokémon Single").
//
// Konfiguration über Umgebungsvariablen (Render -> Environment):
//   CM_PRICE_GUIDE_URL  direkter Link zur Price-Guide-JSON
//   CM_PRODUCTS_URL     direkter Link zur Produktkatalog-JSON (Einzelkarten)
// Alternativ liegen die Dateien lokal unter data/price_guide.json und
// data/products_singles.json. Optional: data/expansions.json
// ({ "1585": "Primal Clash", ... }) für lesbare Set-Namen.
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const PRICE_URL = process.env.CM_PRICE_GUIDE_URL || '';
const PRODUCTS_URL = process.env.CM_PRODUCTS_URL || '';
const REFRESH_MS = 12 * 60 * 60 * 1000; // zweimal täglich nachsehen

let index = [];
let expansionNames = {};
const meta = { loadedAt: null, products: 0, priceGuideDate: null, error: null };

const words = (s) =>
  String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();

async function loadJson(url, localFile) {
  if (url) {
    const res = await axios.get(url, { timeout: 120000, maxContentLength: Infinity, responseType: 'json' });
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  }
  const file = path.join(DATA_DIR, localFile);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  return null;
}

function build(priceFile, productFile) {
  const prices = new Map();
  for (const r of priceFile.priceGuides || []) prices.set(r.idProduct, r);

  const list = [];
  for (const p of productFile.products || []) {
    // "Sceptile [Leaf Blade | Power Poison]" -> Basisname "Sceptile"
    const base = String(p.name || '').split(/\s*[\[(]/)[0];
    list.push({
      id: p.idProduct,
      name: p.name,
      baseWords: words(base),
      expansionId: p.idExpansion,
      price: prices.get(p.idProduct) || null
    });
  }
  return { list, date: priceFile.createdAt || null };
}

async function refresh() {
  try {
    const [priceFile, productFile] = await Promise.all([
      loadJson(PRICE_URL, 'price_guide.json'),
      loadJson(PRODUCTS_URL, 'products_singles.json')
    ]);
    if (!priceFile || !productFile) {
      meta.error = 'Keine Cardmarket-Dateien konfiguriert (CM_PRICE_GUIDE_URL / CM_PRODUCTS_URL oder data/*.json).';
      return false;
    }
    const built = build(priceFile, productFile);
    index = built.list;
    meta.products = index.length;
    meta.priceGuideDate = built.date;
    meta.loadedAt = new Date().toISOString();
    meta.error = null;
    try { expansionNames = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'expansions.json'), 'utf8')); } catch (e) { /* optional */ }
    console.log(`Cardmarket-Index geladen: ${index.length} Produkte (Price Guide ${built.date})`);
    return true;
  } catch (e) {
    meta.error = e.message;
    console.error('Cardmarket-Dateien laden fehlgeschlagen:', e.message);
    return false;
  }
}

function init() {
  refresh();
  setInterval(refresh, REFRESH_MS).unref();
}

function toCard(p) {
  const r = p.price || {};
  return {
    id: `cm-${p.id}`,
    name: p.name,
    number: null,
    images: { small: '', large: '' },
    set: { name: expansionNames[p.expansionId] || `Cardmarket-Set ${p.expansionId}`, total: null },
    variants: null,
    source: 'cardmarket',
    cardmarket: {
      url: `https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(p.name)}`,
      prices: {
        trendPrice: r.trend ?? r.avg ?? 0,
        averageSellPrice: r.avg ?? 0,
        avg1: r.avg1 ?? 0, avg7: r.avg7 ?? 0, avg30: r.avg30 ?? 0,
        low: r.low ?? 0,
        trendPriceHolo: r['trend-holo'] ?? r['avg-holo'] ?? 0,
        avg1Holo: r['avg1-holo'] ?? 0, avg7Holo: r['avg7-holo'] ?? 0, avg30Holo: r['avg30-holo'] ?? 0,
        lowHolo: r['low-holo'] ?? 0
      }
    }
  };
}

// Alle Suchwörter müssen im Kartennamen vorkommen ("Dedenne GX" findet
// "Dedenne-GX"). Exakte Treffer zuerst, dann nach Trendpreis.
function search(query, limit = 40) {
  const q = words(query);
  if (!q || index.length === 0) return [];
  const tokens = q.split(' ');
  const hits = index.filter(p => tokens.every(t => p.baseWords.includes(t)));
  const rank = (p) => (p.baseWords === q ? 0 : p.baseWords.startsWith(q) ? 1 : 2);
  hits.sort((a, b) => rank(a) - rank(b) || (b.price?.trend ?? 0) - (a.price?.trend ?? 0));
  return hits.slice(0, limit).map(toCard);
}

module.exports = { init, refresh, search, meta };
