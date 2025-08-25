const express = require('express');
const bcrypt = require('bcrypt');
const uid2 = require('uid2');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const router = express.Router();
//models
const User = require('../models/users');
const Session = require('../models/session');
const checkToken = require('../middlewares/checkToken');

// Antispam: 3 requêtes / 15 min par IP
const forgotLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });
const loginLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });
// importations pour l envoie des mails (reset)
const PasswordReset = require('../models/passwordReset');
const { sendPasswordResetEmail } = require('../services/mailer');

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');


router.post('/signin', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const user = await User.findOne({ email }).select('+password');
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(400).json({ result: false, error: 'Invalid credentials' });
  }
  const raw = uid2(64);
  await Session.create({
    userId: user._id,
    tokenHash: await bcrypt.hash(raw, 10),
    tokenFingerprint: sha256(raw),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    device: req.headers['user-agent'] || 'mobile'
  });
  res.json({ result: true, token: raw, username: user.username, role: user.role, email: user.email, myproducts: user.myproducts, });
});

router.post('/logout', checkToken, async (req, res) => {
  const SessionModel = require('../models/session');
  await SessionModel.findByIdAndUpdate(req.sessionId, { $set: { revokedAt: new Date() } });
  res.json({ result: true });
});

router.post('/sessions/renew', checkToken, async (req, res) => {
  const SessionModel = require('../models/session');
  const newExp = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await SessionModel.findByIdAndUpdate(req.sessionId, { $set: { expiresAt: newExp } });
  res.json({ result: true, expiresAt: newExp });
});


// --------- 1) Demander un reset (public) ----------
// /forgot — envoie à l'email de l'utilisateur
router.post('/forgot-password', forgotLimiter, async (req, res) => {
  const email = (req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ result: false, error: 'Missing email' });

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.json({ result: false, message: "Email pas existant ou erreur de frape" })
    }


    const rawToken = crypto.randomBytes(32).toString('hex');
    const selector = crypto.randomBytes(9).toString('hex'); // ~72 bits
    const tokenHash = await bcrypt.hash(rawToken, 10);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min
    await PasswordReset.create({ userId: user._id, selector, tokenHash, expiresAt });

    // URL vers ton front (web ou universal link)
    const url = new URL('/reset-password', process.env.FRONT_BASE_URL);
    url.searchParams.set('s', selector);
    url.searchParams.set('t', rawToken);
    const resetUrl = url.toString();
    // const resetUrl = `savepantry://reset-password?s=${selector}&t=${rawToken}`;

    //utilisation de la fonction pour envoyer le mail dans services/mailer.js
    await sendPasswordResetEmail({
      toEmail: user.email,
      toName: user.username || '',
      resetUrl,
    });
    res.json({ result: true, message: "Un email de réinitialisation a été envoyé." })

  } catch (e) {
    // On ne révèle rien au client, mais on log pour debug serveur
    console.error('Mailjet API error (forgot):', e?.message || e);
    // On renvoie quand même la réponse générique
  }

});

// --------- 2) Effectuer le reset (public) ----------
router.post('/reset', async (req, res) => {
  try {
    const { selector, token, newPassword } = req.body || {};
    if (!selector || !token || !newPassword) {
      return res.status(400).json({ result:false, error:'Missing parameters' });
    }

    console.log('[RESET] body', { selector, tokenLen: token?.length, newPasswordLen: newPassword?.length });

    // accepte usedAt null OU non défini
    const pr = await PasswordReset.findOne({
      selector,
      $or: [{ usedAt: null }, { usedAt: { $exists: false } }],
      expiresAt: { $gt: new Date() },
    }).select('+tokenHash').sort({ createdAt: -1 });

    console.log('[RESET] found PR?', !!pr, pr && { expiresAt: pr.expiresAt, usedAt: pr.usedAt });

    if (!pr) return res.status(400).json({ result:false, error:'Token invalid or expired' });

    const ok = await bcrypt.compare(token, pr.tokenHash);
    console.log('[RESET] bcrypt.compare', ok);
    if (!ok) return res.status(400).json({ result:false, error:'Token invalid or expired' });

    const user = await User.findById(pr.userId).select('+password');
    if (!user) return res.status(400).json({ result:false, error:'Invalid request' });

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    await Session.deleteMany({ userId: user._id }).catch(()=>{});
    pr.usedAt = new Date();
    await pr.save();

    return res.json({ result:true, message:'Password updated' });
  } catch (e) {
    console.error('[RESET] error', e);
    return res.status(500).json({ result:false, error:'Server error' });
  }
});

module.exports = router;
