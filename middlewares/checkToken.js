const bcrypt = require('bcrypt');
const crypto = require('crypto');
const Session = require('../models/session');
const User = require('../models/users');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

module.exports = async function checkToken(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const raw = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!raw) return res.status(401).json({ error: 'No token' });

    const session = await Session.findOne({
      tokenFingerprint: sha256(raw),
      expiresAt: { $gt: new Date() },
      $or: [{ revokedAt: { $exists: false } }, { revokedAt: null }]
    }).select('userId tokenHash expiresAt');

    // gérer le cas de session révoquée ou supprimée
    if (!session) {
      // 🔁 Cas 1 : session supprimée (autre appareil, logout, etc.)
      return res.status(401).json({
        result: false,
        code: 'SESSION_REVOKED',
        message: 'Session révoquée ou utilisée sur un autre appareil.',
      });
    }
    // gérer le cas d expiration de la session
    if (session.expiresAt < new Date()) {
      // ⏰ Cas 2 : session expirée naturellement
      await Session.deleteOne({ _id: session._id }); // 🧹 Nettoie la session expirée
      return res.status(401).json({
        result: false,
        code: 'SESSION_EXPIRED',
        message: 'Votre session a expiré. Veuillez vous reconnecter.',
      });
    }

    const ok = await bcrypt.compare(raw, session.tokenHash);// comparer le token reçu avec le hash en bdd dans la session
    if (!ok) return res.status(401).json({ error: 'Invalid token' });

    const user = await User.findById(session.userId).select('_id username role isPremium');
    if (!user) return res.status(401).json({ error: 'User not found' });

    // Si l'utilisateur n'est pas premium, on révoque les autres sessions actives
    if (user && !user.isPremium) {
      const activeSessions = await Session.find({
        userId: user._id,
        revokedAt: null,
        expiresAt: { $gt: new Date() }
      });

      if (activeSessions.length > 1) {
        // 🧹 Supprime toutes les autres sessions sauf celle actuelle
        await Session.deleteMany({
          userId: user._id,
          _id: { $ne: session._id },
        });
      }
    }

    req.user = user;
    req.sessionId = session._id;
    next();// passer le contrôle à la fonction middleware suivante
  } catch {
    res.status(401).json({ error: 'Auth error' });
  }
};

