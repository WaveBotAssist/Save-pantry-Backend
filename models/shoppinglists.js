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
  username: String,
  canEdit: { type: Boolean, default: false },
  hasSeen: { type: Boolean, default: false } // Nouveau champ pour suivre les notifications
});

const shoppingListSchema = mongoose.Schema(
  {
    title: String,
    items: [itemSchema],
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    ownerName: String,
    sharedWith: [sharedWithSchema],
    expiresAt: { 
      type: Date,
      default: function() {
        // par défaut la liste expire 30 jours après sa création
        return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      }
    }
  },
  { timestamps: true }
);

// TTL index : supprime automatiquement quand expiresAt < maintenant
shoppingListSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const ShoppingLists = mongoose.model('shoppinglists', shoppingListSchema);

module.exports = ShoppingLists
