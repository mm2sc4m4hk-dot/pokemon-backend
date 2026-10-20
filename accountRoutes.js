// accountRoutes.js – Account-Löschung (Art. 17 DSGVO) und Kontingent-Stand.
//
// POST /api/delete-account
//   - verlangt ein gültiges Firebase-ID-Token (requireAuth)
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

  // users/{uid} existiert meist nur als "Phantom-Dokument" (Daten liegen in Untercollections),
  // deshalb NICHT auf snap.exists prüfen – recursiveDelete löscht die Untercollections trotzdem.
  let users = 0;
  try {
    const userRef = firestore.collection('users').doc(uid);
    const subs = await userRef.listCollections();
    await firestore.recursiveDelete(userRef);
    users = subs.length;
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

    // 1) Getippte Bestätigung prüfen
    const typed = String((req.body || {}).confirm || '').trim().toUpperCase();
    if (typed !== CONFIRM_WORD.toUpperCase()) {
      return res.status(400).json({ error: `Zum Löschen bitte "${CONFIRM_WORD}" eintippen.`, code: 'confirm_required' });
    }

    try {
      // 2) Daten löschen (Reihenfolge: erst Daten, dann Login, damit bei einem
      //    Fehler kein halb gelöschter Auth-User zurückbleibt)
      const { users, shares } = await deleteFirestoreData(uid);
      const files = await deleteStoragePrefix(`users/${uid}/`);
      await deleteUsage(uid);

      // 3) Auth-User löschen
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

module.exports = { registerAccountRoutes };

