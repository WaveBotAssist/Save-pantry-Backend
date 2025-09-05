const cron = require('node-cron');
const User = require('../models/users'); // Modèle des utilisateurs
const { Expo } = require('expo-server-sdk');
const expo = new Expo();
// Chargement de i18next pour la gestion des traductions
const i18next = require('i18next');
const moment = require('moment-timezone');

// Planifier la tâche tous les jours à 9h du matin
cron.schedule('* * * * *', async () => {
  console.log("📅 Vérification des dates de peremption de chaques utilisateurs et envoi des notifications...");


  const users = await User.find({
    'notificationSettings.expiry.enabled': true
  }, 'email tokenpush myproducts language notificationSettings');

  const nowUtc = moment.utc();

  const serverLocal = nowUtc.clone().tz("Europe/Brussels");
  console.log(
    `📊 Vérification des notifications | UTC: ${nowUtc.format("HH:mm")} | Europe/Brussels: ${serverLocal.format("HH:mm")} | Utilisateurs trouvés: ${users.length}`
  );

  ;
  const currentDate = new Date();
  currentDate.setHours(0, 0, 0, 0); // Normaliser à minuit pour ignorer l'heure

  users.forEach(element => {
    // ajout de i18next pour la gestion des traductions
    const userLang = element.language || 'fr'; // fallback français si non défini
    i18next.changeLanguage(userLang); // Changer la langue pour l'utilisateur

    const userTimezone = element.notificationSettings.expiry.timezone || 'Europe/Brussels'; // fallback
    const userHour = nowUtc.clone().tz(userTimezone).hour();

    if (userHour === element.notificationSettings.expiry.hour) {
      console.log(
        `⏰ Notification pour ${element.email} | Heure locale: ${userHour}h (${userTimezone}) | UTC: ${nowUtc.format("HH:mm")}`
      );

      let countIn3Days = 0;  // Compte des produits expirant dans 3 jours
      let countToday = 0;    // Compte des produits expirant aujourd'hui
      let countExpired = 0;  // Compte des produits expirés
      console.log('element', element.tokenpush)
      // Parcours des produits de l'utilisateur
      for (let dates of element.myproducts) {
        const expirationDate = new Date(dates.expiration);
        expirationDate.setHours(0, 0, 0, 0); // Normaliser à minuit

        const diffInMilliseconds = expirationDate - currentDate;
        const diffInDays = Math.floor(diffInMilliseconds / (1000 * 60 * 60 * 24)); // Différence en jours

        console.log(`Produit: ${dates.name} | Jours restants: ${diffInDays}`);

        // Si le produit expire dans 3 jours
        if (diffInDays === 3) {
          countIn3Days++;
        }

        // Si le produit expire aujourd'hui
        if (diffInDays === 0) {
          countToday++;
        }

        // Si la date d'expiration est déjà passée
        if (diffInDays < 0) {
          countExpired++;
        }
      }

      // Créer un message en fonction du nombre de produits dans chaque catégorie
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

      // Si un message a été créé, envoie la notification
      if (message) {
        console.log(element.tokenpush, `Utilisateur ${element.email}: ${message}`);
        sendPushNotification(element.tokenpush, message);
      }
    }
  })
});


// Vérifier la validité du token Expo
const isValidPushToken = (token) => {
  return Expo.isExpoPushToken(token);
};

// Fonction pour envoyer une notification push via Expo
const sendPushNotification = async (pushToken, message) => {
  if (!isValidPushToken(pushToken)) {
    console.warn(`Token push invalide: ${pushToken}`);
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
          console.error(`Erreur d'envoi de notification: ${ticket.message}`);

          if (
            ticket.details &&
            ticket.details.error === 'DeviceNotRegistered'
          ) {
            console.warn(`Token obsolète supprimé: ${pushToken}`);
            await User.updateOne({ tokenpush: pushToken }, { $unset: { tokenpush: '' } });
          }
        } else {
          console.log('Notification envoyée avec succès:', ticket);
        }
      }
    }
  } catch (error) {
    console.error('Erreur lors de l’envoi de la notification:', error);
  }
};