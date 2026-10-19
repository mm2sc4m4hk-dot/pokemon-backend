// Zweite Datenquelle: Cardmarkets täglich veröffentlichte Dateien
// (Price Guide + Produktkatalog "Pokémon Single").
//
// Konfiguration über Umgebungsvariablen (Render -> Environment):
//   CM_PRICE_GUIDE_URL  direkter Link zur Price-Guide-JSON
//   CM_PRODUCTS_URL     direkter Link zur Produktkatalog-JSON (Einzelkarten)
//   DISCORD_WEBHOOK_URL optional: Discord-Webhook für Fehler-Benachrichtigungen
// Alternativ liegen die Dateien lokal unter data/price_guide.json und
// data/products_singles.json. Optional: data/expansions.json
// ({ "1585": { "name": "Primal Clash", "tcgdexId": "xy5" }, ... }) für Set-Namen und
// den genauen Preisabgleich (erzeugt von build-expansions.js).
//
// RAM-Strategie für den 512-MB-Render-Gratisplan:
// - Dateien werden nacheinander (nicht parallel) geladen, um den Speicher-Gipfel niedrig zu halten
// - Die JSON-Dateien werden als Stream gelesen (streamArray): nie die ganze Datei im RAM
// - Pro Produkt werden nur die benötigten Felder im Index behalten
// - Node.js sollte mit --max-old-space-size=256 gestartet werden
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');
const { promisify } = require('util');
const { sendDiscordAlert } = require('./discordAlert');

const DATA_DIR = path.join(__dirname, 'data');
const TMP_DIR = path.join(__dirname, 'data', 'tmp');
const PRICE_URL = process.env.CM_PRICE_GUIDE_URL || '';
const PRODUCTS_URL = process.env.CM_PRODUCTS_URL || '';
const REFRESH_MS = 12 * 60 * 60 * 1000; // zweimal täglich nachsehen

let index = [];
let expansionNames = {};   // id -> Anzeigename
let setToExpansions = new Map(); // TCGdex-Set-ID -> [Cardmarket-Set-IDs]
let byExpName = new Map();       // `${expansionId}|${basisname}` -> [Produkte]
let byId = new Map();            // Cardmarket-Produkt-ID -> Produkt
const meta = { loadedAt: null, products: 0, priceGuideDate: null, error: null };

// Cardmarket nennt die Holo-Reihe je nach Datei "-holo" oder "-foil": beide Schreibweisen lesen
const holoField = (r, base) => r[`${base}-holo`] ?? r[`${base}-foil`];

// Nur die Preisfelder behalten, die toCard/applyProduct/search wirklich lesen (spart RAM im Index)
const slim = (r) => r && {
  trend: r.trend, avg: r.avg, avg1: r.avg1, avg7: r.avg7, avg30: r.avg30, low: r.low,
  'trend-holo': holoField(r, 'trend'), 'avg-holo': holoField(r, 'avg'),
  'avg1-holo': holoField(r, 'avg1'), 'avg7-holo': holoField(r, 'avg7'),
  'avg30-holo': holoField(r, 'avg30'), 'low-holo': holoField(r, 'low')
};

const words = (s) =>
  String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();

const streamPipeline = promisify(pipeline);

// Datei per Stream auf die Festplatte laden (spart RAM vs. kompletter In-Memory-Download)
async function downloadToFile(url, destFile) {
  const res = await axios.get(url, {
    timeout: 120000,
    responseType: 'stream',
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  });
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  await streamPipeline(res.data, fs.createWriteStream(destFile));
}

// Liest eine große JSON-Datei der Form { "createdAt": "...", "<arrayKey>": [ {...}, {...} ] } als Stream
// und ruft onItem für jedes Objekt des Arrays auf. Es liegt immer nur ein Objekt (plus ein Datei-Block)
// im Speicher, nicht die ganze Datei als String UND als Objektbaum.
// Rückgabe: { createdAt } oder null, wenn weder URL noch lokale Datei vorhanden sind.
async function streamArray(url, localFile, arrayKey, onItem) {
  let file = null;
  let tmpFile = null;
  if (url) {
    tmpFile = path.join(TMP_DIR, localFile.replace('.json', '-' + Date.now() + '.json'));
    try {
      await downloadToFile(url, tmpFile);
    } catch (e) {
      try { fs.unlinkSync(tmpFile); } catch (err) { /* ignore */ }
      await sendDiscordAlert('cardmarket-download', `Cardmarket-Download fehlgeschlagen: ${localFile}`, e);
      throw e;
    }
    file = tmpFile;
  } else {
    const local = path.join(DATA_DIR, localFile);
    if (!fs.existsSync(local)) return null;
    file = local;
  }

  try {
    const input = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 256 * 1024 });
    let depth = 0; let inStr = false; let esc = false;
    let rootBuf = ''; let curKey = null; let item = ''; let itemStart = -1;

    for await (const chunk of input) {
      for (let i = 0; i < chunk.length; i += 1) {
        const c = chunk[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          if (depth === 1) rootBuf += c;
          continue;
        }
        if (c === '"') { inStr = true; if (depth === 1) rootBuf += c; continue; }
        if (c === '{' || c === '[') {
          if (depth === 1 && c === '[') {
            const m = /"([^"]*)"\s*:\s*$/.exec(rootBuf);
            curKey = m ? m[1] : null;
            // rootBuf NICHT leeren: Cardmarket schreibt "createdAt" VOR das
            // Array. Top-Level-Werte (Strings/Zahlen) sind klein, deshalb
            // bleibt der Puffer unkritisch für den Speicher.
          }
          if (depth === 2 && c === '{' && curKey === arrayKey) { itemStart = i; item = ''; }
          depth += 1;
          continue;
        }
        if (c === '}' || c === ']') {
          depth -= 1;
          if (depth === 2 && c === '}' && itemStart !== -1) {
            item += chunk.slice(itemStart, i + 1);
            itemStart = -1;
            onItem(JSON.parse(item));
            item = '';
          } else if (depth === 1 && c === ']') {
            curKey = null;
          }
          continue;
        }
        if (depth === 1) rootBuf += c;
      }
      if (itemStart !== -1) { item += chunk.slice(itemStart); itemStart = 0; }
    }
    const created = /"createdAt"\s*:\s*"([^"]*)"/.exec(rootBuf);
    return { createdAt: created ? created[1] : null };
  } finally {
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ } }
  }
}

let refreshing = null;
async function refresh() {
  if (refreshing) return refreshing; // läuft schon -> dasselbe Promise teilen (spart RAM)
  refreshing = doRefresh().finally(() => { refreshing = null; });
  return refreshing;
}

// Nur neu laden, wenn der Index älter als maxAgeMs ist (für den Tages-Job)
async function refreshIfStale(maxAgeMs = 6 * 60 * 60 * 1000) {
  const age = meta.loadedAt ? Date.now() - new Date(meta.loadedAt).getTime() : Infinity;
  return age > maxAgeMs ? refresh() : false;
}

async function doRefresh() {
  try {
    // Nacheinander laden und beim Lesen sofort auf die nötigen Felder reduzieren (RAM-Gipfel niedrig halten)
    const prices = new Map();
    const guide = await streamArray(PRICE_URL, 'price_guide.json', 'priceGuides', (r) => { prices.set(r.idProduct, slim(r)); });
    if (!guide) {
      meta.error = 'Keine Cardmarket-Price-Guide-Datei konfiguriert (CM_PRICE_GUIDE_URL oder data/price_guide.json).';
      return false;
    }
    const priceGuideDate = guide.createdAt || null;

    const list = [];
    const prod = await streamArray(PRODUCTS_URL, 'products_singles.json', 'products', (p) => {
      const base = String(p.name || '').split(/\s*[\[(]/)[0];
      const br = String(p.name).match(/\[(.*)\]/);
      const attacks = br ? br[1].split('|').map(a => words(a)).filter(Boolean) : [];
      list.push({
        id: p.idProduct,
        name: p.name,
        attacks,
        baseWords: words(base),
        expansionId: p.idExpansion,
        price: prices.get(p.idProduct) || null
      });
    });
    if (!prod) {
      meta.error = 'Keine Cardmarket-Produktdatei konfiguriert (CM_PRODUCTS_URL oder data/products_singles.json).';
      return false;
    }

    index = list;
    byId = new Map(index.map(p => [p.id, p]));
    meta.products = index.length;
    meta.priceGuideDate = priceGuideDate;
    meta.loadedAt = new Date().toISOString();
    meta.error = null;
    loadExpansions();
    byExpName = new Map();
    for (const p of index) {
      const k = `${p.expansionId}|${p.baseWords}`;
      if (!byExpName.has(k)) byExpName.set(k, []);
      byExpName.get(k).push(p);
    }
    if (global.gc) global.gc();
    console.log(`Cardmarket-Index geladen: ${index.length} Produkte (Price Guide ${meta.priceGuideDate})`);
    return true;
  } catch (e) {
    meta.error = e.message;
    console.error('Cardmarket-Dateien laden fehlgeschlagen:', e.message);
    return false;
  }
}

// expansions.json: { "1585": { "name": "...", "tcgdexId": "xy5", "uncertain": false } }
// (ältere Dateien mit reinen Text-Namen funktionieren für die Anzeige weiter,
// aber nicht für den Preisabgleich -> build-expansions.js neu ausführen)
function loadExpansions() {
  expansionNames = {}; setToExpansions = new Map();
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'expansions.json'), 'utf8')); } catch (e) { return; }
  for (const [id, v] of Object.entries(raw)) {
    if (typeof v === 'string') { expansionNames[id] = v; continue; }
    expansionNames[id] = v.name;
    if (v.tcgdexId && !v.uncertain) {
      if (!setToExpansions.has(v.tcgdexId)) setToExpansions.set(v.tcgdexId, []);
      setToExpansions.get(v.tcgdexId).push(Number(id));
    }
  }
}

let readyPromise = null;
function init() {
  readyPromise = refresh();
  setInterval(refresh, REFRESH_MS).unref();
}
// Löst auf, sobald der erste Ladeversuch durch ist (auch bei Fehler -> dann ohne Cardmarket-Daten weiter)
const ready = () => readyPromise || Promise.resolve(false);

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
        trendPriceHolo: holoField(r, 'trend') ?? holoField(r, 'avg') ?? 0,
        avg1Holo: holoField(r, 'avg1') ?? 0, avg7Holo: holoField(r, 'avg7') ?? 0, avg30Holo: holoField(r, 'avg30') ?? 0,
        lowHolo: holoField(r, 'low') ?? 0
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

// ---- Genauer Abgleich TCGdex-Karte <-> Cardmarket-Produkt ----
const hasSet = (tcgdexSetId) => setToExpansions.has(tcgdexSetId);

// Alle Produkte mit diesem englischen Kartennamen in den Cardmarket-Sets,
// die zum TCGdex-Set gehören.
function candidates(tcgdexSetId, englishName) {
  const base = words(String(englishName).split(/\s*[\[(]/)[0]);
  const out = [];
  for (const exp of setToExpansions.get(tcgdexSetId) || []) out.push(...(byExpName.get(`${exp}|${base}`) || []));
  return out;
}

// Mehrere Versionen derselben Karte im Set: über die Angriffsnamen eindeutig machen.
function pickByAttacks(cands, tcgdexAttackNames) {
  const have = new Set((tcgdexAttackNames || []).map(words));
  if (have.size === 0) return null;
  const fit = cands.filter(p => p.attacks.length > 0 && p.attacks.every(a => have.has(a)));
  if (fit.length === 1) return fit[0];
  const exact = fit.filter(p => p.attacks.length === have.size);
  return exact.length === 1 ? exact[0] : null;
}

// Preise der Tagesdatei in die TCGdex-Karte übernehmen. Weicht der Trend stark
// vom bisherigen Wert ab (Faktor > 3), war der Treffer vermutlich falsch -> nichts ändern.
function applyProduct(card, product) {
  const r = product.price;
  if (!r) return card;
  const prices = { ...(card.cardmarket?.prices || {}) };
  const newTrend = r.trend ?? r.avg;
  const oldTrend = prices.trendPrice;
  if (oldTrend > 0 && newTrend > 0 && (newTrend / oldTrend > 3 || newTrend / oldTrend < 1 / 3)) {
    console.warn(`Cardmarket-Abgleich verworfen (Preis-Faktor > 3): ${product.name} alt ${oldTrend} neu ${newTrend}`);
    return card;
  }
  const map = { trendPrice: newTrend, averageSellPrice: r.avg, avg1: r.avg1, avg7: r.avg7, avg30: r.avg30, low: r.low,
    trendPriceHolo: holoField(r, 'trend') ?? holoField(r, 'avg'), avg1Holo: holoField(r, 'avg1'), avg7Holo: holoField(r, 'avg7'),
    avg30Holo: holoField(r, 'avg30'), lowHolo: holoField(r, 'low') };
  for (const [k, v] of Object.entries(map)) if (v != null) prices[k] = v;
  return {
    ...card,
    cardmarket: { ...card.cardmarket, prices, productId: product.id, priceSource: 'cardmarket-daily',
      priceDate: String(meta.priceGuideDate || '').slice(0, 10) }
  };
}

// Vollständiges Karten-Objekt zu einer Cardmarket-Produkt-ID (für "cm-"-Karten)
function cardOfProduct(productId) {
  const p = byId.get(productId);
  return p ? toCard(p) : null;
}

// Aktuelle Preise zu einer Cardmarket-Produkt-ID (für den Preis-Refresh von "cm-"-Karten)
function pricesOfProduct(productId) {
  const p = byId.get(productId);
  if (!p || !p.price) return null;
  return {
    prices: toCard(p).cardmarket.prices,
    productId: p.id,
    priceSource: 'cardmarket-daily',
    priceDate: String(meta.priceGuideDate || '').slice(0, 10)
  };
}

module.exports = { init, ready, refresh, refreshIfStale, search, meta, hasSet, candidates, pickByAttacks, applyProduct, pricesOfProduct, cardOfProduct };
