// utils/premiumSync.js
const cron = require('node-cron');
const User = require('../models/users');

function startPremiumSyncJob() {
  // 🕐 Tous les jours à 3h du matin
  cron.schedule('0 3 * * *', async () => {
    console.log('🔄 [CRON] Synchronisation quotidienne des statuts premium...');
    
    try {
      const users = await User.find({ 
        revenuecatId: { $exists: true, $ne: null } 
      });
      
      let updated = 0;
      
      for (const user of users) {
        try {
          const response = await fetch(
            `https://api.revenuecat.com/v1/subscribers/${user.revenuecatId}`,
            {
              headers: {
                'Authorization': `Bearer ${process.env.REVENUECAT_API_KEY}`,
                'Content-Type': 'application/json'
              }
            }
          );

          if (response.ok) {
            const data = await response.json();
            const isPremium = 
              !!data.subscriber?.entitlements?.premium?.expires_date &&
              new Date(data.subscriber.entitlements.premium.expires_date) > new Date();

            if (user.isPremium !== isPremium) {
              user.isPremium = isPremium;
              await user.save();
              updated++;
              console.log(`  ✅ ${user.username}: ${!isPremium ? 'Premium → Free' : 'Free → Premium'}`);
            }
          }
        } catch (err) {
          console.error(`  ❌ Erreur pour ${user.username}:`, err.message);
        }

        // Pause pour éviter le rate limiting (100ms entre chaque utilisateur)
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      console.log(`✅ [CRON] Synchronisation terminée : ${updated} utilisateur(s) mis à jour`);
    } catch (error) {
      console.error('❌ [CRON] Erreur:', error);
    }
  });
  
  console.log('⏰ Tâche de synchronisation premium planifiée (tous les jours à 3h)');
}

module.exports = { startPremiumSyncJob };