const mongoose = require('mongoose');
const sessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'users', index: true, required: true },
  tokenHash: { type: String, required: true },// bcrypt hash pour la vérification
  tokenFingerprint: { type: String, index: true, required: true },//SHA-256 sert a retrouver une session spécifique en base
  deviceId: { type: String, required: true, index: true },//ajouter pour etre sur d avoir une session par appareil et pas de message qu on est deja connecter alors que non a la connexion.
  expiresAt: { type: Date, index: true, required: true },
  device: { type: String, default: 'mobile' },
  createdAt: { type: Date, default: Date.now },
  revokedAt: Date,
});
//Cet index accélère les requêtes où Mongo doit chercher toutes les sessions d’un utilisateur, souvent triées ou filtrées par date d’expiration.
sessionSchema.index({ userId: 1, expiresAt: 1 });
//garder 15 jours les sessions après révocation
sessionSchema.index({ revokedAt: 1 }, { expireAfterSeconds: 15 * 24 * 60 * 60 });

const Session = mongoose.model('sessions', sessionSchema);
module.exports = Session;