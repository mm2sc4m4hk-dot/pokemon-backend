// scanProviders.js – Kartenscan mit mehreren kostenlosen KI-Anbietern.
//
// Ablauf: Anbieter 1 startet sofort. Antwortet er nicht innerhalb von HEDGE_MS (oder fällt aus),
// startet Anbieter 2 PARALLEL dazu usw. Die erste gültige Antwort gewinnt, der Rest wird abgebrochen.
// Anbieter, die gerade überlastet sind (429/5xx/Timeout), werden für eine Weile übersprungen.
//
// Render -> Environment (nur die setzen, die du hast; mindestens einer nötig):
//   GROQ_API_KEY, GEMINI_API_KEY, MISTRAL_API_KEY, OPENROUTER_API_KEY
// Optional:
//   SCAN_PROVIDERS=groq,gemini,mistral,openrouter   (Reihenfolge)
//   GROQ_MODEL, GEMINI_MODELS (kommagetrennt), MISTRAL_MODEL, OPENROUTER_MODEL
//   SCAN_HEDGE_MS=3500, SCAN_TIMEOUT_MS=15000
//
// NEU: Groq und OpenRouter suchen sich bei "404 Modell nicht gefunden" automatisch ein
// passendes Vision-Modell aus der Modellliste des Anbieters und merken es sich.

const { GoogleGenAI } = require('@google/genai');

const HEDGE_MS = Number(process.env.SCAN_HEDGE_MS) || 3500;
const TIMEOUT_MS = Number(process.env.SCAN_TIMEOUT_MS) || 15000;

const cold = new Map();
const isCold = (name) => (cold.get(name) || 0) > Date.now();
const setCold = (name, ms) => cold.set(name, Date.now() + ms);

// ---------- JSON aus Modellantwort holen ----------
function parseJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error('Keine JSON-Antwort');
  let obj = JSON.parse(t.slice(a, b + 1));
  if (Array.isArray(obj)) obj = obj[0] || {};
  return obj;
}

const valid = (o) => !!(o && (String(o.name || '').trim() || String(o.number || '').trim()));

// Text aus einer Gemini-Antwort holen (r.text kann bei Thinking-Modellen leer sein)
function geminiText(r) {
  if (r && r.text) return r.text;
  const parts = r?.candidates?.[0]?.content?.parts || [];
  return parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
}

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
      // 1024 statt 300: bei Thinking-Modellen zählen Denk-Tokens mit, sonst bleibt der Text leer
      const base = { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 1024, abortSignal: signal };
      const run = async (thinkingConfig) => {
        const r = await ai.models.generateContent({ model, contents, config: { ...base, thinkingConfig } });
        const text = geminiText(r);
        if (!text) {
          const reason = r?.candidates?.[0]?.finishReason || 'unbekannt';
          const block = r?.promptFeedback?.blockReason ? ` / blockiert: ${r.promptFeedback.blockReason}` : '';
          console.warn(`Gemini leer (${model}): finishReason=${reason}${block}`);
          throw new Error(`Leere Gemini-Antwort (${reason}${block})`);
        }
        return parseJson(text);
      };
      try {
        return await run({ thinkingBudget: 0 });
      } catch (e) {
        // Manche Modelle lehnen thinkingBudget ab (HTTP 400) -> mit thinkingLevel versuchen
        if (Number(e?.status ?? e?.code) !== 400) throw e;
        return run({ thinkingLevel: 'minimal' });
      }
    }
  }));
}

// Modellliste des Anbieters abfragen und passende Vision-Kandidaten zurückgeben
async function discoverGroq(key, signal) {
  const res = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data || []).map((m) => m.id)
    .filter((id) => /llama-4|vision|scout|maverick|pixtral|qwen.*vl|gemma/i.test(id) && !/guard|whisper|tts|prompt-guard|safeguard/i.test(id));
}

async function discoverOpenRouter(key, signal) {
  const res = await fetch('https://openrouter.ai/api/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data || [])
    .filter((m) => (m.architecture?.input_modalities || []).includes('image') && (String(m.id).endsWith(':free') || Number(m.pricing?.prompt) === 0))
    .map((m) => m.id);
}

function openAiCompat({ group, url, key, model, jsonMode = true, discover }) {
  if (!key) return [];
  const state = { current: model, discovered: null, tried: new Set() };

  async function request(m, b64, prompt, signal) {
    const body = {
      model: m,
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
      const err = new Error(`${group} HTTP ${res.status} (${m})`);
      err.status = res.status;
      err.retryAfter = Number(res.headers.get('retry-after')) || 0;
      throw err;
    }
    const data = await res.json();
    return parseJson(data?.choices?.[0]?.message?.content);
  }

  return [{
    get name() { return `${group}:${state.current}`; },
    group,
    async call(b64, prompt, signal) {
      try {
        return await request(state.current, b64, prompt, signal);
      } catch (e) {
        // Modell unbekannt -> Modellliste holen und Kandidaten der Reihe nach probieren
        if (!discover || ![400, 404].includes(e.status)) throw e;
        state.tried.add(state.current);
        if (!state.discovered) {
          try { state.discovered = await discover(key, signal); } catch (err) { state.discovered = []; }
          console.log(`${group}: Modellsuche, Kandidaten:`, state.discovered.slice(0, 8).join(', ') || 'keine');
        }
        let last = e;
        for (const cand of state.discovered) {
          if (state.tried.has(cand)) continue;
          state.tried.add(cand);
          try {
            const r = await request(cand, b64, prompt, signal);
            console.log(`${group}: verwende ab jetzt Modell ${cand}`);
            state.current = cand;
            return r;
          } catch (err) {
            last = err;
            if (![400, 404].includes(err.status)) throw err; // 429/5xx etc. -> normal behandeln
          }
        }
        throw last;
      }
    }
  }];
}

function buildProviders() {
  const all = {
    groq: () => openAiCompat({
      group: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY,
      model: process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
      discover: discoverGroq
    }),
    gemini: geminiProviders,
    mistral: () => openAiCompat({
      group: 'mistral', url: 'https://api.mistral.ai/v1/chat/completions', key: process.env.MISTRAL_API_KEY,
      model: process.env.MISTRAL_MODEL || 'mistral-small-latest'
    }),
    openrouter: () => openAiCompat({
      group: 'openrouter', url: 'https://openrouter.ai/api/v1/chat/completions', key: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL || 'google/gemma-3-27b-it:free', jsonMode: false,
      discover: discoverOpenRouter
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
  if (list.length === 0) list = providers;

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
          if (done) return;
          const status = Number(e?.status ?? e?.code);
          const busy = [429, 500, 502, 503, 504].includes(status) || e?.name === 'AbortError' || /overload|high demand|unavailable|quota/i.test(String(e?.message));
          if (busy) setCold(p.name, (e.retryAfter || 60) * 1000);
          else if ([400, 401, 403, 404].includes(status)) setCold(p.name, 10 * 60 * 1000);
          else setCold(p.name, 30 * 1000); // z. B. leere Antwort: kurz aussetzen
          errors.push({ name: p.name, busy, msg: e?.message });
          console.warn(`Scan-Anbieter ${p.name} fehlgeschlagen (${e?.message || e}) nach ${Date.now() - t0} ms`);
        })
        .finally(() => {
          clearTimeout(timer);
          pending -= 1;
          if (done) return;
          if (started < list.length) startNext();
          else if (pending === 0) {
            const err = new Error('Alle Scan-Anbieter sind fehlgeschlagen: ' + errors.map((x) => `${x.name} (${x.msg})`).join('; '));
            err.geminiBusy = errors.some((x) => x.busy); // nur echte Überlast -> HTTP 503, sonst 500 mit Klartext
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
