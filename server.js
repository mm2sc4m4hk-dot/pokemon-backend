const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const translationCache = {};

async function getEnglishName(inputName) {
  const clean = inputName.trim().toLowerCase();
  if (translationCache[clean]) return translationCache[clean];

  try {
    const res = await axios.get(`https://pokeapi.co/api/v2/pokemon-species/${clean}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const englishEntry = res.data.names.find(n => n.language.name === 'en');
    const englishName = englishEntry ? englishEntry.name : clean;
    translationCache[clean] = englishName;
    return englishName;
  } catch (err) {
    return clean;
  }
}

app.get('/api/cards', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'Name ist erforderlich' });

    const searchName = await getEnglishName(name);

    // Anfrage mit User-Agent Header, um Cloudflare-Blockaden zu umgehen
    const response = await axios.get(`https://api.pokemontcg.io/v2/cards?q=name:"${searchName}*"`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    res.json(response.data.data || []);
  } catch (error) {
    console.error('API Error:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Fehler beim Abrufen der Karten' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
