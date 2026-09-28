const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// --- Datenquelle: TCGdex (https://tcgdex.dev) ---
// pokemontcg.io ist offiziell deprecated und nimmt keine neuen
// API-Key-Registrierungen mehr an -> wir sind komplett auf TCGdex
// umgestiegen: kostenlos, kein Key nötig, kein hartes Rate-Limit,
// echte Cardmarket-Preise (EUR) direkt im Card-Objekt, und Karten
// liegen nativ in mehreren Sprachen vor (u.a. Deutsch), statt nur
// über einen erfundenen Sprach-Faktor angenähert zu werden.
const TCGDEX_BASE = 'https://api.tcgdex.net/v2';

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Baut aus einem TCGdex-Kartenobjekt (Brief ODER Full) die Form, die
// das Frontend erwartet (images.small/large, set.name, cardmarket.prices...).
function normalizeCard(card, lang) {
  const img = card.image ? `${card.image}/high.webp` : '';
  const imgSmall = card.image ? `${card.image}/low.webp` : '';
  const cm = card.pricing?.cardmarket || {};

  return {
    id: card.id,
    name: card.name,
    images: { small: imgSmall || img, large: img },
    set: { name: card.set?.name || null },
    // TCGdex liefert keinen direkten Link zur Cardmarket-Produktseite
    // (anders als pokemontcg.io) -> wir bauen stattdessen einen
    // funktionierenden Cardmarket-Suchlink, klar als Suche gekennzeichnet.
    cardmarket: {
      url: `https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(
        [card.name, card.set?.name].filter(Boolean).join(' ')
      )}`,
      prices: {
        trendPrice: cm.trend ?? cm.avg ?? 0,
        avg1: cm.avg1 ?? 0,
        avg7: cm.avg7 ?? 0,
        avg30: cm.avg30 ?? 0,
        low: cm.low ?? 0
      }
    },
    _lang: lang
  };
}

// Sucht Karten in einer bestimmten TCGdex-Sprache und liefert nur die
// schlanke Brief-Liste (id, name, image) zurück — schnell, für den
// ersten Abgleich zwischen Sprachen.
async function searchBriefs(lang, name, set) {
  try {
    const params = new URLSearchParams();
    params.set('name', name); // Default = "laxist" Teilstring-Suche
    if (set) params.set('set.name', `like:${set}`);
    params.set('pagination:itemsPerPage', '48');

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

  // Manche (v.a. deutsche) Karten sind zwar textlich übersetzt, aber es
  // wurde noch kein Bild dafür eingescannt/hinterlegt -> in dem Fall auf
  // die englische Version zurückfallen, nur um das Bild zu holen. Name,
  // Set-Name und Preis bleiben aus der ursprünglich gewählten Sprache.
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

app.get('/api/cards', async (req, res) => {
  try {
    const { name, set } = req.query;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name ist erforderlich' });
    }
    const cleanName = name.trim();
    const cleanSet = set ? set.trim() : '';

    // Deutsch UND Englisch parallel durchsuchen. TCGdex hat für Deutsch
    // keine vollständige Abdeckung (ältere/Promo-Sets fehlen teils) —
    // statt bei 0 deutschen Treffern komplett auf Englisch umzuschalten
    // (was wie "Deutsch geht nicht" wirkt), werden beide Ergebnislisten
    // anhand der sprachunabhängigen Karten-ID zusammengeführt: existiert
    // eine Karte auf Deutsch, wird sie deutsch angezeigt; existiert sie
    // nur auf Englisch, wird sie eben englisch angezeigt statt gar nicht.
    const [deBriefs, enBriefs] = await Promise.all([
      searchBriefs('de', cleanName, cleanSet),
      searchBriefs('en', cleanName, cleanSet)
    ]);

    const idToLang = new Map();
    deBriefs.forEach(b => idToLang.set(b.id, 'de'));
    enBriefs.forEach(b => { if (!idToLang.has(b.id)) idToLang.set(b.id, 'en'); });

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
          return null; // einzelne kaputte Karte überspringen statt ganze Suche abbrechen
        }
      })
    );

    const results = detailed.filter(Boolean).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
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