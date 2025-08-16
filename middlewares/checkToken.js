// middlewares/checkToken.js
const bcrypt = require('bcrypt');
const { sha256 } = require('../utils/session');
const User = require('../models/users');

module.exports = async function checkToken(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const raw = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!raw) return res.status(401).json({ error: 'No token' });

    const fp = sha256(raw);

    const user = await User.findOne({
      tokenFingerprint: fp,
      tokenExpiresAt: { $gt: new Date() }
    }).select('_id username role tokenHash tokenExpiresAt');

    if (!user) return res.status(401).json({ error: 'Invalid or expired token' });

    const ok = await bcrypt.compare(raw, user.tokenHash);
    if (!ok) return res.status(401).json({ error: 'Invalid token' });

    req.user = { _id: user._id, username: user.username, role: user.role };
    next();
  } catch (e) {
    res.status(401).json({ error: 'Auth error' });
  }
};
