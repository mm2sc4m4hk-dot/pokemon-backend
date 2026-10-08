// scanProviders.js – Kartenscan mit mehreren kostenlosen KI-Anbietern.
//
// Ablauf: Anbieter 1 startet sofort. Antwortet er nicht innerhalb von HEDGE_MS (oder fällt aus),
// startet Anbieter 2 PARALLEL dazu usw. Die erste gültige Antwort gewinnt, der Rest wird abgebrochen.
// Anbieter, die gerade überlastet sind (429/5xx/Timeout), werden für eine Weile übersprungen.
//
// Render -> Environment (nur die setzen, die du hast; mindestens einer nötig):
//   GROQ_API_KEY        https://console.groq.com        (sehr schnell, großzügig kostenlos)
//   GEMINI_API_KEY      (hast du schon)
//   MISTRAL_API_KEY     https://console.mistral.ai      (Plan "Experiment" ist kostenlos)
//   OPENROUTER_API_KEY  https://openrouter.ai           (":free"-Modelle)
// Optional:
//   SCAN_PROVIDERS=groq,gemini,mistral,openrouter   (Reihenfolge)
//   GROQ_MODEL, GEMINI_MODELS (kommagetrennt), MISTRAL_MODEL, OPENROUTER_MODEL
//   SCAN_HEDGE_MS=3500, SCAN_TIMEOUT_MS=15000
//
// Modellnamen ändern sich bei den Anbietern öfter – bei Fehler 404/400 in den Render-Logs
// den Namen in der Doku des Anbieters prüfen und per Umgebungsvariable überschreiben.

const { GoogleGenAI } = require('@google/genai');

const HEDGE_MS = Number(process.env.SCAN_HEDGE_MS) || 3500;
const TIMEOUT_MS = Number(process.env.SCAN_TIMEOUT_MS) || 15000;

const cold = new Map(); // Anbietername -> Zeitpunkt, bis zu dem er übersprungen wird
const isCold = (name) => (cold.get(name) || 0) > Date.now();
const setCold = (name, ms) => cold.set(name, Date.now() + ms);

// ---------- JSON aus Modellantwort holen ----------
function parseJson(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error('Keine JSON-Antwort');
  let obj = JSON.parse(t.slice(a, b + 1));
  if (Array.isArray(obj)) obj = obj[0] || {};
  return obj;
}

const valid = (o) => !!(o && (String(o.name || '').trim() || String(o.number || '').trim()));

// ---------- Anbieter ----------
function geminiProviders() {
  if (!process.env.GEMINI_API_KEY) return [];
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const models = String(process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || 'gemini-3.8-flash')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return models.map((model) => ({
    name: `gemini:${model}`,
    group: 'gemini',
    async call(b64, prompt, signal) {
      const contents = [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: 'image/jpeg', data: b64 } }] }];
      const base = { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 300, abortSignal: signal };
      try {
        const r = await ai.models.generateContent({ model, contents, config: { ...base, thinkingConfig: { thinkingBudget: 0 } } });
        return parseJson(r.text);
      } catch (e) {
        // Manche Modelle lehnen thinkingBudget ab (HTTP 400) -> einmal ohne bzw. mit thinkingLevel versuchen
        if (Number(e?.status ?? e?.code) !== 400) throw e;
        const r = await ai.models.generateContent({ model, contents, config: { ...base, thinkingConfig: { thinkingLevel: 'minimal' } } });
        return parseJson(r.text);
      }
    }
  }));
}

function openAiCompat({ group, url, key, model, jsonMode = true }) {
  if (!key) return [];
  return [{
    name: `${group}:${model}`,
    group,
    async call(b64, prompt, signal) {
      const body = {
        model,
        temperature: 0,
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }
          ]
        }]
      };
      if (jsonMode) body.response_format = { type: 'json_object' };
      const res = await fetch(url, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const err = new Error(`${group} HTTP ${res.status}`);
        err.status = res.status;
        err.retryAfter = Number(res.headers.get('retry-after')) || 0;
        throw err;
      }
      const data = await res.json();
      return parseJson(data?.choices?.[0]?.message?.content);
    }
  }];
}

function buildProviders() {
  const all = {
    groq: () => openAiCompat({
      group: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY,
      model: process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct'
    }),
    gemini: geminiProviders,
    mistral: () => openAiCompat({
      group: 'mistral', url: 'https://api.mistral.ai/v1/chat/completions', key: process.env.MISTRAL_API_KEY,
      model: process.env.MISTRAL_MODEL || 'mistral-small-latest'
    }),
    openrouter: () => openAiCompat({
      group: 'openrouter', url: 'https://openrouter.ai/api/v1/chat/completions', key: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL || 'google/gemma-3-27b-it:free', jsonMode: false
    })
  };
  const order = String(process.env.SCAN_PROVIDERS || 'groq,gemini,mistral,openrouter').split(',').map((s) => s.trim());
  return order.flatMap((k) => (all[k] ? all[k]() : []));
}

const providers = buildProviders();
console.log('Scan-Anbieter:', providers.map((p) => p.name).join(', ') || 'KEINE (bitte API-Keys setzen)');

// ---------- Hauptfunktion ----------
async function scanCard(base64Data, prompt) {
  if (providers.length === 0) throw new Error('Kein Scan-Anbieter konfiguriert (GROQ_API_KEY / GEMINI_API_KEY / ...).');

  let list = providers.filter((p) => !isCold(p.name));
  if (list.length === 0) list = providers; // alle "kalt" -> trotzdem alle probieren

  return new Promise((resolve, reject) => {
    let started = 0; let pending = 0; let done = false; let hedge = null;
    const controllers = [];
    const errors = [];

    const finish = (fn, val) => {
      if (done) return;
      done = true;
      clearTimeout(hedge);
      controllers.forEach((c) => c.abort());
      fn(val);
    };

    const startNext = () => {
      if (done || started >= list.length) return;
      clearTimeout(hedge);
      const p = list[started]; started += 1; pending += 1;

      const ctrl = new AbortController();
      controllers.push(ctrl);
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const t0 = Date.now();

      p.call(base64Data, prompt, ctrl.signal)
        .then((obj) => {
          if (!valid(obj)) throw new Error('leere Antwort');
          console.log(`Scan OK über ${p.name} in ${Date.now() - t0} ms`);
          finish(resolve, { ...obj, _provider: p.name });
        })
        .catch((e) => {
          if (done) return; // wurde absichtlich abgebrochen, weil ein anderer schon gewonnen hat
          const status = Number(e?.status ?? e?.code);
          const busy = [429, 500, 502, 503, 504].includes(status) || e?.name === 'AbortError' || /overload|high demand|unavailable|quota/i.test(String(e?.message));
          if (busy) setCold(p.name, (e.retryAfter || 60) * 1000);
          else if ([400, 401, 403, 404].includes(status)) setCold(p.name, 10 * 60 * 1000); // vermutlich Konfigurationsfehler
          errors.push({ name: p.name, busy, msg: e?.message });
          console.warn(`Scan-Anbieter ${p.name} fehlgeschlagen (${e?.message || e}) nach ${Date.now() - t0} ms`);
        })
        .finally(() => {
          clearTimeout(timer);
          pending -= 1;
          if (done) return;
          if (started < list.length) startNext();
          else if (pending === 0) {
            const err = new Error('Alle Scan-Anbieter sind gerade nicht erreichbar.');
            err.geminiBusy = errors.every((x) => x.busy) || errors.length > 0; // -> HTTP 503 im bestehenden catch
            err.details = errors;
            finish(reject, err);
          }
        });

      if (started < list.length) hedge = setTimeout(startNext, HEDGE_MS);
    };

    startNext();
  });
}

module.exports = { scanCard, providerNames: () => providers.map((p) => p.name) };
