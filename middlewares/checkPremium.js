const fetch = require('node-fetch');
const User = require('../models/users');

/**
 * Vérifie le statut premium via RevenueCat quand la DB indique free.
 * Si la DB indique déjà premium, retour immédiat sans appel RC.
 */
const checkPremiumStatus = async (user) => {
  if (user.isPremium) return true;

  if (!user.revenuecatId) return false;

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

    if (response.ok) {
      const data = await response.json();

      const isPremium =
        !!data.subscriber?.entitlements?.premium?.expires_date &&
        new Date(data.subscriber.entitlements.premium.expires_date) > new Date();

      if (isPremium) {
        await User.updateOne({ _id: user._id }, { isPremium: true });
        console.log('✅ Premium confirmé par RevenueCat, mise à jour DB');
      }

      return isPremium;
    } else {
      console.warn('⚠️ Erreur API RevenueCat:', response.status);
      return false;
    }
  } catch (err) {
    console.error('⚠️ Erreur vérification RevenueCat:', err.message);
    return false;
  }
};

module.exports = { checkPremiumStatus };
