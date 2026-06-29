var express = require('express');
var router = express.Router();
const checkToken = require('../middlewares/checkToken');
const User = require('../models/users')
const cron = require('node-cron');
const fetch = require('node-fetch')
const ScannerQuota = require('../models/scannerQuota');
const { checkPremiumStatus } = require('../middlewares/checkPremium');


const updateProductPrice = require('../modules/updateProductPrice')

/**
 * 🔄 Fonction utilitaire : Vérifie le statut premium sur RevenueCat avec retry
 * SOLUTION SANS WEBHOOKS
 */
async function checkPremiumStatusWithRetry(revenuecatId, maxRetries = 5, delayMs = 2500) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔍 Tentative ${attempt}/${maxRetries} pour ${revenuecatId}`);

      const response = await fetch(
        `https://api.revenuecat.com/v1/subscribers/${revenuecatId}`,
        {
          headers: {
            'Authorization': `Bearer ${process.env.REVENUECAT_SECRET_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!response.ok) {
        console.error(`❌ Erreur API RevenueCat (${response.status})`);

        if (attempt < maxRetries) {
          console.log(`⏳ Attente de ${delayMs}ms avant nouvelle tentative...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        return null;
      }

      const data = await response.json();

      // ✅ Vérifier si premium est actif
      const isPremium =
        !!data.subscriber?.entitlements?.premium?.expires_date &&
        new Date(data.subscriber.entitlements.premium.expires_date) > new Date();

      console.log(`${isPremium ? '✅' : '⚠️'} Statut premium: ${isPremium}`);

      // Si premium trouvé, on retourne immédiatement
      if (isPremium) {
        return true;
      }

      // Si pas premium mais c'est pas le dernier essai, on réessaie
      // (peut-être que RevenueCat est en train de propager)
      if (attempt < maxRetries) {
        console.log(`⏳ Premium pas encore détecté, attente de ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      // Dernier essai et toujours pas premium
      return false;

    } catch (error) {
      console.error(`❌ Erreur tentative ${attempt}:`, error.message);

      if (attempt < maxRetries) {
        console.log(`⏳ Attente de ${delayMs}ms avant nouvelle tentative...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  return null;
}

/**
 * 🔐 Route pour vérifier et synchroniser le statut premium
 * OPTIMISÉE POUR FONCTIONNER SANS WEBHOOKS
 */
router.post('/sync-premium', checkToken, async (req, res) => {
  try {
    const user = req.user;

    if (!user.revenuecatId) {
      console.error('❌ Utilisateur sans RevenueCat ID:', user._id);
      return res.status(400).json({
        result: false,
        message: 'Utilisateur sans RevenueCat ID'
      });
    }

    console.log(`🔄 Synchronisation premium pour user ${user._id} (RC: ${user.revenuecatId})`);

    // Guard TTL 5 min — évite de spammer RevenueCat si sync récente
    const SYNC_CACHE_TTL_MS = 5 * 60 * 1000;
    if (user.premiumCheckedAt && Date.now() - new Date(user.premiumCheckedAt).getTime() < SYNC_CACHE_TTL_MS) {
      console.log('⚡ Cache récent (< 5 min), retour DB sans appel RevenueCat');
      return res.json({ result: true, isPremium: user.isPremium, updated: false, fromCache: true });
    }

    const isPremiumRevenueCat = await checkPremiumStatusWithRetry(user.revenuecatId, 1, 0);

    if (isPremiumRevenueCat === null) {
      console.log('⚠️ Pas de réponse RevenueCat, on retourne le statut DB');
      await User.updateOne({ _id: user._id }, { premiumCheckedAt: new Date() });
      return res.json({
        result: true,
        isPremium: user.isPremium,
        updated: false,
        fromCache: true
      });
    }

    console.log(`🔍 Comparaison: DB=${user.isPremium}, RevenueCat=${isPremiumRevenueCat}`);

    // 🔄 Mettre à jour la BDD si nécessaire
    if (user.isPremium !== isPremiumRevenueCat) {
      await User.updateOne(
        { _id: user._id },
        { isPremium: isPremiumRevenueCat, premiumCheckedAt: new Date() }
      );

      console.log(`✅ Base de données mise à jour: ${user.isPremium} → ${isPremiumRevenueCat}`);

      // 🧹 Si passage de premium à free, supprimer les sessions multiples
      if (!isPremiumRevenueCat && user.isPremium) {
        const Session = require('../models/session');
        const sessions = await Session.find({
          userId: user._id,
          revokedAt: null,
          expiresAt: { $gt: new Date() }
        }).sort({ createdAt: -1 });

        if (sessions.length > 1) {
          await Session.deleteMany({
            userId: user._id,
            _id: { $ne: sessions[0]._id }
          });
          console.log(`🧹 ${sessions.length - 1} session(s) supprimée(s) (retour au mode free)`);
        }
      }
    } else {
      console.log('✅ Statut déjà synchronisé, aucune mise à jour nécessaire');
      await User.updateOne({ _id: user._id }, { premiumCheckedAt: new Date() });
    }

    res.json({
      result: true,
      isPremium: isPremiumRevenueCat,
      updated: user.isPremium !== isPremiumRevenueCat
    });

  } catch (error) {
    console.error('❌ Erreur sync-premium:', error);
    res.status(500).json({
      result: false,
      message: 'Erreur serveur',
      error: error.message
    });
  }
});

// Route pour préremplir le formulaire de l'user avec ses préférences actuelles
router.get('/me', checkToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('email notificationSettings');
    if (!user) return res.status(404).json({ message: "Utilisateur non trouvé" });

    res.json({
      email: user.email,
      notificationSettings: {
        expiry: {
          enabled: user.notificationSettings?.expiry?.enabled ?? false,
          hour: user.notificationSettings?.expiry?.hour ?? 9,
        },
        share: {
          enabled: user.notificationSettings?.share?.enabled ?? false,
        }
      }
    });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

// Route pour supprimer un compte utilisateur dans le screen profil
router.delete('/deleteUser', checkToken, async (req, res) => {
  const { _id } = req.user;
  if (!_id) {
    return res.status(400).json({ result: false, error: "ID utilisateur manquant" });
  }
  try {
    await User.findByIdAndDelete(_id)
    res.json({ result: true, message: "Compte utilisateur supprimé avec succès" });
  } catch (err) {
    return res.status(500).json({ result: false, error: err.message });
  }
});

// Route pour modifier le choix de l'utilisateur pour la langue de l'application
router.put('/updateLanguage', checkToken, async (req, res) => {
  try {
    const { language } = req.body;
    const userId = req.user._id;

    if (!['fr', 'en'].includes(language)) {
      return res.status(400).json({ error: 'Langue non prise en charge' });
    }

    await User.findByIdAndUpdate(userId, { language });
    res.json({ result: true, message: 'Langue mise à jour' });
  } catch (err) {
    console.error('Erreur /updateLanguage:', err);
    res.status(500).json({ result: false, error: err.message });
  }
});

// Cron pour mettre à jour les prix des produits
cron.schedule("0 0 * * *", async () => {
  console.log("🔄 Mise à jour des prix en cours...");

  try {
    const users = await User.find({}, { "myproducts.codebarre": 1 });
    const uniqueCodebarres = [...new Set(users.flatMap(user => user.myproducts.map(p => p.codebarre)))];

    console.log(`🔍 Codes-barres trouvés :`, uniqueCodebarres);

    for (const codebarre of uniqueCodebarres) {
      await updateProductPrice(codebarre);
    }

  } catch (err) {
    console.error("❌ Erreur dans le cron job :", err.message);
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   GET /user/credits
   Retourne les crédits IA restants pour l'utilisateur connecté.
   Le frontend appelle cet endpoint au chargement des écrans IA pour afficher
   le compteur "X crédits restants ce mois".
─────────────────────────────────────────────────────────────────────────────── */
router.get('/credits', checkToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('isPremium revenuecatId');
    if (!user) return res.status(404).json({ result: false, error: 'Utilisateur introuvable.' });

    const isPremium = await checkPremiumStatus(user);
    if (isPremium) return res.json({ result: true, isPremium: true });

    const FREE_MONTHLY_LIMIT = 10;
    const quota = await ScannerQuota.findOne({ userId: String(req.user._id) });

    // Vérifie si on est dans un nouveau mois depuis le dernier reset
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const needsReset = quota?.resetAt && quota.resetAt < startOfMonth;
    const used = (!quota || needsReset) ? 0 : quota.scanCount;

    res.json({
      result: true,
      isPremium: false,
      used,
      limit: FREE_MONTHLY_LIMIT,
      remaining: Math.max(0, FREE_MONTHLY_LIMIT - used),
    });
  } catch (err) {
    console.error('❌ [GET /user/credits]', err.message);
    res.status(500).json({ result: false, error: 'Erreur serveur.' });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /user/credits/migrate
   Transfère les crédits utilisés en mode anonyme vers le compte connecté.
   Appelé une seule fois par migrationService juste après login/register,
   seulement si l'utilisateur avait utilisé des crédits en anonyme.
   Body : { deviceId: string }
─────────────────────────────────────────────────────────────────────────────── */
router.post('/credits/migrate', checkToken, async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) return res.json({ result: true });

    const userId = String(req.user._id);

    // Cherche le document quota anonyme pour cet appareil
    const anonQuota = await ScannerQuota.findOne({ deviceId, userId: null });
    if (!anonQuota || anonQuota.scanCount === 0) return res.json({ result: true });

    // Cherche le document quota du compte (peut déjà exister si l'utilisateur
    // avait un compte et se reconnecte sur un nouvel appareil)
    const userQuota = await ScannerQuota.findOne({ userId });

    if (userQuota) {
      // Additionne les crédits anonymes aux crédits déjà utilisés sur le compte.
      // Exemple : 5 utilisés sur le compte + 3 anonymes = 8/10 utilisés.
      userQuota.scanCount = userQuota.scanCount + anonQuota.scanCount;
      userQuota.resetAt = userQuota.resetAt ?? new Date();
      await userQuota.save();
    } else {
      // Nouveau compte : le compteur démarre au nombre de crédits utilisés en anonyme.
      // Exemple : 3 crédits anonymes utilisés → compte démarre à 3/10.
      await ScannerQuota.create({
        userId,
        deviceId: null,
        scanCount: anonQuota.scanCount,
        resetAt: new Date(),
      });
    }

    // On épuise le quota anonyme de cet appareil plutôt que de le supprimer.
    //
    // Si on supprimait le document, le middleware aiCredits en recréerait un
    // à scanCount=0 au premier usage anonyme → 5 crédits frais à chaque
    // cycle déconnexion / reconnexion. C'est le comportement à éviter.
    //
    // En le laissant à ANON_LIMIT, le middleware voit scanCount >= ANON_LIMIT
    // et bloque immédiatement tout usage anonyme sur cet appareil.
    const ANON_LIMIT = 5; // doit correspondre à aiCredits.js
    await ScannerQuota.updateOne({ _id: anonQuota._id }, { $set: { scanCount: ANON_LIMIT } });

    res.json({ result: true });
  } catch (err) {
    console.error('❌ [POST /user/credits/migrate]', err.message);
    res.status(500).json({ result: false, error: 'Erreur serveur.' });
  }
});

module.exports = router;