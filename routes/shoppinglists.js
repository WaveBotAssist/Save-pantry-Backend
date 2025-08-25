const express = require('express');
var router = express.Router()
const ShoppingList = require('../models/shoppinglists')
const User = require('../models/users')
const { Expo } = require('expo-server-sdk');
const expo = new Expo();
const i18next = require('i18next'); 

// route pour créé liste de course et la partager
router.post('/create-and-share', async (req, res) => {
  try {
    const { title, items, sharedUsers, canEdit } = req.body;
    const owner = await User.findById(req.user._id);

    if (!items || !Array.isArray(sharedUsers)) {
      return res.status(400).json({
        success: false,
        message: 'Items ou liste d’utilisateurs invalide',
      });
    }

    const sharedWithCleaned = [];

    // 🔄 On boucle sur tous les usernames à qui on veut partager
    for (const username of sharedUsers) {
      const user = await User.findOne({
        username: { $regex: new RegExp(`^${username}$`, 'i') },
      });

      if (!user) {
        console.warn(`Utilisateur ${username} non trouvé`);
        continue;
      }

      // 🚫 Éviter de se partager à soi-même
      if (user._id.toString() === owner._id.toString()) {
        console.warn(`Tentative de partage avec soi-même (${username}) ignorée`);
        continue;
      }

      // 🧼 Éviter les doublons dans la liste
      const alreadyAdded = sharedWithCleaned.some(shared =>
        shared.userId.equals(user._id)
      );
      if (alreadyAdded) {
        console.warn(`Utilisateur ${username} déjà ajouté`);
        continue;
      }

      sharedWithCleaned.push({
        userId: user._id,
        canEdit: !!canEdit,
        hasSeen: false,
      });
    }

    // ⚠️ Si tous les utilisateurs ont été ignorés (ex: partage avec soi-même uniquement)
    if (sharedUsers.length > 0 && sharedWithCleaned.length === 0) {
      return res.status(400).json({
        success: false,
        silentlyIgnored: true,
      });
    }

    // ✅ Création de la liste partagée
    const newList = await ShoppingList.create({
      title,
      items,
      ownerId: owner._id,
      ownerName: owner.username,
      sharedWith: sharedWithCleaned,
    });

    // 🧠 Récupérer les utilisateurs avec qui on a vraiment partagé
    const sharedUserIds = sharedWithCleaned.map(u => u.userId);

    const sharedUsersData = await User.find({
      _id: { $in: sharedUserIds }
    }).select('tokenpush notificationSettings language');

    // 🔔 On ne garde que ceux qui ont activé les notifications de partage
    const usersWithNotificationsEnabled = sharedUsersData.filter(
      user => user.notificationSettings?.share?.enabled
    );

    // 📲 Construction des messages push
    const messages = [];

    for (const user of usersWithNotificationsEnabled) {
      if (!user.tokenpush) continue;

      const lang = user.language || 'fr'; // Par défaut, français
      i18next.changeLanguage(lang);

      const title = 'Save Pantry';
      const body = `${i18next.t('receptionlist')} ${owner.username}`;

      messages.push({
        to: user.tokenpush,
        sound: 'default',
        title,
        body,
        data: {
          screen: 'ShoppingList',
          listId: newList._id.toString(),
        },
      });
    }


    // ⏱️ Envoi des notifications après un court délai (optionnel)
    setTimeout(() => {
      const chunks = expo.chunkPushNotifications(messages);
      chunks.forEach(chunk =>
        expo.sendPushNotificationsAsync(chunk)
          .then(tickets => console.log('tickets:', tickets))
          .catch(err => console.error(err))
      );
    }, 1000); // 1000ms = 1 seconde (change à 60000 pour 1 minute)

    // ✅ Réponse de succès
    res.status(201).json({
      success: true,
      message: 'Liste créée et partagée avec succès',
      listId: newList._id,
      sharedWith: newList.sharedWith.length,
    });

  } catch (error) {
    console.error('Erreur create-and-share:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur',
      error: error.message,
    });
  }
});


// route pour affichage de la liste de course partagée
router.get('/getList', async (req, res) => {
  try {
    const ownerId = req.user._id;

    const lists = await ShoppingList.find({
      $or: [
        { owner: ownerId },
        { "sharedWith.userId": ownerId }
      ]
    }).sort({ createdAt: -1 }); // Tri par date récente

    // Vérifier s'il y a de nouvelles listes non lues
    const newLists = lists.filter(list =>
      !list.sharedWith.some(sw =>
        sw.userId.equals(ownerId) && sw.hasSeen
      )
    );

    // Marquer comme lues
    await ShoppingList.updateMany(
      { _id: { $in: newLists.map(l => l._id) } },
      { $set: { "sharedWith.$[elem].hasSeen": true } },
      { arrayFilters: [{ "elem.userId": ownerId }] }
    );


    res.json(lists);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});


// Modifier le "checked" d’un item dans une liste
router.post('/toggleItem', async (req, res) => {
  const { listId, itemId, checked } = req.body;

  try {
    const ownerId = req.user._id;y
    const list = await ShoppingList.findOne({
      _id: listId,
      $or: [
        { ownerId }, //recherche des listes dont l utilisateur est proprietaire
        { sharedWith: { $elemMatch: { userId: ownerId, canEdit: true } } }// recherche les listes partagées avec l'utilisateur ET où il a les droits de modification
      ]
    });

    if (!list) return res.status(404).json({ error: 'Liste introuvable ou accès refusé' });
    // on va chercher le produit concerner grace a son id dans la liste de course
    const item = list.items.id(itemId);
    if (!item) return res.status(404).json({ error: 'Élément non trouvé' });
    //on remplace sa valeur par true ou false et sauvegarde
    item.checked = checked;
    await list.save();

    res.json({ message: 'État mis à jour', item });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// route pour effacer une seule liste de course par son id
router.delete('/deleteList', async (req, res) => {
  const { listId } = req.body;
  const ownerId = req.user._id;

  try {
    // Cherche la liste uniquement si l'utilisateur a le droit de la modifier
    const list = await ShoppingList.findOne({
      _id: listId,
      $or: [
        { ownerId }, // l'utilisateur est le propriétaire
        { sharedWith: { $elemMatch: { userId: ownerId, canEdit: true } } } // ou a les droits de modification
      ]
    });

    if (!list) {
      return res.status(403).json({ result: false, message: "Pas le droit de supprimer cette liste ou elle n'existe pas." });
    }

    await ShoppingList.deleteOne({ _id: listId });

    return res.status(200).json({ result: true, message: "La liste a bien été supprimée." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Erreur serveur", error: err });
  }
});

// route pour effacer toutes les listes de course qui on été partagée
router.delete('/deleteAllLists', async (req, res) => {
  const { lists } = req.body; // attend un tableau de listes à supprimer
  const ownerId = req.user._id;

  if (!Array.isArray(lists) || lists.length === 0) {
    return res.status(400).json({ result: false, message: "Aucune liste à supprimer." });
  }

  try {
    // Trouve toutes les listes que l'utilisateur peut modifier
    const allowedLists = await ShoppingList.find({
      _id: { $in: lists },
      $or: [
        { ownerId },
        { sharedWith: { $elemMatch: { userId: ownerId, canEdit: true } } }
      ]
    });

    const allowedIds = allowedLists.map(list => list._id.toString());

    if (allowedIds.length === 0) {
      return res.status(403).json({ result: false, message: "Aucune des listes n'est accessible avec vos droits." });
    }

    await ShoppingList.deleteMany({ _id: { $in: allowedIds } });

    res.json({ result: true, message: `${allowedIds.length} liste(s) supprimée(s).` });
  } catch (err) {
    res.status(500).json({ result: false, error: err.message });
  }
});


module.exports = router