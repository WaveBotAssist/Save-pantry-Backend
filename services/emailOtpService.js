// services/emailOtpService.js
const EmailOtp = require('../models/emailOtp');
const { genCode, hash } = require('../utils/otp');
const { sendEmailOtp } = require('./mailer');

//cette fonction génère un code 6 chiffres, applique l’anti-abus (cooldown + quota/jour), invalide les anciens codes, stocke le nouveau (hash + TTL), et envoie l’email.
async function requestEmailOtpFor(
  user,
  { purpose = 'verify_email', cooldownSec = 60, maxPerDay = 5, ttlMin = 10 } = {}
) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // Dernier OTP pour ce user
  const last = await EmailOtp.findOne({ userId: user._id, purpose }).sort({ createdAt: -1 });

  // Cooldown + quota/jour
  if (last) {
    const since = last.lastSentAt ? (now - last.lastSentAt) / 1000 : 9999;
    if (since < cooldownSec) return { ok: true, throttled: true };

    const lastDay = (last.lastSentAt || last.createdAt).toISOString().slice(0, 10);
    const dayCount = lastDay === today ? (last.sentCountDay || 0) : 0;
    if (dayCount >= maxPerDay) return { ok: true, throttled: true };
  }

  // Invalider anciens codes non utilisés
  await EmailOtp.updateMany(
    { userId: user._id, purpose, usedAt: null },
    { $set: { usedAt: now } }
  );

  const code = genCode();

  await EmailOtp.create({
    userId: user._id,
    emailLower: (user.email || '').trim().toLowerCase(),
    purpose,
    codeHash: await hash(code),
    expiresAt: new Date(now.getTime() + ttlMin * 60 * 1000),
    attempts: 0,
    lastSentAt: now,
    sentCountDay:
      last && (last.lastSentAt || last.createdAt).toISOString().slice(0, 10) === today
        ? Math.min((last.sentCountDay || 0) + 1, 99)
        : 1,
  });

  await sendEmailOtp({ toEmail: user.email, toName: user.username || '', code });

  return { ok: true };
}

module.exports = { requestEmailOtpFor };
