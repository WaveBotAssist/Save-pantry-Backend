const bcrypt = require('bcrypt');
const crypto = require('crypto');
const Session = require('../models/session');
const User = require('../models/users');

// Fonction utilitaire : crée un hash SHA256 pour fingerprint du token
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

module.exports = async function checkToken(req, res, next) {
  try {
    // ---------------------------------------------------------
    // 1️⃣ RÉCUPÉRATION DU TOKEN
    // ---------------------------------------------------------
    const auth = req.headers.authorization || '';
    const raw = auth.startsWith('Bearer ') ? auth.slice(7) : null;

    if (!raw) {
      return res.status(401).json({ error: 'No token' });
    }

    // ---------------------------------------------------------
    // 2️⃣ RECHERCHE DE LA SESSION LIÉE AU TOKEN
    // ---------------------------------------------------------
    const session = await Session.findOne({
      tokenFingerprint: sha256(raw),
      expiresAt: { $gt: new Date() },
      $or: [{ revokedAt: { $exists: false } }, { revokedAt: null }]
    }).select('userId tokenHash expiresAt deviceId');

    if (!session) {
      return res.status(401).json({
        result: false,
        code: 'SESSION_REVOKED',
        message: 'Session révoquée.',
      });
    }

    // ---------------------------------------------------------
    // 3️⃣ GESTION DE LA SESSION EXPIRÉE
    // ---------------------------------------------------------
    if (session.expiresAt < new Date()) {
      await Session.deleteOne({ _id: session._id });
      return res.status(401).json({
        result: false,
        code: 'SESSION_EXPIRED',
        message: 'Session expirée.',
      });
    }

    // ---------------------------------------------------------
    // 4️⃣ VÉRIFICATION DU TOKEN VIA BCRYPT
    // ---------------------------------------------------------
    const ok = await bcrypt.compare(raw, session.tokenHash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // ---------------------------------------------------------
    // 5️⃣ RÉCUPÉRATION DES DONNÉES UTILISATEUR
    // ---------------------------------------------------------
    const user = await User.findById(session.userId)
      .select('_id role isPremium revenuecatId');

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // ---------------------------------------------------------
    // 6️⃣ RENOUVELLEMENT AUTO DE LA SESSION (sliding expiration)
    // ---------------------------------------------------------
    session.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await session.save();

    
    // ---------------------------------------------------------
    // 7️⃣ GESTION INTELLIGENTE DES SESSIONS MULTIPLES
    // Avec protection contre la suppression pendant l'achat
    // ---------------------------------------------------------
    if (!user.isPremium) {
      // Compter les sessions actives
      const activeSessions = await Session.find({
        userId: user._id,
        revokedAt: null,
        expiresAt: { $gt: new Date() }
      }).sort({ updatedAt: -1 }); // Trier par dernière utilisation

      // Si plus d'une session active → on garde uniquement la session courante
      if (activeSessions.length > 1) {
        console.log(`⚠️ User ${user._id} (non-premium) a ${activeSessions.length} sessions actives`);

        // Notifie uniquement les appareils différents — évite d'envoyer
        // session-revoked à l'appareil courant qui aurait une ancienne session en base
        const io = req.app.get('io');
        if (io) {
          for (const s of activeSessions) {
            if (s._id.toString() !== session._id.toString() && s.deviceId && s.deviceId !== session.deviceId) {
              io.to(`device-${s.deviceId}`).emit('session-revoked');
            }
          }
        }

        await Session.deleteMany({
          userId: user._id,
          _id: { $ne: session._id },
        });

        console.log(`🧹 Sessions supprimées pour user ${user._id} (non-premium)`);
      }
    } else {
      console.log(`✅ User ${user._id} est premium, sessions multiples autorisées`);
    }

    // ---------------------------------------------------------
    // 8️⃣ INJECTION DES INFOS POUR LES ROUTES PROTÉGÉES
    // ---------------------------------------------------------
    req.user = user;
    req.sessionId = session._id;

    next();

  } catch (error) {
    console.error('❌ Erreur checkToken:', error);
    res.status(401).json({ error: 'Auth error' });
  }
};