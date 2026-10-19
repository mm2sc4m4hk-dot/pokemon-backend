// Gemeinsamer Zugriff auf das Firebase Admin SDK (Initialisierung + Firestore/Auth).
//
// Wird von authMiddleware.js, scanQuota.js und accountRoutes.js genutzt.
// Die App wird nur einmal initialisiert (getApps().length), damit sich
// authMiddleware und jobs.js nicht gegenseitig in die Quere kommen.
//
// FIREBASE_SERVICE_ACCOUNT: JSON (Base64 oder Klartext) des Service-Accounts.
function loadSdk() {
  let initializeApp, cert, getApps, getFirestore, getAuth;

  try {
    const appModule = require('firebase-admin/app');
    initializeApp = appModule.initializeApp;
    cert = appModule.cert;
    getApps = appModule.getApps;
  } catch (e) {}

  try {
    const fsModule = require('firebase-admin/firestore');
    getFirestore = fsModule.getFirestore;
  } catch (e) {}

  try {
    const authModule = require('firebase-admin/auth');
    getAuth = authModule.getAuth;
  } catch (e) {}

  try {
    const rawAdmin = require('firebase-admin');
    const admin = rawAdmin.default || rawAdmin;
    if (!initializeApp) initializeApp = admin.initializeApp?.bind(admin);
    if (!cert) cert = admin.credential?.cert?.bind(admin.credential);
    if (!getApps) getApps = () => admin.apps;
    if (!getFirestore) getFirestore = admin.firestore?.bind(admin);
    if (!getAuth) getAuth = admin.auth?.bind(admin);
  } catch (e) {}

  return { initializeApp, cert, getApps, getFirestore, getAuth };
}

const { initializeApp, cert, getApps, getFirestore, getAuth } = loadSdk();

// true, wenn das Admin SDK einsatzbereit ist (App initialisiert).
function ensureFirebase() {
  if (getApps && getApps().length) return true;
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return false;
  try {
    raw = raw.trim();
    if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(raw);
    if (!initializeApp || !cert) throw new Error('Firebase Admin SDK konnte nicht geladen werden.');
    initializeApp({ credential: cert(serviceAccount) });
    return true;
  } catch (e) {
    console.error('FIREBASE_SERVICE_ACCOUNT ungültig:', e.message);
    return false;
  }
}

// Firestore-Instanz (null, wenn Firebase nicht konfiguriert ist).
function db() {
  if (!ensureFirebase() || !getFirestore) return null;
  return getFirestore();
}

// Auth-Instanz (null, wenn Firebase nicht konfiguriert ist).
function auth() {
  if (!ensureFirebase() || !getAuth) return null;
  return getAuth();
}

module.exports = { ensureFirebase, db, auth };
