//socketSync.js


module.exports.emitItemUpdated = (io, listId, itemId, checked) => {
  io.to(`list-${listId}`).emit("item-updated", {
    listId,
    itemId,
    checked
  });
};

module.exports.emitItemDeleted = (io, listId, itemId) => {
  io.to(`list-${listId}`).emit("item-deleted", {
    listId,
    itemId
  });
};

module.exports.emitListDeleted = (io, listId) => {
  io.to(`list-${listId}`).emit("list-deleted", {
    listId
  });
};

module.exports.emitListUpdated = (io, listId) => {
  io.to(`list-${listId}`).emit("list-updated", { listId });
};
