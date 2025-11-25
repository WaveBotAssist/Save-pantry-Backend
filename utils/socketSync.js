//socketSync.js
/**
 * Émet un événement Socket.IO "list-updated" à tous les utilisateurs
 * connectés dans la room correspondant à cette liste.
 *
 * ➜ Chaque client ayant rejoint la room "list-<listId>" reçoit
 *    immédiatement la notification avec l'identifiant de la liste.
 * ➜ L'application cliente peut alors recharger la liste afin
 *    de synchroniser en temps réel les modifications effectuées
 *    par n'importe quel utilisateur (ajout, suppression, check, etc.).
 *
 * @param {Server} io - Instance Socket.IO du serveur
 * @param {string} listId - Identifiant de la liste mise à jour
 */

module.exports.notifyListUpdated = (io, listId) => {
  io.to(`list-${listId}`).emit("list-updated", { listId });
  console.log("📢 list-updated envoyé :", listId);
};
