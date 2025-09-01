var express = require('express');
var router = express.Router();
const checkToken = require('../middlewares/checkToken');
const User = require('../models/users')
const cron = require('node-cron');

const updateProductPrice = require('../modules/updateProductPrice')


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


//cron pour mettre a jour les prix des produits
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
