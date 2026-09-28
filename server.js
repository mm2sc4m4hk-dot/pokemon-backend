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

// Sucht Karten in einer bestimmten TCGdex-Sprache (Brief-Liste), holt
// danach pro Treffer parallel die Detailansicht (für Set-Name + echte
// Cardmarket-Preise, die in der Brief-Liste nicht enthalten sind).
async function searchInLang(lang, name, set) {
  const params = new URLSearchParams();
  params.set('name', name); // Default = "laxist" Teilstring-Suche
  if (set) params.set('set.name', `like:${set}`);
  params.set('pagination:itemsPerPage', '24');

  const listRes = await axios.get(`${TCGDEX_BASE}/${lang}/cards?${params.toString()}`, { timeout: 10000 });
  const briefs = Array.isArray(listRes.data) ? listRes.data : [];
  if (briefs.length === 0) return [];

  const detailed = await Promise.all(
    briefs.map(async (brief) => {
      try {
        const detailRes = await axios.get(`${TCGDEX_BASE}/${lang}/cards/${brief.id}`, { timeout: 10000 });
        return normalizeCard(detailRes.data, lang);
      } catch (e) {
        // Wenn die Detailanfrage fehlschlägt, lieber die Karte ohne
        // Preis/Set zeigen als sie ganz wegzulassen.
        return normalizeCard(brief, lang);
      }
    })
  );
  return detailed;
}

app.get('/api/cards', async (req, res) => {
  try {
    const { name, set } = req.query;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name ist erforderlich' });
    }
    const cleanName = name.trim();
    const cleanSet = set ? set.trim() : '';

    // Erst auf Deutsch suchen (passend zur App), bei 0 Treffern auf
    // Englisch zurückfallen (breiteste Set-Abdeckung, u.a. ältere/
    // Promo-Sets, die nicht immer deutsch vorliegen).
    let results = await searchInLang('de', cleanName, cleanSet);
    if (results.length === 0) {
      results = await searchInLang('en', cleanName, cleanSet);
    }

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
