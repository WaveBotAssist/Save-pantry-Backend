// ce middleware prolonge la durée de vie de la session si elle expire dans moins de 24h
const Session = require('../models/session');
module.exports = async function slideSession(req, res, next) {
  try {
    if (!req.sessionId) return next();
    const s = await Session.findById(req.sessionId).select('expiresAt');
    if (s && (s.expiresAt.getTime() - Date.now() < 24*60*60*1000)) {
      await Session.findByIdAndUpdate(req.sessionId, {
        $set: { expiresAt: new Date(Date.now() + 7*24*60*60*1000) }
      });
    }
  } catch (err) {
    console.error('slideSession error:', err);
  }
  next();
};
