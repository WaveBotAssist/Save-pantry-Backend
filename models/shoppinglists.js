const mongoose = require('mongoose');

const itemSchema =  mongoose.Schema({
  name: { type: String, required: true },
  shop: String,
  price: String,
  quantity: { type: Number, default: 1 },
  unit: { type: String, default: '' },
  checked: { type: Boolean, default: false },
});

const sharedWithSchema =  mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  canEdit: { type: Boolean, default: false },
  hasSeen: { type: Boolean, default: false } // Nouveau champ pour suivre les notifications
});

const shoppingListSchema =  mongoose.Schema(
  {
    title: String,
    items: [itemSchema],
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    ownerName: String,
    sharedWith: [sharedWithSchema],
  },
  {
    timestamps: true, // Crée automatiquement createdAt et updatedAt
  }
);

const ShoppingLists = mongoose.model('shoppinglists', shoppingListSchema);

module.exports = ShoppingLists
