
// utils/session.js est utiliser dans routes/users.js et sert a hacher le token de session pour protéger les sessions des utilisateurs
// et à créer une session pour un utilisateur avec un token qui expire après un certain temps
const uid2 = require('uid2');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

async function createSessionForUser(user, ttlDays = 7) {
  const rawToken = uid2(64);
  const tokenHash = await bcrypt.hash(rawToken, 10);
  const tokenFingerprint = sha256(rawToken);
  const tokenExpiresAt = new Date(Date.now() + ttlDays*24*60*60*1000);
  Object.assign(user, { tokenHash, tokenFingerprint, tokenExpiresAt });
  await user.save();
  return rawToken; // à renvoyer au client (Authorization: Bearer <rawToken>)
}

module.exports = { sha256, createSessionForUser };
