// Täglicher Server-Job für PokéTracker:
//   1. Cardmarket-Dateien neu laden
//   2. alle getrackten Karten sammeln (Collection + Watchlist + Binder aller Nutzer)
//   3. aktuelle Preise holen und in Firestore ablegen:
//        cardPrices/{kartenId}   -> aktueller Preis + Vergleichswerte (vor 1/7/30 Tagen), klein & schnell
//        cardHistory/{kartenId}  -> Verlauf { days: { "2026-10-04": [trend, holoTrend] } }
//   4. Web-Push an alle Nutzer, deren Watchlist-Karte den Zielpreis erreicht hat
//
// Ausgelöst wird der Job von außen (GitHub Actions / cron-job.org), weil der
// Render-Gratisplan schläft: POST /api/cron/daily  mit Header  x-cron-secret.
//
// Umgebungsvariablen (Render -> Environment):
//   FIREBASE_SERVICE_ACCOUNT  Inhalt der Service-Account-JSON (oder base64 davon)
//   CRON_SECRET               beliebiges langes Geheimnis
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT (mailto:du@example.com)
const crypto = require('crypto');
const admin = require('firebase-admin');
const webpush = require('web-push');

const KEEP_DAYS = 400;
const PAST_OFFSETS = [1, 7, 30];

// ---------------------------------------------------------------------
// Kleine Helfer
// ---------------------------------------------------------------------
const trendOf = (p = {}) => p.trendPrice || p.averageSellPrice || 0;
const holoOf = (p = {}) => p.trendPriceHolo || p.avg1Holo || 0;
// gleiche Regel wie watchPrice() in der App (Zielpreis-Alarm)
const watchPrice = (p = {}) => trendOf(p) || holoOf(p);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const eur = (n) => `${(Number(n) || 0).toFixed(2).replace('.', ',')} €`;
const plain = (name) => String(name || '').replace(/\s*\[.*\]\s*$/, '');
const todayUtc = () => new Date().toISOString().slice(0, 10);

function dateMinus(key, n) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Wert, der n Tage vor `dayKey` galt: letzter gespeicherter Tag <= Zieldatum
// (höchstens 4 Tage älter, sonst gibt es noch keinen sinnvollen Vergleichswert).
function pastValue(days, dayKey, n) {
  const target = dateMinus(dayKey, n);
  const floor = dateMinus(target, 4);
  let best = null;
  for (const k of Object.keys(days)) if (k <= target && k >= floor && (best === null || k > best)) best = k;
  return best ? days[best] : null;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------
// Firebase Admin + Web-Push einrichten (beides optional: fehlt die
// Konfiguration, läuft der Rest des Servers ganz normal weiter)
// ---------------------------------------------------------------------
function initFirebase() {
  if (admin.apps?.length) return true;
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return false;
  try {
    raw = raw.trim();
    if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    return true;
  } catch (e) {
    console.error('FIREBASE_SERVICE_ACCOUNT ungültig:', e.message);
    return false;
  }
}

let pushReady = false;
function initPush() {
  const pub = process.env.VAPID_PUBLIC_KEY; const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', pub, priv);
    return true;
  } catch (e) {
    console.error('VAPID-Konfiguration ungültig:', e.message);
    return false;
  }
}

module.exports = function createJobs({ cardmarket, refreshOne, mapLimit }) {
  const firebaseReady = initFirebase();
  pushReady = firebaseReady && initPush();
  console.log(`Jobs: Firebase ${firebaseReady ? 'an' : 'AUS'}, Push ${pushReady ? 'an' : 'AUS'}`);

  let running = false;
  const last = { startedAt: null, finishedAt: null, result: null, error: null };

  // ---- Alle Karten sammeln, die irgendjemand trackt ----
  async function gather(db) {
    const [coll, watch, binders] = await Promise.all([
      db.collectionGroup('collection').select('id').get(),
      db.collectionGroup('watchlist').get(),
      db.collectionGroup('binders').select('slots').get()
    ]);
    const ids = new Set();
    const add = (id) => { if (id && !String(id).startsWith('custom-')) ids.add(String(id)); };
    coll.forEach((d) => add(d.get('id')));
    const watchEntries = [];
    watch.forEach((d) => {
      add(d.id);
      watchEntries.push({ uid: d.ref.parent.parent.id, id: d.id, ref: d.ref, data: d.data() });
    });
    binders.forEach((d) => {
      const slots = d.get('slots') || {};
      Object.values(slots).forEach((s) => add(s && s.id));
    });
    return { ids: [...ids], watchEntries };
  }

  async function readDocs(db, collectionName, ids) {
    const out = new Map();
    for (const part of chunk(ids, 200)) {
      const snaps = await db.getAll(...part.map((id) => db.collection(collectionName).doc(id)));
      snaps.forEach((s) => { if (s.exists) out.set(s.id, s.data()); });
    }
    return out;
  }

  // Frischer Preis: erst direkt über die gemerkte Cardmarket-Produkt-ID (kein TCGdex-Aufruf nötig),
  // sonst über den normalen Abgleich.
  async function resolveFresh(id, known) {
    const pid = (known && known.productId) || (id.startsWith('cm-') ? Number(id.slice(3)) : null);
    if (pid) {
      const r = cardmarket.pricesOfProduct(pid);
      if (r) return r;
    }
    return refreshOne(id, true);
  }

  // ---- Web-Push ----
  async function sendToUser(db, uid, payload) {
    const subsSnap = await db.collection('users').doc(uid).collection('pushSubs').get();
    let sent = 0; let failed = 0;
    await Promise.all(subsSnap.docs.map(async (d) => {
      const s = d.data();
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: s.keys },
          JSON.stringify(payload),
          { TTL: 12 * 60 * 60, urgency: 'normal' }
        );
        sent += 1;
      } catch (e) {
        failed += 1;
        if (e.statusCode === 404 || e.statusCode === 410) await d.ref.delete().catch(() => {}); // Abo ist abgelaufen
        else console.error('Push fehlgeschlagen:', e.statusCode || e.message);
      }
    }));
    return { sent, failed, subs: subsSnap.size };
  }

  async function sendTargetAlerts(db, watchEntries, freshById) {
    const FieldValue = admin.firestore.FieldValue;
    const byUser = new Map();
    const resets = [];
    for (const w of watchEntries) {
      const target = parseFloat(w.data.targetPrice) || 0;
      const fresh = freshById.get(w.id);
      const cur = watchPrice(fresh ? fresh.prices : (w.data.cardmarket && w.data.cardmarket.prices));
      if (!(target > 0) || !(cur > 0)) continue;
      if (cur <= target) {
        // neu erreicht (oder Zielpreis wurde geändert) -> melden; sonst wurde schon gemeldet
        if (w.data.alertedTarget !== target) {
          if (!byUser.has(w.uid)) byUser.set(w.uid, []);
          byUser.get(w.uid).push({ w, name: plain(w.data.name), cur, target });
        }
      } else if (w.data.alertedTarget != null) {
        resets.push(w.ref); // wieder über dem Ziel -> beim nächsten Erreichen erneut benachrichtigen
      }
    }

    let notifiedUsers = 0; let notifiedCards = 0;
    for (const [uid, hits] of byUser) {
      hits.sort((a, b) => (a.cur / a.target) - (b.cur / b.target));
      const one = hits.length === 1;
      const payload = {
        title: one ? '🎯 Zielpreis erreicht' : `🎯 ${hits.length} Karten haben ihren Zielpreis erreicht`,
        body: one
          ? `${hits[0].name}: ${eur(hits[0].cur)} (Ziel ${eur(hits[0].target)})`
          : hits.slice(0, 3).map((h) => `${h.name} ${eur(h.cur)}`).join(' · ') + (hits.length > 3 ? ` · +${hits.length - 3}` : ''),
        url: '/?tab=watchlist',
        tag: 'target-price'
      };
      const res = await sendToUser(db, uid, payload);
      if (res.sent > 0) { // nur als „gemeldet“ markieren, wenn wirklich etwas zugestellt wurde
        notifiedUsers += 1; notifiedCards += hits.length;
        await Promise.all(hits.map((h) => h.w.ref.update({
          alertedTarget: h.target, alertedAt: Date.now(), alertedPrice: h.cur
        }).catch(() => {})));
      }
    }
    await Promise.all(resets.map((ref) => ref.update({ alertedTarget: FieldValue.delete() }).catch(() => {})));
    return { notifiedUsers, notifiedCards };
  }

  // ---- Der eigentliche Job ----
  async function runDaily() {
    if (!firebaseReady) throw new Error('FIREBASE_SERVICE_ACCOUNT fehlt');
    if (running) return { skipped: 'läuft bereits' };
    running = true; last.startedAt = new Date().toISOString(); last.error = null;
    try {
      const db = admin.firestore();
      await cardmarket.refresh(); // Tagesdateien neu laden
      const day = String(cardmarket.meta.priceGuideDate || '').slice(0, 10) || todayUtc();

      const { ids, watchEntries } = await gather(db);
      const [priceDocs, historyDocs] = await Promise.all([
        readDocs(db, 'cardPrices', ids), readDocs(db, 'cardHistory', ids)
      ]);

      const freshById = new Map();
      await mapLimit(ids, 6, async (id) => {
        try {
          const f = await resolveFresh(id, priceDocs.get(id));
          if (f && f.prices && (trendOf(f.prices) || holoOf(f.prices))) freshById.set(id, f);
        } catch (e) { /* einzelne Karte überspringen */ }
      });

      const writer = db.bulkWriter();
      let written = 0;
      for (const [id, f] of freshById) {
        const days = { ...((historyDocs.get(id) || {}).days || {}) };
        days[day] = [r2(trendOf(f.prices)), r2(holoOf(f.prices))];
        const keys = Object.keys(days).sort();
        for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete days[k];

        const past = {};
        for (const n of PAST_OFFSETS) past[String(n)] = pastValue(days, day, n);

        writer.set(db.collection('cardPrices').doc(id), {
          prices: f.prices,
          productId: f.productId || null,
          priceSource: f.priceSource || 'tcgdex',
          priceDate: f.priceDate || null,
          day, past, updatedAt: Date.now()
        });
        writer.set(db.collection('cardHistory').doc(id), { days });
        written += 1;
      }
      await writer.close();

      let alerts = { notifiedUsers: 0, notifiedCards: 0 };
      if (pushReady) alerts = await sendTargetAlerts(db, watchEntries, freshById);

      last.result = { day, tracked: ids.length, priced: freshById.size, written, ...alerts };
      return last.result;
    } catch (e) {
      last.error = e.message;
      throw e;
    } finally {
      running = false; last.finishedAt = new Date().toISOString();
    }
  }

  function registerRoutes(app) {
    // Wird von GitHub Actions / cron-job.org aufgerufen (weckt den Gratis-Server auch auf)
    app.post('/api/cron/daily', async (req, res) => {
      const secret = process.env.CRON_SECRET;
      if (!secret || !safeEqual(req.get('x-cron-secret'), secret)) return res.status(401).json({ error: 'unauthorized' });
      if (req.query.wait) {
        try { res.json({ ok: true, ...(await runDaily()) }); }
        catch (e) { console.error('Daily-Job Fehler:', e); res.status(500).json({ ok: false, error: e.message }); }
        return;
      }
      runDaily().then((r) => console.log('Daily-Job fertig:', JSON.stringify(r))).catch((e) => console.error('Daily-Job Fehler:', e));
      res.status(202).json({ ok: true, started: true });
    });

    app.get('/api/cron/status', (req, res) => {
      const secret = process.env.CRON_SECRET;
      if (!secret || !safeEqual(req.get('x-cron-secret'), secret)) return res.status(401).json({ error: 'unauthorized' });
      res.json({ firebaseReady, pushReady, running, ...last });
    });

    // Test-Push an die eigenen Geräte (Nutzer weist sich mit seinem Firebase-ID-Token aus)
    app.post('/api/push/test', async (req, res) => {
      if (!pushReady) return res.status(503).json({ error: 'Push ist auf dem Server nicht eingerichtet (VAPID-Schlüssel / Service-Account fehlen).' });
      try {
        const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
        const decoded = await admin.auth().verifyIdToken(token);
        const r = await sendToUser(admin.firestore(), decoded.uid, {
          title: '🔔 Push funktioniert', body: 'So meldet dich PokéTracker, wenn ein Zielpreis erreicht ist.', url: '/?tab=watchlist', tag: 'push-test'
        });
        if (r.subs === 0) return res.status(404).json({ error: 'Für dieses Konto ist kein Gerät registriert.' });
        res.json(r);
      } catch (e) {
        res.status(401).json({ error: 'Nicht angemeldet.' });
      }
    });
  }

  return { runDaily, registerRoutes, isReady: () => ({ firebaseReady, pushReady }) };
};
