// socketSync.js - VERSION OPTIMISÉE
const ShoppingList = require('../models/shoppinglists');

module.exports.emitItemUpdated = async (io, listId, itemId, checked) => {
  try {
    // 🔥 CHANGEMENT : On récupère et envoie la liste complète
    const updatedList = await ShoppingList.findById(listId);
    if (!updatedList) return;

    io.to(`list-${listId}`).emit("item-updated", {
      listId,
      itemId,
      checked,
      list: updatedList // 🆕 Données complètes
    });
  } catch (err) {
    console.error("❌ emitItemUpdated:", err);
  }
};

module.exports.emitItemDeleted = async (io, listId, itemId) => {
  try {
    // 🔥 CHANGEMENT : On récupère et envoie la liste complète
    const updatedList = await ShoppingList.findById(listId);
    if (!updatedList) return;

    io.to(`list-${listId}`).emit("item-deleted", {
      listId,
      itemId,
      list: updatedList // 🆕 Données complètes
    });
  } catch (err) {
    console.error("❌ emitItemDeleted:", err);
  }
};

module.exports.emitListDeleted = (io, listId) => {
  // ✅ Pas de changement : pas besoin de données
  io.to(`list-${listId}`).emit("list-deleted", { listId });
};

module.exports.emitListUpdated = async (io, listId) => {
  try {
    // 🔥 CHANGEMENT : On récupère et envoie la liste complète
    const updatedList = await ShoppingList.findById(listId);
    if (!updatedList) return;

    io.to(`list-${listId}`).emit("list-updated", {
      listId,
      list: updatedList // 🆕 Données complètes
    });
  } catch (err) {
    console.error("❌ emitListUpdated:", err);
  }
};