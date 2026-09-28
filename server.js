const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// In-Memory Cache für Übersetzungen (beschleunigt wiederholte Suchen)
const translationCache = {};

// Übersetzt deutsche Pokémon-Namen automatisch via PokeAPI ins Englische
async function getEnglishName(inputName) {
  const clean = inputName.trim().toLowerCase();
  if (translationCache[clean]) return translationCache[clean];

  try {
    const res = await axios.get(`https://pokeapi.co/api/v2/pokemon-species/${clean}`);
    const englishEntry = res.data.names.find(n => n.language.name === 'en');
    const englishName = englishEntry ? englishEntry.name : clean;
    
    translationCache[clean] = englishName;
    return englishName;
  } catch (err) {
    // Falls der Name bereits englisch ist oder nicht in PokeAPI gefunden wird
    return clean;
  }
}

app.get('/api/cards', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) {
      return res.status(400).json({ error: 'Name ist erforderlich' });
    }

    const searchName = await getEnglishName(name);
    const response = await axios.get(`https://api.pokemontcg.io/v2/cards?q=name:"${searchName}*"`);

    res.json(response.data.data);
  } catch (error) {
    console.error('API Error:', error.message);
    res.status(500).json({ error: 'Fehler beim Abrufen der Karten' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));