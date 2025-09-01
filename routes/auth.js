const express = require('express');
const bcrypt = require('bcrypt');
const uid2 = require('uid2');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { check, validationResult } = require('express-validator');

//models
const User = require('../models/users');
const EmailOtp = require('../models/emailOtp');
const Session = require('../models/session');
const checkToken = require('../middlewares/checkToken');

// Antispam: 3 requêtes / 15 min par IP
const forgotLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });
const requestLimiter = rateLimit({ windowMs: 60_000, max: 5 }); // basique
const loginLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

// importations pour l'OTP (code de verification recu par email)
const { genCode, hash, compare } = require('../utils/otp');
const { sendEmailOtp } = require('../services/mailer');
const { requestEmailOtpFor } = require('../services/emailOtpService');


// importations pour l envoie des mails (reset)
const PasswordReset = require('../models/passwordReset');
const { sendPasswordResetEmail } = require('../services/mailer');

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');


/* Création de la route pour Signup */
router.post(
  '/signup',
  [
    check('email').isEmail().withMessage('Email invalide')
      // on normalise dès la validation pour un flux propre :
      .bail().customSanitizer(v => (v || '').trim().toLowerCase()),
    check('password')
      .isLength({ min: 8 }).withMessage('Le mot de passe doit contenir au moins 8 caractères')
      .matches(/[A-Z]/).withMessage('Le mot de passe doit contenir au moins une lettre majuscule')
      .matches(/[a-z]/).withMessage('Le mot de passe doit contenir au moins une lettre minuscule')
      .matches(/\d/).withMessage('Le mot de passe doit contenir au moins un chiffre')
      .matches(/[\W_]/).withMessage('Le mot de passe doit contenir au moins un caractère spécial'),
    check('username').notEmpty().withMessage('Username requis'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ result: false, errors: errors.array() });
    }

    try {
      const { username, email, password, tokenpush } = req.body; // email déjà normalisé par customSanitizer

      // 1) Unicité username
      const existingUser = await User.findOne({ username });
      if (existingUser) {
        return res.status(400).json({ result: false, message: 'UserName already exists' });
      }

      // 2) Unicité email
      const existingMail = await User.findOne({ email });
      if (existingMail && existingMail.emailVerified) {
        // compte déjà validé → on bloque
        return res.status(400).json({ result: false, message: 'Email already exists' });
      }

      // 3) Crée ou réutilise le compte non vérifié
      const hash = await bcrypt.hash(password, 10);
      let userDoc = existingMail || new User({
        username,
        email,                 // déjà en minuscule
        emailVerified: false,
        password: hash,
        tokenpush
      });

      if (!existingMail) {
        await userDoc.save();
      } else {
        // si tu veux, tu peux MAJ des champs si le compte non vérifié existe déjà
        // (ex: mettre à jour le username si tu autorises)
      }

      // 4) OTP (ne bloque pas le signup si l'envoi échoue)
      let otpTriggered = false;
      try {
        await requestEmailOtpFor(userDoc);
        otpTriggered = true;
      } catch (e) {
        console.error('OTP send failed:', e);
      }

      return res.json({
        result: true,
        username: userDoc.username,
        email: userDoc.email,
        needEmailVerification: true,
        otpTriggered,
        resendAfterSec: 60
      });
    } catch (err) {
      // Gestion propre du doublon DB (course condition)
      if (err?.code === 11000) {
        return res.status(400).json({
          result: false,
          message: 'Nom d’utilisateur ou email déjà utilisé',
        });
      }
      console.error('Signup error:', err);
      return res.status(500).json({ result: false, error: err.message });
    }
  }
);


// route pour ce connecter dans l app
router.post('/signin', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const user = await User.findOne({ email }).select('+password');
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(400).json({ result: false, error: 'Invalid credentials' });
  }
  if (!user.emailVerified) {
    return res.status(400).json({ result: false, error: 'Email not verified' });
  }
  const raw = uid2(64);
  await Session.create({
    userId: user._id,
    tokenHash: await bcrypt.hash(raw, 10),
    tokenFingerprint: sha256(raw),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    device: req.headers['user-agent'] || 'mobile'
  });
  res.json({ result: true, token: raw, username: user.username, role: user.role, email: user.email, myproducts: user.myproducts });
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
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // valable 30 min
    await PasswordReset.create({ userId: user._id, selector, tokenHash, expiresAt });

    // URL vers ton front (web ou universal link)
    const url = new URL('/reset-password', process.env.FRONT_BASE_URL);
    url.searchParams.set('s', selector);
    url.searchParams.set('t', rawToken);
    const resetUrl = url.toString();

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
      return res.status(400).json({ result: false, error: 'Missing parameters' });
    }

    console.log('[RESET] body', { selector, tokenLen: token?.length, newPasswordLen: newPassword?.length });

    // accepte usedAt null OU non défini
    const pr = await PasswordReset.findOne({
      selector,
      $or: [{ usedAt: null }, { usedAt: { $exists: false } }],
      expiresAt: { $gt: new Date() },
    }).select('+tokenHash').sort({ createdAt: -1 });

    console.log('[RESET] found PR?', !!pr, pr && { expiresAt: pr.expiresAt, usedAt: pr.usedAt });

    if (!pr) return res.status(400).json({ result: false, error: 'Token invalid or expired' });

    const ok = await bcrypt.compare(token, pr.tokenHash);
    console.log('[RESET] bcrypt.compare', ok);
    if (!ok) return res.status(400).json({ result: false, error: 'Token invalid or expired' });

    const user = await User.findById(pr.userId).select('+password');
    if (!user) return res.status(400).json({ result: false, error: 'Invalid request' });

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    await Session.deleteMany({ userId: user._id }).catch(() => { });
    pr.usedAt = new Date();
    await pr.save();

    return res.json({ result: true, message: 'Password updated' });
  } catch (e) {
    console.error('[RESET] error', e);
    return res.status(500).json({ result: false, error: 'Server error' });
  }
});




//Endpoint : demande d’OTP (request) Appelé après signup ou depuis un bouton “Renvoyer”.
router.post('/email/verify/request-otp', requestLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, error: 'Missing email' });

  const emailLower = email.trim().toLowerCase();
  const user = await User.findOne({ email: emailLower });
  // Réponse générique (pas d’énumération)
  const generic = { ok: true, message: 'Si le compte est éligible, un code a été envoyé.' };
  if (!user || user.emailVerified) return res.json(generic);

  // Anti-abus simple (cooldown 60s + 5/jour)
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);

  let last = await EmailOtp.findOne({ userId: user._id, purpose: 'verify_email' })
    .sort({ createdAt: -1 });
  if (last) {
    const lastSec = last.lastSentAt ? ((now - last.lastSentAt) / 1000) : 9999;
    if (lastSec < 60) return res.json(generic);
    // reset du compteur quotidien
    const lastDay = (last.lastSentAt || last.createdAt).toISOString().slice(0, 10);
    if (lastDay !== todayKey) last.sentCountDay = 0;
    if (last.sentCountDay >= 5) return res.json(generic);
  }

  // invalider anciens codes non utilisés
  await EmailOtp.updateMany(
    { userId: user._id, purpose: 'verify_email', usedAt: null },
    { $set: { usedAt: new Date() } }
  );

  const code = genCode();
  await EmailOtp.create({
    userId: user._id,
    emailLower,
    purpose: 'verify_email',
    codeHash: await hash(code),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000), //valable 10 min
    attempts: 0,
    lastSentAt: now,
    sentCountDay: last ? Math.min((last.sentCountDay || 0) + 1, 99) : 1,
  });

  await sendEmailOtp({ toEmail: user.email, toName: user.username || '', code });
  return res.json(generic);
});


//Endpoint : confirmation (confirm)
router.post('/email/verify/confirm-otp', async (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) return res.status(400).json({ ok: false });

  const user = await User.findOne({ email });
  const generic = { ok: false, error: 'Code invalide ou expiré' };
  if (!user || user.emailVerified) return res.status(400).json(generic);

  const rec = await EmailOtp.findOne({
    userId: user._id,
    purpose: 'verify_email',
    usedAt: null,
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });
  if (!rec) return res.status(400).json(generic);

  if (rec.attempts >= 5) return res.status(429).json(generic);

  const ok = await compare(code, rec.codeHash);
  if (!ok) {
    await EmailOtp.updateOne({ _id: rec._id }, { $inc: { attempts: 1 } });
    return res.status(400).json(generic);
  }

  // 1) Marquer comme vérifié + consommer l’OTP
  await User.updateOne({ _id: user._id }, { $set: { emailVerified: true, verifiedAt: new Date() } });
  await EmailOtp.updateOne({ _id: rec._id }, { $set: { usedAt: new Date() } });
  await EmailOtp.updateMany(
    { userId: user._id, purpose: 'verify_email', usedAt: null, _id: { $ne: rec._id } },
    { $set: { usedAt: new Date() } }
  );

  // 2) (Optionnel) Auto-signin: créer une session et renvoyer le token
  const rawToken = crypto.randomBytes(48).toString('hex');
  const tokenHash = await bcrypt.hash(rawToken, 10);
  const tokenFingerprint = sha256(rawToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 jours

  await Session.create({
    userId: user._id,
    tokenHash,
    tokenFingerprint,
    expiresAt,
    device: req.get('User-Agent') || 'mobile',
  });

  // Tu peux aussi peupler ce dont le front a besoin au premier affichage
  const u = await User.findById(user._id).select('username email myproducts');

  return res.json({
    ok: true,
    token: rawToken,
    username: u.username,
    email: u.email,
    myproducts: u.myproducts || [],
  });

  // 3) Sinon, comportement actuel
  return res.json({ ok: true });
});

module.exports = router;
