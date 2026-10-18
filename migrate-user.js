// Einmal-Skript: kopiert alle Daten eines Kontos (users/{alteUid}/...) in ein anderes Konto (users/{neueUid}/...).
// Nötig nur, wenn du bereits ein ZWEITES Konto angelegt hast (z. B. per Google-Anmeldung ohne Verknüpfung).
// Wenn du dein altes Konto im Profil mit "Konto sichern" umstellst, brauchst du dieses Skript nicht.
//
// Aufruf (im Backend-Ordner, Node 22):
//   Probelauf (schreibt nichts):
//     node migrate-user.js ALTE_UID NEUE_UID --key=pfad/zum/serviceAccount.json
//   Wirklich kopieren:
//     node migrate-user.js ALTE_UID NEUE_UID --key=pfad/zum/serviceAccount.json --run
//
// Statt --key kannst du die Umgebungsvariable FIREBASE_SERVICE_ACCOUNT setzen (JSON oder Base64, wie auf Render).
// Optionen:
//   --run          wirklich schreiben (ohne diese Option nur zählen)
//   --force        auch kopieren, wenn das Ziel-Konto schon Daten hat (gleiche Dokument-IDs werden überschrieben)
//   --with-push    Push-Abos mitkopieren (Standard: nicht kopieren, Push einfach in der App neu einschalten)
//
// Das alte Konto und seine Daten werden NICHT gelöscht.
const fs = require('fs');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const [oldUid, newUid] = args.filter((a) => !a.startsWith('--'));
const flag = (name) => flags.includes(`--${name}`);
const keyPath = (flags.find((f) => f.startsWith('--key=')) || '').slice(6);
const RUN = flag('run');
const SKIP = flag('with-push') ? new Set() : new Set(['pushSubs']);

function loadCredentials() {
  let raw = keyPath ? fs.readFileSync(keyPath, 'utf8') : process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Kein Service-Account: --key=pfad/zur/datei.json angeben oder FIREBASE_SERVICE_ACCOUNT setzen.');
  raw = raw.trim();
  if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(raw);
}

async function main() {
  if (!oldUid || !newUid || oldUid === newUid) {
    console.error('Aufruf: node migrate-user.js ALTE_UID NEUE_UID --key=serviceAccount.json [--run] [--force] [--with-push]');
    process.exit(1);
  }
  initializeApp({ credential: cert(loadCredentials()) });
  const db = getFirestore();
  const auth = getAuth();

  // Beide Konten müssen in Firebase Authentication existieren (schützt vor Tippfehlern bei der UID)
  const [oldUser, newUser] = await Promise.all([
    auth.getUser(oldUid).catch(() => null),
    auth.getUser(newUid).catch(() => null)
  ]);
  if (!oldUser) throw new Error(`Alte UID nicht gefunden: ${oldUid}`);
  if (!newUser) throw new Error(`Neue UID nicht gefunden: ${newUid}`);
  console.log(`Von:  ${oldUser.email || oldUser.uid}  (${oldUid})`);
  console.log(`Nach: ${newUser.email || newUser.uid}  (${newUid})`);

  const srcRoot = db.collection('users').doc(oldUid);
  const dstRoot = db.collection('users').doc(newUid);

  const existing = (await dstRoot.listCollections()).filter((c) => !SKIP.has(c.id));
  if (existing.length > 0 && !flag('force')) {
    throw new Error(`Das Ziel-Konto hat schon Daten (${existing.map((c) => c.id).join(', ')}). Mit --force trotzdem kopieren (gleiche Dokument-IDs werden überschrieben).`);
  }

  const writer = db.bulkWriter();
  writer.onWriteError((err) => {
    if (err.failedAttempts < 5) return true;
    console.error('Schreiben endgültig fehlgeschlagen:', err.documentRef.path, err.message);
    return false;
  });
  const counts = {};

  // Kopiert ein Dokument samt aller Unter-Sammlungen (listDocuments findet auch Dokumente ohne eigene Daten)
  async function copyTree(src, dst, depth) {
    const snap = await src.get();
    if (snap.exists) {
      if (RUN) writer.set(dst, snap.data());
      const key = src.parent.id;
      counts[key] = (counts[key] || 0) + 1;
    }
    for (const sub of await src.listCollections()) {
      if (depth === 0 && SKIP.has(sub.id)) { console.log(`  übersprungen: ${sub.id}`); continue; }
      for (const d of await sub.listDocuments()) {
        await copyTree(d, dst.collection(sub.id).doc(d.id), depth + 1);
      }
    }
  }

  console.log(RUN ? '\nKopiere …' : '\nProbelauf (es wird nichts geschrieben) …');
  await copyTree(srcRoot, dstRoot, 0);

  // Freigabe-Links (shares/{token}) zeigen über das Feld "uid" auf den Besitzer
  const shares = await db.collection('shares').where('uid', '==', oldUid).get();
  shares.forEach((d) => { if (RUN) writer.update(d.ref, { uid: newUid }); });
  if (shares.size) counts['shares (Besitzer umgestellt)'] = shares.size;

  await writer.close();

  console.log('\nDokumente pro Sammlung:');
  Object.entries(counts).sort().forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  console.log(RUN
    ? '\nFertig. Melde dich mit dem neuen Konto an und prüfe Collection, Watchlist, Binder und Verkäufe. Das alte Konto bleibt unverändert bestehen.'
    : '\nProbelauf beendet. Zum echten Kopieren denselben Befehl mit --run wiederholen.');
}

main().catch((e) => { console.error('Fehler:', e.message); process.exit(1); });
