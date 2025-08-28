// models/emailOtp.js
const mongoose = require('mongoose');

const emailOtpSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'users', index: true, required: true },
  emailLower: { type: String, required: true, index: true },
  purpose:    { type: String, enum: ['verify_email'], required: true },
  codeHash:   { type: String, required: true },
  expiresAt:  { type: Date,   required: true },
  usedAt:     { type: Date,   default: null },
  attempts:   { type: Number, default: 0 }, // C’est un compteur du nombre d’essais qu’un utilisateur a fait avec ce code OTP.

  // anti-abus (optionnel mais utile)
  lastSentAt:   { type: Date },
  sentCountDay: { type: Number, default: 0 }, // reset quotidien côté code si jour change
}, { timestamps: true });

// suppression automatique à expiration
emailOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('EmailOtp', emailOtpSchema);
