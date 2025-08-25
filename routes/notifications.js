const express = require('express');
const User = require('../models/users')
var router = express.Router();

//route pour enregistrer le pushToken pour les notifications dans la base de donnée
router.post('/update-token', async (req, res) => {
  try {
    const updated = await User.updateOne(
      { _id: req.user._id },
      { tokenpush: req.body.tokenpush }
    );
    res.json({ result: true, updated });
  } catch (e) {
    res.status(500).json({ result: false, error: e.message });
  }
});

// route pour mettre à jour les paramètres des notifications rappel peremption et partage listes dans bdd
router.put('/notificationsettings', async (req, res) => {
  const { expiry, share } = req.body;

  const update = {};
  if (expiry) {
    if (typeof expiry.enabled === 'boolean') update['notificationSettings.expiry.enabled'] = expiry.enabled;
    if (typeof expiry.hour === 'number') update['notificationSettings.expiry.hour'] = expiry.hour;
  }
  if (share) {
    if (typeof share.enabled === 'boolean') update['notificationSettings.share.enabled'] = share.enabled;
  }
  try {
    await User.updateOne({ _id: req.user._id }, update);
    res.json({ message: 'Paramètres mis à jour' });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});



module.exports = router;