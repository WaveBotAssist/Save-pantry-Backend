// routes/planning.js
const express = require('express');
const router = express.Router();
const User = require('../models/users');
const Planning = require('../models/planning');
// Chargement de i18next pour la gestion des traductions
const i18next = require('i18next');
//import de la function pour purger le planning d un utilisateur apres un certain temps
const { cleanPlanning } = require('../utils/cleanPlanning');


// Récupérer le planning de l’utilisateur
router.get('/', async (req, res) => {
  try {
    const planning = await Planning.findOne({ userId: req.user._id });
    res.json({ result: true, planning });
  } catch (e) {
    res.status(500).json({ result: false, error: e.message });
  }
});



// Sauvegarder / mettre à jour le planning
router.post('/', async (req, res) => {
  try {
    const { weeks } = req.body;
    let planning = await Planning.findOne({ userId: req.user._id });
    if (!planning) {
      planning = new Planning({ userId: req.user._id, weeks });
    } else {
      planning.weeks = weeks;
    }

    // 🧹 Purge ici
    cleanPlanning(planning, 60);

    await planning.save();
    res.json({ result: true, planning });
  } catch (e) {
    res.status(500).json({ result: false, error: e.message });
  }
});


// Déduire des quantités planifiées du stock de l'utilisateur
// Body attendu: { items: [{ productId: "<_id du myproduct>", qty: 2 }, ...] }

router.post('/inventory/consume', async (req, res) => {
  try {
    const userId = req.user._id;
    const { items, weekStart, key } = req.body;

    // Vérif rapide
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ result: false, error: 'items doit être un tableau non vide' });
    }

    // 1️⃣ Mettre à jour les quantités
    for (const it of items) {
      const qty = Math.abs(Number(it.qty));
      await User.updateOne(
        { _id: userId, "myproducts._id": it.productId },
        { $inc: { "myproducts.$.quantite": -qty } }
      );
    }
    // 2️⃣ Mettre consumed = true dans le planning
    await Planning.updateOne(
      { userId, "weeks.weekStart": weekStart },
      { $set: { [`weeks.$.days.${key}.consumed`]: true } }
    );

    return res.json({ result: true, message: 'Stock mis à jour (consommation).' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ result: false, error: 'Erreur interne.' });
  }
});


// Annuler la déduction (récréditer les quantités)
// Body attendu: { items: [{ productId: "<_id du myproduct>", qty: 2 }, ...] }
router.post('/inventory/undo', async (req, res) => {
  try {
    const userId = req.user._id;
    const { items, weekStart, key } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ result: false, error: 'items doit être un tableau non vide' });
    }

    // 1️⃣ Récréditer les quantités
    for (const it of items) {
      const qty = Math.abs(Number(it.qty));
      await User.updateOne(
        { _id: userId, "myproducts._id": it.productId},
        { $inc: { "myproducts.$.quantite": qty } }
      );
    }

    // 2️⃣ Mettre consumed = false dans le planning
    await Planning.updateOne(
      { userId, "weeks.weekStart": weekStart },
      { $set: { [`weeks.$.days.${key}.consumed`]: false } }
    );

    return res.json({ result: true, message: 'Stock rétabli (annulation).' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ result: false, error: 'Erreur interne.' });
  }
});


module.exports = router;