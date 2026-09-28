const express = require('express');
const cors = require('cors');
const app = express();

// Erlaubt Anfragen von allen Domains (inkl. Vercel)
app.use(cors());

const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// CORS-Konfiguration (Erlaubt Anfragen von Vercel und lokal)
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  process.env.FRONTEND_URL
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
      callback(null, true);
    } else {
      callback(new Error('CORS Policy: Zugriff nicht erlaubt.'));
    }
  },
  credentials: true
}));

// Karten-Suche über die freie Pokémon TCG API
app.get('/api/cards', async (req, res) => {
  const { search } = req.query;

  if (!search) {
    return res.status(400).json({ error: 'Suchbegriff fehlt.' });
  }

  try {
    // API-Abfrage an pokemontcg.io
    const response = await axios.get(
      `https://api.pokemontcg.io/v2/cards?q=name:"${encodeURIComponent(search)}*"`,
      {
        headers: {
          // Optional: Falls du auf pokemontcg.io einen kostenlosen Key holst, sonst leer lassen
          'X-Api-Key': process.env.POKEMONTCG_API_KEY || ''
        }
      }
    );

    // Aufbereitung der Daten inklusive Cardmarket-Preisen
    const formattedCards = response.data.data.map(card => ({
      id: card.id,
      name: card.name,
      expansion: card.set?.name || 'Unbekanntes Set',
      image: card.images?.small || '',
      cardmarketUrl: card.cardmarket?.url || '#',
      prices: {
        lowPrice: card.cardmarket?.prices?.lowPrice ? `${card.cardmarket.prices.lowPrice} €` : 'N/A',
        trendPrice: card.cardmarket?.prices?.trendPrice ? `${card.cardmarket.prices.trendPrice} €` : 'N/A',
        avg1: card.cardmarket?.prices?.avg1 ? `${card.cardmarket.prices.avg1} €` : 'N/A',
        avg7: card.cardmarket?.prices?.avg7 ? `${card.cardmarket.prices.avg7} €` : 'N/A',
        avg30: card.cardmarket?.prices?.avg30 ? `${card.cardmarket.prices.avg30} €` : 'N/A'
      }
    }));

    res.json({ status: 'success', data: formattedCards });
  } catch (error) {
    console.error('Fehler bei der API-Abfrage:', error.message);
    res.status(500).json({ error: 'Fehler beim Abrufen der Kartendaten.' });
  }
});

app.get('/', (req, res) => {
  res.send('Pokémon Karten API (über Pokémon TCG API) läuft!');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend läuft auf Port ${PORT}`);
});