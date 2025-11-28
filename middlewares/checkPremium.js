const fetch = require('node-fetch');
const User = require('../models/users');

/**
 * 🔐 Vérifie le statut Premium avec double check RevenueCat
 * Si la DB dit "pas premium", on vérifie en temps réel avec RevenueCat
 */
const checkPremiumStatus = async (user) => {
  let isPremium = user.isPremium;

  // Si la DB dit déjà premium, pas besoin de vérifier
  if (isPremium) {
    return true;
  }

  // Double-check avec RevenueCat si la DB dit "pas premium"
  if (!isPremium && user.revenuecatId) {
    console.log('🔍 Double-check RevenueCat pour', user.username || user.email);
    
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
        
        // Vérifier si premium est actif
        isPremium =
          !!data.subscriber?.entitlements?.premium?.expires_date &&
          new Date(data.subscriber.entitlements.premium.expires_date) > new Date();

        if (isPremium) {
          console.log('✅ Premium confirmé par RevenueCat, mise à jour DB');
          
          // Mettre à jour la DB pour la prochaine fois
          await User.updateOne(
            { _id: user._id },
            { isPremium: true }
          );
        }
      } else {
        console.warn('⚠️ Erreur API RevenueCat:', response.status);
      }
    } catch (err) {
      console.error('⚠️ Erreur vérification RevenueCat:', err.message);
      // On continue avec isPremium de la DB
    }
  }

  return isPremium;
};

module.exports = { checkPremiumStatus };