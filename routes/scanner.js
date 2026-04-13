/**
 * scanner.js — Route POST /scanner/scan-receipt
 * ─────────────────────────────────────────────────────────────────────────────
 * Analyse un ticket de caisse via OCR + Gemini et retourne la liste
 * des produits alimentaires extraits avec leur date d'expiration approximative.
 *
 * Accessible par tous (anonymes et inscrits) via optionalAuth.
 * Les utilisateurs premium bypassen la vérification du quota.
 *
 * Flux complet :
 *   1. Vérification du deviceId (header X-Device-ID obligatoire)
 *   2. Si utilisateur premium → bypass quota, on passe directement à l'analyse
 *   3. Sinon → vérification du quota via ScannerQuota (FREE_SCAN_LIMIT scans gratuits)
 *   4. Appel à Gemini avec le texte OCR
 *   5. Enrichissement de chaque produit avec une date d'expiration approximative
 *   6. Incrémentation du compteur de scans (sauf pour les premium)
 *   7. Retour des produits enrichis au frontend
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const ApiGemini = require('../services/ApiGemini');
const ScannerQuota = require('../models/scannerQuota');
const { getExpiryDate } = require('../utils/receiptExpiryDates');

const router = express.Router();

/**
 * Nombre de scans gratuits autorisés par appareil.
 * Modifier cette constante suffit pour changer la limite dans toute l'app.
 * @constant {number}
 */
const FREE_SCAN_LIMIT = 3;

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITING
// Protection contre les appels abusifs directs à l'API (scripts, bots).
// Limite : 10 requêtes par fenêtre de 15 minutes par IP.
// ─────────────────────────────────────────────────────────────────────────────
const scanRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { result: false, code: 'RATE_LIMIT_EXCEEDED', message: 'Trop de requêtes. Réessaie dans 15 minutes.' },
});

const quotaRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60, // lecture simple, limite plus souple
  standardHeaders: true,
  legacyHeaders: false,
  message: { result: false, code: 'RATE_LIMIT_EXCEEDED', message: 'Trop de requêtes. Réessaie dans 15 minutes.' },
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /scanner/quota
// Retourne le quota actuel sans effectuer de scan.
// Appelé à l'ouverture de l'écran pour afficher un compteur à jour,
// notamment après un changement de compte sur le même appareil.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/quota', quotaRateLimit, async (req, res) => {
  try {
    const deviceId = req.headers['x-device-id'];
    const isPremium = req.user?.isPremium === true;

    if (isPremium) {
      return res.status(200).json({ result: true, quota: { isPremium: true } });
    }

    // deviceId obligatoire pour les anonymes
    if (!req.user && (!deviceId || typeof deviceId !== 'string')) {
      return res.status(400).json({
        result: false,
        code: 'MISSING_DEVICE_ID',
        message: 'Header X-Device-ID manquant.',
      });
    }

    // Même logique de clé que dans POST /scan-receipt
    const quotaFilter = req.user
      ? { userId: String(req.user._id) }
      : { deviceId, userId: null };

    const quota = await ScannerQuota.findOne(quotaFilter).select('scanCount');
    const scansUsed = quota?.scanCount ?? 0;

    return res.status(200).json({
      result: true,
      quota: {
        isPremium: false,
        scansUsed,
        scansLimit: FREE_SCAN_LIMIT,
        scansRemaining: Math.max(0, FREE_SCAN_LIMIT - scansUsed),
      },
    });
  } catch (error) {
    console.error('❌ Erreur GET /scanner/quota:', error);
    res.status(500).json({ result: false, code: 'SERVER_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /scanner/scan-receipt
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/scan-receipt',
  scanRateLimit,// Protection anti-abus par IP (optionalAuth + slideSession sont dans app.js)
  async (req, res) => {
    try {
      // ───────────────────────────────────────────────────────────────────────
      // ÉTAPE 1 : Validation des données entrantes
      // ───────────────────────────────────────────────────────────────────────

      const { ocrText } = req.body;
      const deviceId = req.headers['x-device-id'];

      // Le texte OCR est obligatoire
      if (!ocrText || typeof ocrText !== 'string' || ocrText.trim().length === 0) {
        return res.status(400).json({
          result: false,
          code: 'MISSING_OCR_TEXT',
          message: 'Le texte OCR est requis.',
        });
      }

      // Le deviceId est obligatoire pour tracker le quota
      if (!deviceId || typeof deviceId !== 'string') {
        return res.status(400).json({
          result: false,
          code: 'MISSING_DEVICE_ID',
          message: 'Header X-Device-ID manquant.',
        });
      }

      // ───────────────────────────────────────────────────────────────────────
      // ÉTAPE 2 : Vérification du quota
      // Les utilisateurs premium bypassen entièrement cette étape.
      // ───────────────────────────────────────────────────────────────────────

      const isPremium = req.user?.isPremium === true;

      // Clé de quota : userId pour les comptes connectés, deviceId pour les anonymes.
      // Cela évite qu'un deuxième utilisateur sur le même appareil hérite du quota épuisé
      // du premier.
      const quotaFilter = req.user
        ? { userId: String(req.user._id) }
        : { deviceId, userId: null };

      // Hoisted pour pouvoir calculer scansUsedAfter sans requête DB supplémentaire à l'étape 7.
      let quotaDoc = null;

      if (!isPremium) {
        // Cherche ou crée le document quota pour ce compte (ou cet appareil si anonyme)
        // upsert: true → crée le document s'il n'existe pas encore
        quotaDoc = await ScannerQuota.findOneAndUpdate(
          quotaFilter,
          { $setOnInsert: { ...quotaFilter, scanCount: 0 } },
          { upsert: true, new: true }
        );

        if (quotaDoc.scanCount >= FREE_SCAN_LIMIT) {
          return res.status(403).json({
            result: false,
            code: 'QUOTA_EXCEEDED',
            message: `Tu as utilisé tes ${FREE_SCAN_LIMIT} scans gratuits. Passe en Premium pour scanner sans limite.`,
            scansUsed: quotaDoc.scanCount,
            scansLimit: FREE_SCAN_LIMIT,
          });
        }
      }

      // ───────────────────────────────────────────────────────────────────────
      // ÉTAPE 3 : Analyse du ticket par Gemini
      // ───────────────────────────────────────────────────────────────────────

      const geminiResult = await ApiGemini(ocrText);
      console.log('reponse de api gemini', geminiResult)
      // Sécurité : si Gemini ne retourne pas de tableau d'items, on retourne vide
      if (!Array.isArray(geminiResult?.items)) {
        return res.status(200).json({
          result: true,
          store: geminiResult?.store || '',
          date: geminiResult?.date || '',
          items: [],
          total: geminiResult?.total || 0,
        });
      }

      // ───────────────────────────────────────────────────────────────────────
      // ÉTAPE 4 : Déduplication des produits
      // Gemini peut retourner plusieurs fois le même produit (même nom, même prix)
      // au lieu de fusionner les quantités. On le fait ici côté backend pour
      // garantir un résultat propre indépendamment du comportement de Gemini.
      // Clé de déduplication : nom normalisé + prix unitaire.
      // ───────────────────────────────────────────────────────────────────────
      // Liste blanche des catégories alimentaires valides.
      // Tout item avec une catégorie hors de cette liste est exclu (non alimentaire).
      const VALID_CATEGORIES = new Set([
        'Produits laitiers', 'Féculents', 'Fruits et légumes', 'Matières grasses',
        'Produits sucrés', 'Boissons', 'Viande, Poisson, oeuf', 'Sauces',
      ]);

      const deduplicatedItems = geminiResult.items.reduce((acc, item) => {
        // Exclut les produits sans nom ou dont la catégorie n'est pas alimentaire
        // (Gemini peut retourner "Non alimentaire" ou "" pour les produits hors food)
        if (!item.name || !VALID_CATEGORIES.has(item.category)) return acc;

        const name = item.name || '';
        const price = typeof item.price === 'number' ? item.price : 0;
        const key = `${name.toLowerCase().trim()}|${price}`;
        const existing = acc.get(key);
        const qty = typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : 1;
        if (existing) {
          existing.quantity += qty;
        } else {
          acc.set(key, { ...item, name, price, quantity: qty });
        }
        return acc;
      }, new Map());

      // ───────────────────────────────────────────────────────────────────────
      // ÉTAPE 5 : Enrichissement des produits avec la date d'expiration
      // Chaque produit reçoit une date approximative basée sur sa catégorie.
      // L'utilisateur peut la modifier dans l'écran de validation.
      // ───────────────────────────────────────────────────────────────────────
      const enrichedItems = Array.from(deduplicatedItems.values()).map((item) => ({
        name: item.name || '',
        price: typeof item.price === 'number' ? item.price : 0,
        category: item.category || '',
        // Quantité extraite du ticket par Gemini, ou 1 par défaut si non trouvée
        quantity: typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : 1,
        // Date d'expiration calculée côté backend via mots-clés sur le nom,
        // avec fallback sur la catégorie — plus cohérent que de laisser Gemini estimer
        expirationDate: getExpiryDate(item.category, item.name || ''),
      }));

      // ───────────────────────────────────────────────────────────────────────
      // ÉTAPE 6 : Incrémentation du quota (uniquement si non-premium)
      // On incrémente après le succès pour ne pas pénaliser les erreurs Gemini.
      // ───────────────────────────────────────────────────────────────────────

      if (!isPremium) {
        await ScannerQuota.findOneAndUpdate(
          quotaFilter,
          { $inc: { scanCount: 1 } }
        );
      }

      // ───────────────────────────────────────────────────────────────────────
      // ÉTAPE 7 : Réponse au frontend
      // ───────────────────────────────────────────────────────────────────────

      // scansUsed après incrément = valeur avant + 1, calculée localement
      // pour éviter une requête DB supplémentaire.
      const scansUsedAfter = (quotaDoc?.scanCount ?? 0) + 1;

      return res.status(200).json({
        result: true,
        store: geminiResult.store || '',
        date: geminiResult.date || '',
        items: enrichedItems,
        total: geminiResult.total || 0,
        // Infos quota retournées au frontend pour mise à jour de l'affichage
        quota: isPremium
          ? { isPremium: true }
          : {
            isPremium: false,
            scansUsed: scansUsedAfter,
            scansLimit: FREE_SCAN_LIMIT,
            scansRemaining: Math.max(0, FREE_SCAN_LIMIT - scansUsedAfter),
          },
      });
    } catch (error) {
      console.error('❌ Erreur scan-receipt:', error);
      res.status(500).json({
        result: false,
        code: 'SERVER_ERROR',
        message: 'Une erreur est survenue lors de l\'analyse du ticket.',
      });
    }
  }
);

module.exports = router;
