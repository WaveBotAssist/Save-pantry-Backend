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

    if (!session) return res.status(401).json({ error: 'Invalid or expired token' });
    const ok = await bcrypt.compare(raw, session.tokenHash);
    if (!ok) return res.status(401).json({ error: 'Invalid token' });

    const user = await User.findById(session.userId).select('_id username role');
    if (!user) return res.status(401).json({ error: 'User not found' });

    req.user = user;
    req.sessionId = session._id;
    next();// passer le contrôle à la fonction middleware suivante
  } catch {
    res.status(401).json({ error: 'Auth error' });
  }
};

