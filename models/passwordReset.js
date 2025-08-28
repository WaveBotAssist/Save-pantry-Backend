// models/passwordReset.js
const mongoose = require('mongoose');
// selector = = comme un numéro de ticket pour retrouver l’entrée. token = comme la clé secrète associée à ce ticket.
const passwordResetSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, index: true, required: true },
  selector: { type: String, required: true, index: true }, // ← AJOUT ICI
  tokenHash: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true},
  usedAt: { type: Date },
}, { timestamps: true });

// TTL automatique sur expiresAt (supprime après expiration)
passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PasswordReset', passwordResetSchema);
