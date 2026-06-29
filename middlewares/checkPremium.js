const fetch = require('node-fetch');
const User = require('../models/users');
// Ne rappelle pas RevenueCat si la dernière vérification date de moins de 15 min
const CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Vérifie le statut premium avec cache TTL 15 min côté backend.
 * Appelle RevenueCat seulement si le cache est périmé ou absent.
 */
const checkPremiumStatus = async (user) => {
  // DB dit premium → retour immédiat, aucun appel RC
  if (user.isPremium) return true;

  // DB dit free mais vérification récente → retour cache, aucun appel RC
  if (user.premiumCheckedAt && Date.now() - new Date(user.premiumCheckedAt).getTime() < CACHE_TTL_MS) {
    return false;
  }

  if (!user.revenuecatId) return false;

  console.log('🔍 Double-check RevenueCat pour', user._id);

  let isPremium = false;

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

    if (response.ok) {
      const data = await response.json();

      isPremium =
        !!data.subscriber?.entitlements?.premium?.expires_date &&
        new Date(data.subscriber.entitlements.premium.expires_date) > new Date();

      const update = { premiumCheckedAt: new Date() };
      if (isPremium) {
        update.isPremium = true;
        console.log('✅ Premium confirmé par RevenueCat, mise à jour DB');
      }
      await User.updateOne({ _id: user._id }, update);
    } else {
      console.warn('⚠️ Erreur API RevenueCat:', response.status);
      // On horodate quand même pour éviter de spammer RC en cas d'erreur
      await User.updateOne({ _id: user._id }, { premiumCheckedAt: new Date() });
    }
  } catch (err) {
    console.error('⚠️ Erreur vérification RevenueCat:', err.message);
    await User.updateOne({ _id: user._id }, { premiumCheckedAt: new Date() });
  }

  return isPremium;
};

module.exports = { checkPremiumStatus };




