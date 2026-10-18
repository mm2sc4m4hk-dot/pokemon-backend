// Zentraler Discord-Webhook für Backend-Fehler.
// MAXIMAL eine Meldung pro key alle 10 Minuten (Vermeidung von Spam bei
// wiederholtem Ausfall eines KI-Anbieters oder CSV-Downloads).
const axios = require('axios');

const URL = process.env.DISCORD_WEBHOOK_URL || '';
const COOLDOWN_MS = 10 * 60 * 1000; // 10 Minuten
const cooldowns = new Map(); // key -> lastSent timestamp

async function sendDiscordAlert(key, title, error, extra = '') {
  if (!URL) return;
  const now = Date.now();
  const last = cooldowns.get(key) || 0;
  if (now - last < COOLDOWN_MS) return; // noch im Cooldown

  try {
    await axios.post(URL, {
      content: `🚨 **Backend-Fehler**\n**${title}**\n${extra}\n\`\`\`\n${String(error || 'Unbekannter Fehler').slice(0, 1500)}\n\`\`\``
    }, { timeout: 10000 });
    cooldowns.set(key, now);
  } catch (e) {
    console.error('Discord-Webhook Fehler:', e.message);
  }
}

module.exports = { sendDiscordAlert };