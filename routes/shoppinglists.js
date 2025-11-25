const express = require('express');
var router = express.Router()
const ShoppingList = require('../models/shoppinglists')
const User = require('../models/users')
const { Expo } = require('expo-server-sdk');
const expo = new Expo();
const i18next = require('i18next');
const { emitItemUpdated, emitItemDeleted, emitListDeleted, emitListUpdated } = require("../utils/socketSync");

// route pour créé liste de course et la partager

router.post('/create-and-share', async (req, res) => {
  try {
    const { title, items, sharedUsers, canEdit } = req.body;
    const owner = await User.findById(req.user._id);

    // ✅ TOUJOURS ajouter le propriétaire avec son username
    const sharedWithCleaned = [{
      userId: owner._id,
      username: owner.username, // 🆕 AJOUTÉ
      canEdit: true,
      hasSeen: true,
    }];

    console.log('  👤 Propriétaire ajouté');

    // Ajouter les autres utilisateurs
    if (Array.isArray(sharedUsers) && sharedUsers.length > 0) {
      console.log('  🔍 Recherche utilisateurs...');

      for (const username of sharedUsers) {
        const user = await User.findOne({
          username: { $regex: new RegExp(`^${username}$`, 'i') },
        });

        if (!user) {
          console.warn(`  ⚠️ Utilisateur "${username}" non trouvé`);
          continue;
        }

        if (user._id.toString() === owner._id.toString()) {
          console.warn(`  ⚠️ Self-share ignoré`);
          continue;
        }

        const alreadyAdded = sharedWithCleaned.some(s =>
          s.userId.equals(user._id)
        );
        if (alreadyAdded) {
          console.warn(`  ⚠️ Doublon ignoré`);
          continue;
        }

        console.log(`  ✅ Ajout: ${user.username}`);

        sharedWithCleaned.push({
          userId: user._id,
          username: user.username, // 🆕 AJOUTÉ
          canEdit: !!canEdit,
          hasSeen: false,
        });
      }
    }

    console.log('  📋 sharedWithCleaned:', sharedWithCleaned.length, 'personne(s)');
    sharedWithCleaned.forEach(sw => {
      console.log(`    - ${sw.username} (${sw.userId})`);
    });

    // Créer la liste
    const newList = await ShoppingList.create({
      title: title || 'Ma liste',
      items,
      ownerId: owner._id,
      ownerName: owner.username,
      sharedWith: sharedWithCleaned, // Contient maintenant les usernames !
    });

    console.log('  ✅ Liste créée !');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const io = req.app.get("io");
    emitListUpdated(io, newList._id);

    // 🔔 Notifications
    const sharedUserIds = sharedWithCleaned.map(u => u.userId);
    const sharedUsersData = await User.find({
      _id: { $in: sharedUserIds }
    }).select('tokenpush notificationSettings language username');

    const usersWithNotificationsEnabled = sharedUsersData.filter(
      user => user.notificationSettings?.share?.enabled
    );

    const messages = [];

    for (const user of usersWithNotificationsEnabled) {
      if (!user.tokenpush) continue;

      const lang = user.language || 'fr';
      i18next.changeLanguage(lang);

      const isSelf = user._id.equals(owner._id);
      const body = isSelf
        ? i18next.t('listSyncedOnDevices')
        : `${i18next.t('receptionlist')} ${owner.username}`;

      messages.push({
        to: user.tokenpush,
        sound: 'default',
        title: 'Save Pantry',
        body,
        data: {
          screen: 'ShoppingList',
          listId: newList._id.toString(),
        },
      });
    }

    if (messages.length > 0) {
      setTimeout(() => {
        const chunks = expo.chunkPushNotifications(messages);
        chunks.forEach(chunk =>
          expo.sendPushNotificationsAsync(chunk)
            .then(tickets => console.log('📲 Notifications:', tickets.length))
            .catch(err => console.error('❌ Erreur notifs:', err))
        );
      }, 1000);
    }

    res.status(201).json({
      success: true,
      message: 'Liste créée avec succès',
      listId: newList._id,
      sharedWith: sharedWithCleaned.length,
    });

  } catch (error) {
    console.error('❌ [CREATE-SHARE] Erreur:', error);
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

    const lists = await ShoppingList.find(
      { "sharedWith.userId": ownerId }
    ).sort({ createdAt: -1 }); // Tri par date récente

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


// Supprimer un item d’une liste
router.delete('/deleteItem', async (req, res) => {
  const { listId, itemId } = req.body;
  const userId = req.user._id;

  try {
    const list = await ShoppingList.findOne({
      _id: listId,
      $or: [
        { ownerId: userId },
        { sharedWith: { $elemMatch: { userId, canEdit: true } } }
      ]
    });

    if (!list) {
      return res.status(403).json({
        success: false,
        message: "Pas d’accès à cette liste."
      });
    }

    const item = list.items.id(itemId);
    if (!item) {
      return res.status(404).json({ success: false, message: "Item introuvable." });
    }

    item.deleteOne(); // ❗ suppression propre du sous-document

    await list.save();

    // 👇 Émission de l’évènement socket
    const io = req.app.get("io");
    emitItemDeleted(io, listId, itemId);

    res.json({ success: true, message: "Item supprimé." });

  } catch (err) {
    console.error("❌ deleteItem:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// Modifier le "checked" d’un item dans une liste

router.post('/toggleItem', async (req, res) => {
  const { listId, itemId, checked } = req.body;

  try {
    const list = await ShoppingList.findById(listId);
    if (!list) return res.status(404).json({ error: "Liste introuvable" });

    const item = list.items.id(itemId);
    if (!item) return res.status(404).json({ error: "Item introuvable" });

    item.checked = checked;
    await list.save();

    const io = req.app.get("io");

    emitItemUpdated(io, listId, itemId, checked);

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
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

    const io = req.app.get("io");

    emitListDeleted(io, listId);

    return res.status(200).json({ result: true, message: "La liste a bien été supprimée." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Erreur serveur", error: err });
  }
});

// route pour effacer toutes les listes de course qui on été partagée
router.delete('/deleteAllLists', async (req, res) => {
  const { lists } = req.body;
  const ownerId = req.user._id;

  if (!Array.isArray(lists) || lists.length === 0) {
    return res.status(400).json({ result: false, message: "Aucune liste à supprimer." });
  }

  try {
    const allowedLists = await ShoppingList.find({
      _id: { $in: lists },
      $or: [
        { ownerId },
        { sharedWith: { $elemMatch: { userId: ownerId, canEdit: true } } }
      ]
    });

    const allowedIds = allowedLists.map(list => list._id.toString());

    if (allowedIds.length === 0) {
      return res.status(403).json({ result: false, message: "Aucune des listes n'est accessible." });
    }

    await ShoppingList.deleteMany({ _id: { $in: allowedIds } });

    const io = req.app.get("io");

    // 🔥 Important : un event spécifique pour CHAQUE liste supprimée
    allowedIds.forEach(id => emitListDeleted(io, id));

    res.json({ result: true, message: `${allowedIds.length} liste(s) supprimée(s).` });

  } catch (err) {
    res.status(500).json({ result: false, error: err.message });
  }
});


module.exports = router