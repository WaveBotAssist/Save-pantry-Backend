
/**
 * scanner.js — Route POST /scanner/scan-receipt
 * ─────────────────────────────────────────────────────────────────────────────
 * Analyse un ticket de caisse via OCR + Gemini et retourne la liste
 * des produits extraits avec leur date d'expiration approximative.
 *
 * Accessible par tous (anonymes et inscrits) via optionalAuth.
 * Le quota est géré par le middleware aiCredits (même pool que les autres features IA).
 *
 * Flux :
 *   1. Validation deviceId + texte OCR
 *   2. Vérification qualité OCR (pas de pénalité quota si photo floue)
 *   3. [aiCredits middleware] vérifie les crédits disponibles
 *   4. Appel Gemini pour extraction produits
 *   5. Déduplication + enrichissement dates d'expiration
 *   6. Retour des produits au frontend
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express   = require('express');
const rateLimit = require('express-rate-limit');

const ApiGemini  = require('../services/ApiGemini');
const aiCredits  = require('../middlewares/aiCredits');
const { getExpiryDate } = require('../utils/receiptExpiryDates');

const router = express.Router();

// Protection anti-abus par IP (indépendant du quota utilisateur)
const scanRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { result: false, code: 'RATE_LIMIT_EXCEEDED', message: 'Trop de requêtes. Réessaie dans 15 minutes.' },
});

// ─────────────────────────────────────────────────────────────────────────────
// Middleware de pré-validation — s'exécute AVANT aiCredits pour ne pas
// consommer un crédit si la requête ou la photo est invalide.
// ─────────────────────────────────────────────────────────────────────────────
function validateScanRequest(req, res, next) {
  const { ocrText } = req.body;
  const deviceId    = req.headers['x-device-id'];

  if (!ocrText || typeof ocrText !== 'string' || ocrText.trim().length === 0) {
    return res.status(400).json({ result: false, code: 'MISSING_OCR_TEXT', message: 'Le texte OCR est requis.' });
  }

  if (!deviceId || typeof deviceId !== 'string') {
    return res.status(400).json({ result: false, code: 'MISSING_DEVICE_ID', message: 'Header X-Device-ID manquant.' });
  }

  const ocrLines     = ocrText.trim().split('\n').filter(l => l.trim().length > 0);
  const hasPrices    = /\d+[.,]\d+/.test(ocrText);
  const pricePattern = /\d+[.,]\d+/g;

  if (ocrLines.length < 3 && !hasPrices) {
    return res.status(422).json({
      result: false, code: 'POOR_OCR_QUALITY',
      message: "La photo est trop floue ou mal cadrée. Reprends la photo en t'assurant que le ticket est bien lisible.",
    });
  }

  const linesWithManyPrices = ocrLines.filter(l => (l.match(pricePattern) || []).length >= 5).length;
  if (linesWithManyPrices >= 2) {
    return res.status(422).json({
      result: false, code: 'POOR_OCR_QUALITY',
      message: 'Le ticket est mal cadré ou trop loin. Tiens le téléphone à plat, bien au-dessus du ticket.',
    });
  }

  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /scanner/scan-receipt
// Ordre : validation → crédit → Gemini
// Le crédit n'est consommé que si la photo et le texte OCR sont valides.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/scan-receipt', scanRateLimit, validateScanRequest, aiCredits, async (req, res) => {
  try {
    const { ocrText } = req.body;

    // ── Analyse Gemini ───────────────────────────────────────────────────────

    const geminiResult = await ApiGemini(ocrText);

    if (!Array.isArray(geminiResult?.items)) {
      await req.consumeCredit?.();
      return res.status(200).json({
        result:          true,
        creditConsumed:  true,
        store:    geminiResult?.store || '',
        date:     geminiResult?.date  || '',
        currency: geminiResult?.currency || '€',
        items:    [],
        total:    geminiResult?.total || 0,
      });
    }

    // ── Étape 4 : Déduplication ──────────────────────────────────────────────
    // Gemini peut retourner plusieurs fois le même produit — on fusionne par nom+prix.

    const deduplicatedItems = geminiResult.items.reduce((acc, item) => {
      if (!item.name) return acc;
      const price = typeof item.price === 'number' ? item.price : 0;
      const key   = `${item.name.toLowerCase().trim()}|${price}`;
      const qty   = typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : 1;
      const existing = acc.get(key);
      if (existing) {
        existing.quantity += qty;
      } else {
        acc.set(key, { ...item, name: item.name, price, quantity: qty });
      }
      return acc;
    }, new Map());

    // ── Étape 5 : Enrichissement dates d'expiration ──────────────────────────

    const enrichedItems = Array.from(deduplicatedItems.values()).map((item) => ({
      name:           item.name  || '',
      price:          typeof item.price === 'number' ? item.price : 0,
      category:       item.category || '',
      quantity:       typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : 1,
      expirationDate: getExpiryDate(item.category, item.name || ''),
    }));

    // ── Étape 6 : Réponse ────────────────────────────────────────────────────

    await req.consumeCredit?.();
    return res.status(200).json({
      result:          true,
      creditConsumed:  true,
      store:    geminiResult.store    || '',
      date:     geminiResult.date     || '',
      currency: geminiResult.currency || '€',
      items:    enrichedItems,
      total:    geminiResult.total    || 0,
    });

  } catch (error) {
    console.error('❌ Erreur scan-receipt:', error);
    res.status(500).json({
      result:  false,
      code:    'SERVER_ERROR',
      message: "Une erreur est survenue lors de l'analyse du ticket.",
    });
  }
});

module.exports = router;
