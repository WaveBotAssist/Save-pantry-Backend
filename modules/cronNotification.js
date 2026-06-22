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
// Tourne toutes les heures à H:00 — chaque utilisateur reçoit sa notif
// à l’heure qu’il a choisie dans ses paramètres (ex: 9h, 18h…)
// ============================================================================
// CRON PRODUITS BIENTÔT PÉRIMÉS
// ============================================================================
//
// Tourne toutes les heures.
// Chaque utilisateur reçoit sa notification à l'heure définie
// dans ses paramètres.
//
// Notifications :
// - J-3 : expire dans 3 jours
// - J-1 : expire demain
// - Expiré : déjà périmé
//
// ============================================================================

cron.schedule("0 * * * *", async () => {
  console.log("📅 Vérification des dates de péremption");

  try {
    const users = await User.find(
      {
        "notificationSettings.expiry.enabled": true,
      },
      "email tokenpush myproducts language notificationSettings"
    );

    for (const user of users) {

      // ----------------------------------------------------------------------
      // Langue utilisateur
      // ----------------------------------------------------------------------

      const userLang = user.language || "fr";
      i18next.changeLanguage(userLang);

      // ----------------------------------------------------------------------
      // Fuseau horaire utilisateur
      // ----------------------------------------------------------------------

      const timezone =
        user.notificationSettings?.expiry?.timezone ||
        "Europe/Brussels";

      const notificationHour =
        user.notificationSettings?.expiry?.hour ?? 9;

      const currentHour = moment()
        .tz(timezone)
        .hour();

      // ----------------------------------------------------------------------
      // On envoie uniquement à l'heure choisie
      // ----------------------------------------------------------------------

      if (currentHour !== notificationHour) {
        continue;
      }

      console.log(
        `⏰ Notification pour ${user.email}`
      );

      const productsJ3 = [];
      const productsJ1 = [];
      const productsExpired = [];

      const today = moment()
        .tz(timezone)
        .startOf("day");

      // ----------------------------------------------------------------------
      // Analyse des produits
      // ----------------------------------------------------------------------

      for (const product of user.myproducts) {

        if (!product?.expiration) {
          continue;
        }

        // Produit entièrement consommé (ex: déduit à 0 via "J'ai cuisiné") —
        // rien à gaspiller, on ne notifie pas son expiration.
        // On ne touche pas aux produits sans quantité renseignée (undefined).
        if (typeof product.quantite === "number" && product.quantite <= 0) {
          continue;
        }

        const expirationDate = moment(product.expiration)
          .tz(timezone)
          .startOf("day");

        if (!expirationDate.isValid()) {
          continue;
        }

        const daysLeft = expirationDate.diff(
          today,
          "days"
        );

        // --------------------------------------------------
        // Expire dans 3 jours
        // --------------------------------------------------

        if (daysLeft === 3) {
          productsJ3.push(product.name);
        }

        // --------------------------------------------------
        // Expire demain
        // --------------------------------------------------

        else if (daysLeft === 1) {
          productsJ1.push(product.name);
        }

        // --------------------------------------------------
        // Déjà expiré
        // --------------------------------------------------

        else if ( daysLeft < 0 && !product.notifiedExpired) {
          productsExpired.push(product.name);

          await User.updateOne(
            {
              _id: user._id,
              "myproducts._id": product._id,
            },
            {
              $set: {
                "myproducts.$.notifiedExpired": true,
              },
            }
          );
        }
      }

      // ----------------------------------------------------------------------
      // Construction du message
      // ----------------------------------------------------------------------

      const segments = [];

      if (productsExpired.length > 0) {
        segments.push(
          `⚠️ ${productsExpired.length} produit(s) sont expirés`
        );
      }

      if (productsJ1.length > 0) {
        segments.push(
          `⏳ ${productsJ1.length} produit(s) expirent demain`
        );
      }

      if (productsJ3.length > 0) {
        segments.push(
          `📅 ${productsJ3.length} produit(s) expirent dans 3 jours`
        );
      }

      const message = segments.join(" • ");

      // ----------------------------------------------------------------------
      // Envoi de la notification
      // ----------------------------------------------------------------------

      if (message) {
        console.log(
          `📨 ${user.email} -> ${message}`
        );

        await sendPushNotification(
          user.tokenpush,
          message
        );
      }
    }
  } catch (error) {
    console.error(
      "❌ Erreur cron produits expirés",
      error
    );
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
      // Produit entièrement consommé — rien à gaspiller, pas de rappel
      if (typeof p.quantite === "number" && p.quantite <= 0) return false;
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


