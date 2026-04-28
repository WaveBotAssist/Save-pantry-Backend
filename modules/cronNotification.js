const cron = require('node-cron');
const User = require('../models/users');
const { Expo } = require('expo-server-sdk');
const expo = new Expo();
const i18next = require('i18next');
const moment = require('moment-timezone');


// --- Helpers ---
// Formater les noms courts pour la notif
function formatNamesShort(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} et ${names[1]}`;
  return "";
}

// --- Cron ---
cron.schedule('0 * * * *', async () => {
  console.log("📅 Vérification des dates de péremption et envoi des notifications...");
  try {

  const users = await User.find(
    { 'notificationSettings.expiry.enabled': true },
    'email tokenpush myproducts language notificationSettings'
  );


  const nowUtc = moment.utc();
  const currentDate = new Date();
  currentDate.setHours(0, 0, 0, 0);

  for (let element of users) {
    const userLang = element.language || 'fr';
    i18next.changeLanguage(userLang);

    const userTimezone = element.notificationSettings.expiry.timezone || 'Europe/Brussels';
    const userHour = nowUtc.clone().tz(userTimezone).hour();
    const userMinute = nowUtc.clone().tz(userTimezone).minute();

    // ✅ envoyer seulement à l’heure prévue
    if (userHour === element.notificationSettings.expiry.hour) {
      console.log(`⏰ Notification pour ${element.email} (${userTimezone})`);

      let productsSoon = [];
      let productsToday = [];
      let productsExpired = [];
      

      // Parcours des produits
      for (let p of element.myproducts) {
        if (!p?.expiration) continue;

        const exp = new Date(p.expiration);
        if (isNaN(exp.getTime())) continue;

        exp.setHours(0, 0, 0, 0);
        const diffInDays = Math.floor((exp - currentDate) / (1000 * 60 * 60 * 24));

        console.log(`Produit: ${p.name}, expiration: ${exp.toISOString()}, diffInDays=${diffInDays}`);

        if (diffInDays === 3) {
          if (productsSoon.length < 2) productsSoon.push(p.name);
        } else if (diffInDays === 0) {
          if (productsToday.length < 2) productsToday.push(p.name);
        } else if (diffInDays < 0 && !p.notifiedExpired) {
          // ⚡ Seulement si pas déjà notifié
          if (productsExpired.length < 2) productsExpired.push(p.name);

          // Marquer comme notifié en BDD
          await User.updateOne(
            { _id: element._id, "myproducts._id": p._id },
            { $set: { "myproducts.$.notifiedExpired": true } }
          );
        }
      }


      // --- Construire message combiné ---
      let segments = [];

      // Expired
      const expiredCount = element.myproducts.filter(p => {
        if (!p?.expiration) return false;
         if (p?.notifiedExpired) return false;
        const exp = new Date(p.expiration);
        if (isNaN(exp.getTime())) return false;
        exp.setHours(0, 0, 0, 0);
        return exp < currentDate;
      }).length;

      if (expiredCount > 0) {
        if (expiredCount <= 2) {
          segments.push(i18next.t("expired_names", { names: formatNamesShort(productsExpired) }));
        } else {
          segments.push(i18next.t("expired_many", { count: expiredCount }));
        }
      }

      // Today
      const todayCount = element.myproducts.filter(p => {
        if (!p?.expiration) return false;
        const exp = new Date(p.expiration);
        if (isNaN(exp.getTime())) return false;
        exp.setHours(0, 0, 0, 0);
        return (exp.getTime() === currentDate.getTime());
      }).length;

      if (todayCount > 0) {
        if (todayCount <= 2) {
          segments.push(i18next.t("today_names", { names: formatNamesShort(productsToday) }));
        } else {
          segments.push(i18next.t("today_many", { count: todayCount }));
        }
      }

      // Soon (J-3)
      const soonCount = element.myproducts.filter(p => {
        if (!p?.expiration) return false;
        const exp = new Date(p.expiration);
        if (isNaN(exp.getTime())) return false;
        exp.setHours(0, 0, 0, 0);
        return Math.floor((exp - currentDate) / (1000 * 60 * 60 * 24)) === 3;
      }).length;

      if (soonCount > 0) {
        if (soonCount <= 2) {
          segments.push(i18next.t("soon_names", { names: formatNamesShort(productsSoon) }));
        } else {
          segments.push(i18next.t("soon_many", { count: soonCount }));
        }
      }

      // Concaténer les segments
      let message = segments.join(" ");

      if (message) {
        console.log(`📨 ${element.email} : ${message}`);
        await sendPushNotification(element.tokenpush, message);
      }
    }
  }
  } catch (err) {
    console.error('❌ Erreur cron expiry notifications:', err);
  }
});


// --- Fonction d'envoi Expo (inchangée) ---
const isValidPushToken = (token) => Expo.isExpoPushToken(token);

const sendPushNotification = async (pushToken, message) => {
  if (!isValidPushToken(pushToken)) {
    console.warn(`Token push invalide: ${pushToken}`);
    return;
  }

  const messageBody = {
    to: pushToken,
    sound: 'default',
    title: i18next.t("Headsup"),
    body: message,
    data: { message },
  };

  try {
    // 👉 On découpe le tableau avec chunkPushNotifications car Expo n’autorise pas l’envoi de milliers de notifications d’un coup.
    const chunks = expo.chunkPushNotifications([messageBody]);
    for (let chunk of chunks) {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      for (let ticket of ticketChunk) {
        if (ticket.status === 'error') {
          console.error(`Erreur envoi notif: ${ticket.message}`);
          if (ticket.details && ticket.details.error === 'DeviceNotRegistered') {
            console.warn(`Token obsolète supprimé: ${pushToken}`);
            await User.updateOne({ tokenpush: pushToken }, { $unset: { tokenpush: '' } });
          }
        } else {
          console.log('✅ Notification envoyée:', ticket);
        }
      }
    }
  } catch (error) {
    console.error("❌ Erreur lors de l’envoi:", error);
  }
};




// Deuxième CRON pour le rappel groupé hebdomadaire des produits périmés
cron.schedule('0 9 * * 1', async () => {
  console.log("📅 Envoi du rappel hebdomadaire pour les produits périmés...");
  try {

  const users = await User.find(
    { 'notificationSettings.expiry.enabled': true },
    'email tokenpush myproducts language'
  );

  // Date du jour normalisée (minuit)
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let element of users) {
    const expiredProducts = element.myproducts.filter(p => {
      if (!p?.expiration) return false;           // Pas de date
      const exp = new Date(p.expiration);
      if (isNaN(exp.getTime())) return false;     // Date invalide
      exp.setHours(0, 0, 0, 0);
      return exp < today;                         // Seulement si expiré
    });

    // Debug pour vérifier
    console.log(`👤 ${element.email} → ${expiredProducts.length} périmés trouvés`);
    if (expiredProducts.length > 0) {
      console.log("Produits périmés:", expiredProducts.map(p => p.name));


      const userLang = element.language || 'fr';
      i18next.changeLanguage(userLang);

      const message = i18next.t("expired_reminder", { count: expiredProducts.length });
      await sendPushNotification(element.tokenpush, message);
    }
  }
  } catch (err) {
    console.error('❌ Erreur cron rappel hebdomadaire:', err);
  }
});


