var express = require('express');
var router = express.Router();
const bcrypt = require('bcrypt');
const checkToken = require('../middlewares/checkToken');
const User = require('../models/users')
const { check, validationResult } = require('express-validator');
const { createSessionForUser } = require('../utils/session');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const nodemailer = require('nodemailer')
const updateProductPrice = require('../modules/updateProductPrice')

//limiter les tentatives de connexion avec rateLimit
const loginLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 10 minutes
  max: 10, // Limite à 10 tentatives
  message: 'Trop de tentatives de connexion. Réessayez plus tard.',
});


/* Création de la route pour Signup */
router.post(
  '/signup',
  [
    // Middleware de validation des entrées utilisateur
    check('email')
      .isEmail().withMessage('Email invalide'),
    check('password')
      .isLength({ min: 8 }).withMessage('Le mot de passe doit contenir au moins 8 caractères')
      .matches(/[A-Z]/).withMessage('Le mot de passe doit contenir au moins une lettre majuscule')
      .matches(/[a-z]/).withMessage('Le mot de passe doit contenir au moins une lettre minuscule')
      .matches(/\d/).withMessage('Le mot de passe doit contenir au moins un chiffre')
      .matches(/[\W_]/).withMessage('Le mot de passe doit contenir au moins un caractère spécial'),
  ],
  async (req, res) => {
    // Vérification des erreurs de validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ result: false, errors: errors.array() });
    }

    try {
      // Vérifie si username existe déjà dans la base de données
      const existingUser = await User.findOne({ username: req.body.username })
      if (existingUser) {
        return res.status(400).json({ result: false, message: 'UserName already exists' });
      }
      // Vérifie si l'email existe déjà dans la base de données
      const existingMail = await User.findOne({ email: req.body.email });

      if (existingMail) {
        return res.status(400).json({ result: false, message: 'Email already exists' });
      }

      // Création du hash du mot de passe
      const hash = bcrypt.hashSync(req.body.password, 10);

      // Création d'un nouvel utilisateur
      const newUser = new User({
        username: req.body.username,
        email: req.body.email,
        password: hash,
        tokenpush: req.body.tokenpush
      });
      const rawToken = await createSessionForUser(newUser); // crée tokenHash+fingerprint+expires
      // Sauvegarde de l'utilisateur dans la base de données
      await newUser.save();

      res.json({ result: true, token: rawToken, username: newUser.username });
    } catch (err) {
      if (err.code === 11000) {
        // Doublon détecté par MongoDB
        return res.status(400).json({
          result: false,
          message: 'Nom d’utilisateur ou email déjà utilisé',
        });
      }
      res.status(500).json({ result: false, error: err.message });
    }
  }
);

//création de la route pour ce connecter
router.post("/signin", loginLimiter, async (req, res) => {
  try {
    const { email, password, tokenpush } = req.body;

    // Vérifie si l'utilisateur existe
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({ result: false, error: "User not found" });
    }

    // Vérifie le mot de passe
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ result: false, error: "Wrong password" });

    // Vérifie si le tokenpush a changé, et le met à jour si nécessaire
    if (tokenpush && user.tokenpush !== tokenpush) {
      user.tokenpush = tokenpush;
      await user.save();
      console.log("Push token mis à jour !");
    }

    // 🔄 rotation de session
    const rawToken = await createSessionForUser(user); // maj tokenHash/fingerprint/expire

    // Réponse unique
    res.json({
      result: true,
      username: user.username,
      token: rawToken,
      email: user.email,
      myproducts: user.myproducts,
      role: user.role,
    });

  } catch (err) {
    res.status(500).json({ result: false, error: err.message });
  }
});




//  route pour préremplir le formulaire de l user avec ses préférences actuelles
router.get('/me', checkToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('email notificationSettings');
    if (!user) return res.status(404).json({ message: "Utilisateur non trouvé" });

    res.json({
      email: user.email,
      notificationSettings: {
        expiry: {
          enabled: user.notificationSettings?.expiry?.enabled ?? false,
          hour: user.notificationSettings?.expiry?.hour ?? 9,
        },
        share: {
          enabled: user.notificationSettings?.share?.enabled ?? false,
        }
      }
    });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

// route pour supprimer un compte utilisateur dans le screen profil
router.delete('/deleteUser', checkToken, async (req, res) => {
  const { _id } = req.user;
  if (!_id) {
    return res.status(400).json({ result: false, error: "ID utilisateur manquant" });
  }
  try {
    // Supprimer l'utilisateur de la base de données
    await User.findByIdAndDelete(_id)
    res.json({ result: true, message: "Compte utilisateur supprimé avec succès" });
  } catch (err) {
    return res.status(500).json({ result: false, error: err.message });
  }

})

// route pour modifier le choix de l utilisateur pour la langue de l application pour le cron de notification
router.put('/updateLanguage', checkToken, async (req, res) => {
  const { language } = req.body;
  const userId = req.user._id;

  if (!['fr', 'en'].includes(language)) {
    return res.status(400).json({ error: 'Langue non prise en charge' });
  }

  await User.findByIdAndUpdate(userId, { language });
  res.json({ result: true, message: 'Langue mise à jour' });
});


//cron
cron.schedule("0 0 * * *", async () => {
  console.log("🔄 Mise à jour des prix en cours...");

  try {
    // 1️⃣ Récupérer tous les codes-barres distincts
    const users = await User.find({}, { "myproducts.codebarre": 1 });
    const uniqueCodebarres = [...new Set(users.flatMap(user => user.myproducts.map(p => p.codebarre)))];

    console.log(`🔍 Codes-barres trouvés :`, uniqueCodebarres);

    // 2️⃣ Mettre à jour chaque produit
    for (const codebarre of uniqueCodebarres) {
      await updateProductPrice(codebarre);
    }

  } catch (err) {
    console.error("❌ Erreur dans le cron job :", err.message);
  }
});

module.exports = router;
