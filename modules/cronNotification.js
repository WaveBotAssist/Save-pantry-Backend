const cron = require('node-cron');
const User = require('../models/users');
const { Expo } = require('expo-server-sdk');
const { utcToZonedTime } = require('date-fns-tz');
const i18next = require('i18next');

const expo = new Expo();

// Cron toutes les minutes
cron.schedule('* * * * *', async () => {
  console.log("📅 Vérification des dates de péremption et envoi des notifications...");

  // Récupérer uniquement les utilisateurs qui ont activé les notifs
  const users = await User.find(
    { 'notificationSettings.expiry.enabled': true },
    'email tokenpush myproducts language notificationSettings.expiry'
  );

  console.log(`👥 Utilisateurs trouvés avec notifs activées : ${users.length}`);

  const currentDate = new Date();
  currentDate.setHours(0, 0, 0, 0); // normalisation à minuit

  for (let element of users) {
    const { hour, timezone } = element.notificationSettings.expiry;

    // Utiliser le timezone de l’utilisateur, sinon fallback Bruxelles
    const tz = timezone || 'Europe/Brussels';
    const localDate = utcToZonedTime(new Date(), tz);
    const currentHour = localDate.getHours();

    console.log(`🕒 ${element.email} → fuseau ${tz}, heure locale ${currentHour}, notif prévue à ${hour}`);

    // Vérifier si c’est l’heure choisie par l’utilisateur
    if (currentHour !== hour) continue;

    // --- i18n ---
    const userLang = element.language || 'fr';
    i18next.changeLanguage(userLang);

    // --- Calcul des produits expirés ---
    let countIn3Days = 0;
    let countToday = 0;
    let countExpired = 0;

    for (let product of element.myproducts) {
      const expirationDate = new Date(product.expiration);
      expirationDate.setHours(0, 0, 0, 0);

      const diffInDays = Math.floor((expirationDate - currentDate) / (1000 * 60 * 60 * 24));

      if (diffInDays === 3) countIn3Days++;
      if (diffInDays === 0) countToday++;
      if (diffInDays < 0) countExpired++;
    }

    // --- Création du message ---
    let message = '';
    if (countIn3Days > 0) {
      message += `${i18next.t('youhave')} ${countIn3Days} ${i18next.t('expire3days')} `;
    }
    if (countToday > 0) {
      message += `${i18next.t('youhave')} ${countToday} ${i18next.t('expiretodays')} `;
    }
    if (countExpired > 0) {
      message += `${i18next.t('youhave')} ${countExpired} ${i18next.t('expired')} `;
    }

    // --- Envoi de la notif ---
    if (message) {
      console.log(`📲 Envoi à ${element.email}: ${message}`);
      await sendPushNotification(element.tokenpush, message);
    }
  }
});

// --- Vérifier la validité du token Expo ---
const isValidPushToken = (token) => {
  return Expo.isExpoPushToken(token);
};

// --- Fonction d’envoi de la notification ---
const sendPushNotification = async (pushToken, message) => {
  if (!isValidPushToken(pushToken)) {
    console.warn(`⚠️ Token push invalide: ${pushToken}`);
    return;
  }

  const messageBody = {
    to: pushToken,
    sound: 'default',
    title: 'Save Pantry :',
    body: message,
    data: { message },
  };

  try {
    const chunks = expo.chunkPushNotifications([messageBody]);
    for (let chunk of chunks) {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      for (let ticket of ticketChunk) {
        if (ticket.status === 'error') {
          console.error(`❌ Erreur d'envoi: ${ticket.message}`);
          if (ticket.details?.error === 'DeviceNotRegistered') {
            console.warn(`🔄 Suppression token obsolète: ${pushToken}`);
            await User.updateOne(
              { tokenpush: pushToken },
              { $unset: { tokenpush: '' } }
            );
          }
        } else {
          console.log('✅ Notification envoyée:', ticket);
        }
      }
    }
  } catch (error) {
    console.error('💥 Erreur lors de l’envoi:', error);
  }
};
