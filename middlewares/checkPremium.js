const fetch = require('node-fetch');
const User = require('../models/users');

// Cache mémoire : évite d'appeler RevenueCat à chaque requête
// Clé : revenuecatId  —  Valeur : { ts: timestamp, isPremium: bool }
const premiumCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Vérifie le statut premium via RevenueCat quand la DB indique free.
 * Si la DB indique déjà premium, retour immédiat sans appel RC.
 * Si le résultat a été vérifié dans les 10 dernières minutes, retour du cache.
 */
const checkPremiumStatus = async (user) => {
  if (user.isPremium) return true;
  if (!user.revenuecatId) return false;

  const cached = premiumCache.get(user.revenuecatId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.isPremium;
  }

  console.log('🔍 Double-check RevenueCat pour', user._id);

  try {
    const response = await fetch(
      `https://api.revenuecat.com/v1/subscribers/${user.revenuecatId}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.REVENUECAT_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      console.warn('⚠️ Erreur API RevenueCat:', response.status);
      return false;
    }

    const data = await response.json();
    const isPremium =
      !!data.subscriber?.entitlements?.premium?.expires_date &&
      new Date(data.subscriber.entitlements.premium.expires_date) > new Date();

    premiumCache.set(user.revenuecatId, { ts: Date.now(), isPremium });

    if (isPremium) {
      await User.updateOne({ _id: user._id }, { isPremium: true });
      console.log('✅ Premium confirmé par RevenueCat, mise à jour DB');
    }

    return isPremium;
  } catch (err) {
    console.error('⚠️ Erreur vérification RevenueCat:', err.message);
    return false;
  }
};

module.exports = { checkPremiumStatus };
