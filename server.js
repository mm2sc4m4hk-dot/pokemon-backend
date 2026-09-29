const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// --- Datenquelle: TCGdex (https://tcgdex.dev) ---
// Kostenlos, kein API-Key, echte Cardmarket-Preise (EUR) direkt im
// Card-Objekt, Karten nativ in mehreren Sprachen (u.a. Deutsch).
const TCGDEX_BASE = 'https://api.tcgdex.net/v2';

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
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
    const m = last.match(/^([A-Za-z]{0,4})(\d{1,3})(?:\/([A-Za-z]{0,4}\d{1,3}))?$/);
    if (m) {
      return {
        name: tokens.slice(0, -1).join(' '),
        number: {
          prefix: m[1].toUpperCase(),
          digits: String(parseInt(m[2], 10)), // "044" -> "44"
          total: m[3] ? String(parseInt(m[3].replace(/\D/g, ''), 10)) : null
        }
      };
    }
  }
  return { name: tokens.join(' '), number: null };
}

// localId aus TCGdex ("044", "44", "SV044", "TG05") in Prefix + Zahl ohne
// führende Nullen zerlegen, damit "044" und "44" als gleich gelten.
function splitLocalId(localId) {
  const m = String(localId || '').match(/^([A-Za-z]*)(\d+)$/);
  if (!m) return null;
  return { prefix: m[1].toUpperCase(), digits: String(parseInt(m[2], 10)) };
}

function matchesNumber(localId, number) {
  const parts = splitLocalId(localId);
  if (!parts) return false;
  return parts.digits === number.digits && parts.prefix === number.prefix;
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
    set: {
      name: card.set?.name || null,
      total: card.set?.cardCount?.official ?? null
    },
    // Welche Druckvarianten es laut TCGdex gibt, z.B.
    // { normal: true, reverse: true, holo: false, firstEdition: false }
    variants: card.variants || null,
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

  const [deBriefs, enBriefs] = await Promise.all([
    searchBriefs('de', parsed.name, set, numberDigits, perPage),
    searchBriefs('en', parsed.name, set, numberDigits, perPage)
  ]);

  const keep = (b) => !parsed.number || matchesNumber(b.localId, parsed.number);

  const idToLang = new Map();
  deBriefs.filter(keep).forEach(b => idToLang.set(b.id, 'de'));
  enBriefs.filter(keep).forEach(b => { if (!idToLang.has(b.id)) idToLang.set(b.id, 'en'); });
  return idToLang;
}

app.get('/api/cards', async (req, res) => {
  try {
    const { name, set } = req.query;
    if (!name || !name.trim()) {
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

    if (idToLang.size === 0) {
      return res.json([]);
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

    // "Glumanda 044/102": zusätzlich nach der Set-Gesamtzahl filtern, wenn
    // TCGdex sie kennt (Karten ohne Angabe bleiben drin).
    if (parsed.number?.total) {
      results = results.filter(c => c.set.total == null || String(c.set.total) === parsed.number.total);
    }

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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));