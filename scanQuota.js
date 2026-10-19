// scanQuota.js – monatliches Scan-Kontingent pro Nutzer (serverseitig).
//
// Zweck: Die KI-Schnittstelle (Gemini/Groq/Mistral/OpenRouter) ist ein teurer
// Fremddienst. Ohne Limit könnte ein einzelnes Konto (oder ein Bot) den Dienst
// leerlaufen lassen. Das Limit wird deshalb ausschließlich SERVERSEITIG
// durchgesetzt – der Client kann es weder umgehen noch manipulieren.
//
// Umsetzung:
//  - Zähler liegt in Firestore unter scanUsage/{uid} (Top-Level-Collection).
//    Firestore-Regeln verbieten Clients jeden Zugriff darauf, nur das Admin
//    SDK (Server) schreibt. Clients lesen ihren Stand nur über GET /api/scan-usage.
//  - Reservierung läuft in einer Firestore-Transaktion: parallel eingehende
//    Scans können das Limit nicht überschreiten.
//  - Monatswechsel setzt den Zähler automatisch zurück (Feld 'month' = YYYY-MM, UTC).
//  - Schlägt der KI-Anbieter fehl, wird die Reservierung wieder zurückgegeben
//    (refund), damit der Nutzer nicht für einen Serverfehler zahlt.
//
// Umgebungsvariablen (optional):
//  SCAN_MONTHLY_LIMIT          Kontingent je Nutzer und Monat (Standard 25)
//  SCAN_GLOBAL_MONTHLY_LIMIT   Kontingent für ALLE Nutzer zusammen (0 = aus)
//  SCAN_REAUTH_MAX_AGE_MIN     maximale Token-Alter für Löschung (Standard 10)

const { db } = require('./firebaseAdmin');

const USER_COLL = 'scanUsage';
const GLOBAL_DOC = 'scanUsageGlobal/global';

const MONTHLY_LIMIT = Math.max(0, Number(process.env.SCAN_MONTHLY_LIMIT) || 25);
const GLOBAL_LIMIT = Math.max(0, Number(process.env.SCAN_GLOBAL_MONTHLY_LIMIT) || 0);

class QuotaExceeded extends Error {
  constructor(scope, info) {
    super(scope === 'global'
      ? 'Unser monatliches Scan-Kontingent ist gerade erschöpft. Bitte später erneut versuchen.'
      : `Dein monatliches Scan-Kontingent (${MONTHLY_LIMIT} Scans) ist aufgebraucht. Es wird zum Monatsende zurückgesetzt.`);
    this.name = 'QuotaExceeded';
    this.scope = scope;
    this.info = info || {};
    this.status = 429;
  }
}

// Aktueller Monat als 'YYYY-MM' (UTC) + Zeitpunkt des Monatsendes
const currentMonth = (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
function nextMonthStart(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}


// Reserveiert einen Scanplatz. Wirft QuotaExceeded, wenn nichts mehr frei ist.
async function reserveScan(uid) {
  const firestore = db();
  if (!firestore) return { ok: true, skipped: true, used: 0, limit: MONTHLY_LIMIT, remaining: MONTHLY_LIMIT };

  const month = currentMonth();
  const userRef = firestore.collection(USER_COLL).doc(uid);
  const globalRef = firestore.collection('scanUsageGlobal').doc('global');
  const useGlobal = GLOBAL_LIMIT > 0;

  return firestore.runTransaction(async (tx) => {
    const reads = [tx.get(userRef)];
    if (useGlobal) reads.push(tx.get(globalRef));
    const [userSnap, globalSnap] = await Promise.all(reads);

    const userData = userSnap.exists ? userSnap.data() : {};
    const used = userData.month === month ? Number(userData.count) || 0 : 0;

    if (used >= MONTHLY_LIMIT) {
      throw new QuotaExceeded('user', { used, limit: MONTHLY_LIMIT, remaining: 0, resetAt: nextMonthStart().toISOString() });
    }

    let globalUsed = null;
    if (useGlobal) {
      const gData = globalSnap.exists ? globalSnap.data() : {};
      globalUsed = gData.month === month ? Number(gData.count) || 0 : 0;
      if (globalUsed >= GLOBAL_LIMIT) {
        throw new QuotaExceeded('global', { used: globalUsed, limit: GLOBAL_LIMIT, remaining: 0, resetAt: nextMonthStart().toISOString() });
      }
    }

    const nextUsed = used + 1;
    tx.set(userRef, { uid, month, count: nextUsed, updatedAt: new Date().toISOString() }, { merge: true });
    if (useGlobal) {
      tx.set(globalRef, { month, count: globalUsed + 1, updatedAt: new Date().toISOString() }, { merge: true });
    }

    return {
      ok: true,
      used: nextUsed,
      limit: MONTHLY_LIMIT,
      remaining: Math.max(0, MONTHLY_LIMIT - nextUsed),
      resetAt: nextMonthStart().toISOString(),
      month
    };
  });
}

// Gibt eine reservierte Einheit zurück (Anbieterfehler / abgebrochener Scan).
async function refundScan(uid) {
  const firestore = db();
  if (!firestore) return;
  const month = currentMonth();
  const userRef = firestore.collection(USER_COLL).doc(uid);
  const globalRef = firestore.collection('scanUsageGlobal').doc('global');
  const useGlobal = GLOBAL_LIMIT > 0;

  try {
    await firestore.runTransaction(async (tx) => {
      const reads = [tx.get(userRef)];
      if (useGlobal) reads.push(tx.get(globalRef));
      const [userSnap, globalSnap] = await Promise.all(reads);

      const userData = userSnap.exists ? userSnap.data() : {};
      if (userData.month === month) {
        const used = Number(userData.count) || 0;
        if (used > 0) {
          tx.set(userRef, { month, count: used - 1, updatedAt: new Date().toISOString() }, { merge: true });
        }
      }

      if (useGlobal) {
        const gData = globalSnap.exists ? globalSnap.data() : {};
        if (gData.month === month) {
          const gUsed = Number(gData.count) || 0;
          if (gUsed > 0) {
            tx.set(globalRef, { month, count: gUsed - 1, updatedAt: new Date().toISOString() }, { merge: true });
          }
        }
      }
    });
  } catch (e) {
    console.error('Scan-Kontingent konnte nicht zurückgegeben werden:', e.message);
  }
}


// Aktueller Stand (für die Anzeige im Profil).
async function getUsage(uid) {
  const firestore = db();
  if (!firestore) return { used: 0, limit: MONTHLY_LIMIT, remaining: MONTHLY_LIMIT, resetAt: nextMonthStart().toISOString() };
  const month = currentMonth();
  const snap = await firestore.collection(USER_COLL).doc(uid).get();
  const data = snap.exists ? snap.data() : {};
  const used = data.month === month ? Number(data.count) || 0 : 0;
  return { used, limit: MONTHLY_LIMIT, remaining: Math.max(0, MONTHLY_LIMIT - used), resetAt: nextMonthStart().toISOString(), month };
}

// Kontingent-Zähler eines Nutzers löschen (Account-Löschung).
async function deleteUsage(uid) {
  const firestore = db();
  if (!firestore) return;
  try {
    await firestore.collection(USER_COLL).doc(uid).delete();
  } catch (e) {
    console.error('Kontingent-Zähler konnte nicht gelöscht werden:', e.message);
  }
}

module.exports = { reserveScan, refundScan, getUsage, deleteUsage, QuotaExceeded, MONTHLY_LIMIT, GLOBAL_LIMIT, currentMonth };
