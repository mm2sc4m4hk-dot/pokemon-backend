// accountRoutes.js – Account-Löschung (Art. 17 DSGVO) und Kontingent-Stand.
//
// POST /api/delete-account
//   - verlangt ein gültiges Firebase-ID-Token (requireAuth)
//   - verlangt eine frische Anmeldung: der auth_time-Claim des Tokens darf
//     höchstens SCAN_REAUTH_MAX_AGE_MIN (Standard 10) Minuten alt sein.
//     Der Client holt davor per reauthenticateWithCredential /
//     reauthenticateWithPopup einen neuen Token (getIdToken(true)).
//   - verlangt die getippte Bestätigung "LÖSCHEN" im Body
//   - löscht danach serverseitig: alle Firestore-Daten des Kontos
//     (users/{uid} inkl. aller Untercollectionen), die Share-Links des Kontos
//     (shares/{id} inkl. parts), Dateien im Storage-Pfad users/{uid}/,
//     den Kontingent-Zähler und finally den Auth-User selbst.
//
// GET /api/scan-usage
//   - Kontingent-Stand des eingeloggten Nutzers (für die Anzeige im Profil)

const express = require('express');
const { requireAuth } = require('./authMiddleware');
const { db, auth } = require('./firebaseAdmin');
const { getUsage, deleteUsage } = require('./scanQuota');

const REAUTH_MAX_AGE_MIN = Math.max(1, Number(process.env.SCAN_REAUTH_MAX_AGE_MIN) || 10);
const CONFIRM_WORD = 'LÖSCHEN';

// Storage wird nur benutzt, wenn im Admin-SDK ein Bucket konfiguriert ist.
let storage = null;
try {
  storage = require('firebase-admin/storage');
} catch (e) { /* Storage-Modul nicht verfügbar -> Dateilöschung wird übersprungen */ }


// Alle Dateien unter einem Storage-Pfad löschen (falls Storage genutzt wird).
async function deleteStoragePrefix(prefix) {
  if (!storage) return 0;
  try {
    const bucket = storage.getStorage().bucket();
    const [files] = await bucket.getFiles({ prefix });
    let n = 0;
    for (const file of files) {
      await file.delete();
      n += 1;
    }
    return n;
  } catch (e) {
    console.error('Storage-Pfad konnte nicht gelöscht werden:', e.message);
    return 0;
  }
}

// Alle Firestore-Daten des Kontos löschen:
//  - users/{uid} samt Untercollectionen (collection, watchlist, snapshots, sales, binders, binderPhotos, pushSubs …)
//  - shares/{id} des Kontos samt parts-Untercollection
async function deleteFirestoreData(uid) {
  const firestore = db();
  if (!firestore) return { users: 0, shares: 0 };

  let users = 0;
  try {
    const userRef = firestore.collection('users').doc(uid);
    const snap = await userRef.get();
    if (snap.exists) {
      await firestore.recursiveDelete(userRef);
      users = 1;
    }
  } catch (e) {
    console.error('Nutzerdaten konnten nicht gelöscht werden:', e.message);
    throw e;
  }

  let shares = 0;
  try {
    const shareSnaps = await firestore.collection('shares').where('uid', '==', uid).get();
    for (const doc of shareSnaps.docs) {
      await firestore.recursiveDelete(doc.ref);
      shares += 1;
    }
  } catch (e) {
    console.error('Share-Links konnten nicht gelöscht werden:', e.message);
    throw e;
  }

  return { users, shares };
}

// Prüft, ob der Nutzer gerade frisch angemeldet (re-authentifiziert) wurde.
//
// Zwei serverseitig verifizierbare Signale werden akzeptiert:
//  1. auth_time des ID-Tokens: Zeitpunkt der Anmeldung. Firebase setzt diesen
//     Wert bei einer echten Re-Anmeldung (reauthenticateWithCredential /
//     reauthenticateWithPopup) neu – ein bloßes Token-Refresh lässt ihn
//     unverändert.
//  2. metadata.lastLoginTime des Auth-Users (nur über das Admin-SDK lesbar):
//     der Zeitpunkt des letzten erfolgreichen Sign-ins.
//
// Beide Werte kann der Client nicht fälschen – deshalb ist die Prüfung
// auch dann sicher, wenn ein Anbieter auth_time bei der Re-Auth nicht
// auffrischt.
async function hasRecentAuth(uid, decodedToken) {
  const maxAgeMs = REAUTH_MAX_AGE_MIN * 60 * 1000;
  const now = Date.now();

  const authTime = Number(decodedToken?.auth_time) * 1000;
  if (authTime && now - authTime <= maxAgeMs && now - authTime >= -60 * 1000) return true;

  try {
    const adminAuth = auth();
    if (!adminAuth) return false;
    const user = await adminAuth.getUser(uid);
    const last = user?.metadata?.lastLoginTime;
    const t = last ? new Date(last).getTime() : 0;
    if (t && now - t <= maxAgeMs && now - t >= -60 * 1000) return true;
  } catch (e) {
    console.error('Letzte Anmeldung konnte nicht geprüft werden:', e.message);
  }
  return false;
}

// Registriert die Routen (wird aus server.js aufgerufen).
function registerAccountRoutes(app) {
  // Kontingent-Stand (für die Anzeige im Profil)
  app.get('/api/scan-usage', requireAuth, async (req, res) => {
    try {
      const usage = await getUsage(req.user.uid);
      res.json(usage);
    } catch (e) {
      console.error('Kontingent-Stand konnte nicht geladen werden:', e.message);
      res.status(500).json({ error: 'Kontingent konnte nicht geladen werden.' });
    }
  });

  // Account löschen
  app.post('/api/delete-account', requireAuth, async (req, res) => {
    const uid = req.user.uid;

    // 1) Frische Anmeldung verlangen (auth_time bzw. letzter Sign-in)
    if (!(await hasRecentAuth(uid, req.user))) {
      return res.status(401).json({
        error: `Bitte melde dich zur Sicherheit neu an (innerhalb der letzten ${REAUTH_MAX_AGE_MIN} Minuten) und versuche es dann erneut.`,
        code: 'reauth_required'
      });
    }

    // 2) Getippte Bestätigung prüfen
    const typed = String((req.body || {}).confirm || '').trim().toUpperCase();
    if (typed !== CONFIRM_WORD.toUpperCase()) {
      return res.status(400).json({ error: `Zum Löschen bitte "${CONFIRM_WORD}" eintippen.`, code: 'confirm_required' });
    }

    try {
      // 3) Daten löschen (Reihenfolge: erst Daten, dann Login, damit bei einem
      //    Fehler kein halb gelöschter Auth-User zurückbleibt)
      const { users, shares } = await deleteFirestoreData(uid);
      const files = await deleteStoragePrefix(`users/${uid}/`);
      await deleteUsage(uid);

      // 4) Auth-User löschen
      const adminAuth = auth();
      if (!adminAuth) throw new Error('Firebase Auth ist nicht konfiguriert.');
      await adminAuth.deleteUser(uid);

      console.log(`Account gelöscht: ${uid} (users=${users}, shares=${shares}, files=${files})`);
      res.json({ ok: true, deleted: { users, shares, files } });
    } catch (e) {
      console.error('Account-Löschung fehlgeschlagen:', e);
      res.status(500).json({ error: 'Das Konto konnte nicht vollständig gelöscht werden. Bitte später erneut versuchen oder per E-Mail melden.' });
    }
  });
}

module.exports = { registerAccountRoutes, REAUTH_MAX_AGE_MIN };

