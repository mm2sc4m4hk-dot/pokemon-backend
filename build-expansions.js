// Einmal lokal ausführen:  node build-expansions.js [pfad/zu/products_singles.json]
// Erzeugt data/expansions.json ({ "1585": "Primal Clash", ... }), indem die
// Kartennamen jedes Cardmarket-Sets mit den Sets von TCGdex verglichen werden.
// Cardmarkets Dateien enthalten nur Set-NUMMERN, keine Namen.
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const PRODUCTS = process.argv[2] || path.join(__dirname, 'data', 'products_singles.json');
const OUT = path.join(__dirname, 'data', 'expansions.json');
const TCGDEX = 'https://api.tcgdex.net/v2/en';
const MIN_SCORE = 0.5; // darunter wird das Set nicht benannt (lieber ohne Namen als falsch)

const words = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const count = (names) => { const m = new Map(); names.forEach(n => m.set(n, (m.get(n) || 0) + 1)); return m; };

// Multimengen-Jaccard: Überschneidung / Vereinigung
function score(a, b) {
  let inter = 0, sa = 0, sb = 0;
  for (const [k, v] of a) { sa += v; inter += Math.min(v, b.get(k) || 0); }
  for (const v of b.values()) sb += v;
  const union = sa + sb - inter;
  return union ? inter / union : 0;
}

async function pool(items, size, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n]); }
  }));
  return out;
}

async function get(url) {
  for (let t = 0; t < 3; t++) {
    try { return (await axios.get(url, { timeout: 30000 })).data; } catch (e) { if (t === 2) throw e; }
  }
}

async function main() {
  const catalogue = JSON.parse(fs.readFileSync(PRODUCTS, 'utf8'));
  const byExp = new Map();
  for (const p of catalogue.products || []) {
    const base = words(String(p.name).split(/\s*[\[(]/)[0]);
    if (!byExp.has(p.idExpansion)) byExp.set(p.idExpansion, []);
    byExp.get(p.idExpansion).push(base);
  }
  console.log(`${byExp.size} Cardmarket-Sets im Katalog. Lade TCGdex-Sets ...`);

  const sets = await get(`${TCGDEX}/sets`);
  const detailed = await pool(sets, 5, async (s) => {
    try {
      const d = await get(`${TCGDEX}/sets/${s.id}`);
      return { name: d.name, counts: count((d.cards || []).map(c => words(c.name))) };
    } catch (e) { return null; }
  });
  const tcg = detailed.filter(Boolean);
  console.log(`${tcg.length} TCGdex-Sets geladen. Vergleiche ...`);

  const matches = [];
  for (const [id, names] of byExp) {
    const cm = count(names);
    let best = null, bestScore = 0;
    for (const s of tcg) { const sc = score(cm, s.counts); if (sc > bestScore) { bestScore = sc; best = s; } }
    matches.push({ id, name: best && bestScore >= MIN_SCORE ? best.name : null, score: bestScore, cards: names.length });
  }

  // Mehrere Cardmarket-Sets auf denselben Namen (z.B. JP- und EN-Version):
  // nur das beste behält den reinen Namen, die anderen werden markiert.
  const result = {}; const seen = new Map();
  matches.filter(m => m.name).sort((a, b) => b.score - a.score).forEach(m => {
    const n = (seen.get(m.name) || 0); seen.set(m.name, n + 1);
    result[m.id] = n === 0 ? m.name : `${m.name} (Variante ${n + 1}, unsicher)`;
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  const missing = matches.filter(m => !m.name);
  console.log(`Fertig: ${Object.keys(result).length} Sets benannt, ${missing.length} ohne sicheren Treffer.`);
  console.log('Datei:', OUT);
}
main().catch(e => { console.error('Fehler:', e.message); process.exit(1); });
