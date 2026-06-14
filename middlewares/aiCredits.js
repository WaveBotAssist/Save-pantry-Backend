/**
 * aiCredits.js — Middleware de quota pour toutes les features IA.
 * ─────────────────────────────────────────────────────────────────────────────
 * Ce middleware s'exécute AVANT le code de chaque route IA (scan recette,
 * import URL, "Surprise moi", génération planning, scan ticket).
 * Il vérifie si l'utilisateur a des crédits disponibles, les consomme,
 * puis appelle next() pour continuer vers la vraie route.
 *
 * Réutilise le modèle ScannerQuota (déjà en production) pour tout gérer
 * dans une seule collection MongoDB.
 *
 * Limites :
 *   - Anonyme  (deviceId, pas de compte) : ANON_LIMIT crédits permanents, jamais reset
 *   - Gratuit  (userId, pas premium)     : FREE_MONTHLY_LIMIT crédits/mois, reset le 1er
 *   - Premium                            : bypass total, aucune vérification
 *
 * Header requis : X-Device-ID (UUID généré par l'app, stocké dans AsyncStorage)
 *
 * checkAiQuota(req) — même logique, sans toucher req/res/next. Utilisé quand
 * une route ne consomme un crédit que sur CERTAINS chemins (ex: import URL,
 * IA seulement pour les vidéos sans JSON-LD).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const ScannerQuota   = require('../models/scannerQuota');
const { checkPremiumStatus } = require('./checkPremium');

// ── Constantes ────────────────────────────────────────────────────────────────
// Modifier ces deux nombres suffit pour changer les limites dans toute l'app.
const FREE_MONTHLY_LIMIT = 10; // crédits/mois pour un compte gratuit
const ANON_LIMIT         = 5;  // crédits permanents pour un utilisateur anonyme

/**
 * Vérifie le quota IA et prépare la consommation du crédit.
 *
 * @returns {Promise<object>}
 *   - { ok: true,  consumeCredit: () => Promise } — crédit dispo (no-op si premium)
 *   - { ok: false, status: 400, body: {...} }     — X-Device-ID manquant (anonyme)
 *   - { ok: false, status: 429, body: {...} }     — quota épuisé
 */
async function checkAiQuota(req) {
  try {
    const deviceId = req.headers['x-device-id'] ?? null;

    // ── Cas 1 : Utilisateur Premium ──────────────────────────────────────────
    // On vérifie le statut premium (avec double-check RevenueCat si nécessaire).
    // Si premium → bypass total, aucune consommation de crédit.
    if (req.user) {
      const isPremium = await checkPremiumStatus(req.user);
      if (isPremium) return { ok: true, consumeCredit: () => {} };
    }

    // ── Cas 2 : Utilisateur anonyme ──────────────────────────────────────────
    // Identifié uniquement par deviceId (expo-secure-store côté app).
    // Limite permanente : jamais de reset mensuel.
    if (!req.user) {
      if (!deviceId) {
        return { ok: false, status: 400, body: { result: false, error: 'quota_missing_device_id' } };
      }

      // Cherche ou crée le document quota pour cet appareil.
      // { upsert: true } = crée le document s'il n'existe pas encore.
      // { new: true }    = retourne le document après modification.
      const quota = await ScannerQuota.findOneAndUpdate(
        { deviceId, userId: null },
        { $setOnInsert: { deviceId, userId: null, scanCount: 0 } },
        { upsert: true, new: true }
      );

      if (quota.scanCount >= ANON_LIMIT) {
        return { ok: false, status: 429, body: { result: false, error: 'quota_exceeded', remaining: 0 } };
      }

      // La route appellera consumeCredit() uniquement si elle réussit
      return { ok: true, consumeCredit: () => ScannerQuota.updateOne({ _id: quota._id }, { $inc: { scanCount: 1 } }) };
    }

    // ── Cas 3 : Utilisateur connecté gratuit ─────────────────────────────────
    // Identifié par userId. Limite mensuelle avec reset automatique.
    const userId = String(req.user._id);

    // Cherche ou crée le document quota pour cet utilisateur.
    let quota = await ScannerQuota.findOne({ userId });

    if (!quota) {
      // Premier usage : on crée le document avec 0 crédits utilisés
      quota = await ScannerQuota.create({
        userId,
        deviceId: null,
        scanCount: 0,
        resetAt:  new Date(),
      });
    }

    // Reset mensuel : si on est dans un nouveau mois depuis le dernier reset,
    // on remet le compteur à zéro. Le 1er janvier, le 1er février, etc.
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    if (!quota.resetAt || quota.resetAt < startOfMonth) {
      quota.scanCount = 0;
      quota.resetAt   = new Date();
      await quota.save();
    }

    if (quota.scanCount >= FREE_MONTHLY_LIMIT) {
      return { ok: false, status: 429, body: { result: false, error: 'quota_exceeded', remaining: 0 } };
    }

    // La route appellera consumeCredit() uniquement si elle réussit
    return { ok: true, consumeCredit: () => ScannerQuota.updateOne({ _id: quota._id }, { $inc: { scanCount: 1 } }) };

  } catch (err) {
    console.error('❌ [checkAiQuota]', err.message);
    // En cas d'erreur technique (MongoDB down, etc.), on laisse passer
    // pour ne pas bloquer l'utilisateur à cause d'un problème infra.
    return { ok: true, consumeCredit: () => {} };
  }
}

/**
 * Middleware Express — applique checkAiQuota() et expose req.consumeCredit().
 */
async function aiCreditsMiddleware(req, res, next) {
  const result = await checkAiQuota(req);
  if (!result.ok) return res.status(result.status).json(result.body);

  req.consumeCredit = result.consumeCredit;
  next();
}

module.exports = aiCreditsMiddleware;
module.exports.checkAiQuota = checkAiQuota;
