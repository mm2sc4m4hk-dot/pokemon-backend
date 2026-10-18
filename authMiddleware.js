// Express-Middleware: lässt nur Anfragen mit gültigem Firebase-Login durch.
//
// Erwartet den Header   Authorization: Bearer <Firebase-ID-Token>
// (in der App: await auth.currentUser.getIdToken()).
// Bei Erfolg steht das geprüfte Token in req.user (u. a. req.user.uid, req.user.email).
//
// Nutzt dieselbe Umgebungsvariable wie jobs.js: FIREBASE_SERVICE_ACCOUNT (JSON oder Base64).
// Ist sie nicht gesetzt, wird abgelehnt (fail closed) – die Route bleibt nie versehentlich offen.
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

function ensureFirebase() {
  if (getApps().length) return true;
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return false;
  try {
    raw = raw.trim();
    if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
    initializeApp({ credential: cert(JSON.parse(raw)) });
    return true;
  } catch (e) {
    console.error('FIREBASE_SERVICE_ACCOUNT ungültig:', e.message);
    return false;
  }
}

// Beim Start initialisieren; jobs.js erkennt eine schon vorhandene App und nutzt sie weiter.
ensureFirebase();

async function requireAuth(req, res, next) {
  if (req.method === 'OPTIONS') return next(); // CORS-Preflight trägt nie einen Token

  if (!ensureFirebase()) {
    console.error('requireAuth: FIREBASE_SERVICE_ACCOUNT fehlt oder ist ungültig – Anfrage abgelehnt.');
    return res.status(500).json({ error: 'Die Anmeldung ist auf dem Server nicht eingerichtet.' });
  }

  const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  if (!match) {
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: 'Anmeldung erforderlich.' });
  }

  try {
    // Zweiter Parameter true würde zusätzlich widerrufene Tokens prüfen (kostet pro Anfrage einen Firebase-Aufruf).
    req.user = await getAuth().verifyIdToken(match[1], false);
    return next();
  } catch (e) {
    res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
    return res.status(401).json({ error: 'Anmeldung ungültig oder abgelaufen.' });
  }
}

module.exports = { requireAuth };
