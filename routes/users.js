var express = require('express');
var router = express.Router();
const checkToken = require('../middlewares/checkToken');
const User = require('../models/users')
const cron = require('node-cron');
const fetch = require('node-fetch')

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

      // 🔍 Log détaillé pour debug
      console.log('📦 Données RevenueCat:', JSON.stringify({
        subscriber: data.subscriber?.subscriber_id,
        hasEntitlements: !!data.subscriber?.entitlements,
        hasPremium: !!data.subscriber?.entitlements?.premium,
        premiumExpiry: data.subscriber?.entitlements?.premium?.expires_date,
        allEntitlements: Object.keys(data.subscriber?.entitlements || {})
      }, null, 2));

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

    // ✅ Appel avec retry automatique (5 tentatives, 2.5s entre chaque)
    // Total : ~12.5 secondes max de tentatives
    const isPremiumRevenueCat = await checkPremiumStatusWithRetry(user.revenuecatId, 1, 0);

    if (isPremiumRevenueCat === null) {
      console.log('⚠️ Pas de réponse RevenueCat, on retourne le statut DB');
      return res.json({
        result: true,
        isPremium: user.isPremium,  // ⬅️ Statut actuel de la BDD
        updated: false,
        fromCache: true
      });
    }

    console.log(`🔍 Comparaison: DB=${user.isPremium}, RevenueCat=${isPremiumRevenueCat}`);

    // 🔄 Mettre à jour la BDD si nécessaire
    if (user.isPremium !== isPremiumRevenueCat) {
      await User.updateOne(
        { _id: user._id },
        { isPremium: isPremiumRevenueCat }
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
  const { language } = req.body;
  const userId = req.user._id;

  if (!['fr', 'en'].includes(language)) {
    return res.status(400).json({ error: 'Langue non prise en charge' });
  }

  await User.findByIdAndUpdate(userId, { language });
  res.json({ result: true, message: 'Langue mise à jour' });
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

module.exports = router;