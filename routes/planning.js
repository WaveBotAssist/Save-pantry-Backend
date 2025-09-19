// routes/planning.js
const express = require('express');
const router = express.Router();
const User = require('../models/users');
const Planning = require('../models/planning');
// Chargement de i18next pour la gestion des traductions
const i18next = require('i18next');

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
    const planning = await Planning.findOneAndUpdate(
      { userId: req.user._id },
      { weeks },
      { upsert: true, new: true }//upsert: true "Update or Insert" = si tu ne trouves pas de document, crée-le.
      // new: true, tu demandes à recevoir le document après mise à jour/création
    );
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
    const { items, weekStart, key, consumed, lastKnown } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ result: false, error: 'items doit être un tableau non vide' });
    }

    const planning = await Planning.findOne({ userId: req.user._id });
    if (!planning) return res.status(404).json({ result: false, error: "Planning not found" });

      const week = planning.weeks.find(w => w.weekStart === weekStart);
    if (!week) return res.status(404).json({ result: false, error: "Week not found" });

    const day = week.days.get(key);
    if (!day) return res.status(404).json({ result: false, error: "Day not found" });
    
    // ⚠️ Vérif de conflit
    if (day.consumed !== lastKnown) {
      return res.status(409).json({
        result: false,
        error: "conflictStock"
      });
    }

     console.log(day.consumed)
    const user = await User.findById(userId).select('myproducts');
    if (!user) return res.status(404).json({ result: false, error: 'Utilisateur introuvable' });

    // index des sous-documents par _id (string)
    const byId = new Map(user.myproducts.map(p => [String(p._id), p]));

    // validations
    for (const it of items) {
      if (!it?.productId || typeof it.qty !== 'number' || it.qty <= 0) {
        return res.status(400).json({ result: false, error: 'Chaque item doit avoir productId et qty>0' });
      }
      const sub = byId.get(String(it.productId));
      if (!sub) {
        return res.status(404).json({ result: false, error: `Produit introuvable dans le stock` });
      }
      if ((sub.quantite ?? 0) < it.qty) {
        return res.status(409).json({
          result: false,
          error: i18next.t('insufficientStock')
        })
      }
    }

    // déduction
    for (const it of items) {
      const sub = byId.get(String(it.productId));
      sub.quantite = Math.max(0, (sub.quantite ?? 0) - it.qty);
      // si tu veux, gère aussi un champ "reserved" ici (ex: sub.reserved = Math.max(0, sub.reserved - it.qty))
    }
    console.log(day.consumed)

     // Mise à jour
    day.consumed = consumed;
    await planning.save();
    await user.save();
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
    const { items, weekStart, key, consumed, lastKnown  } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ result: false, error: 'items doit être un tableau non vide' });
    }

    const planning = await Planning.findOne({ userId: req.user._id });
    if (!planning) return res.status(404).json({ result: false, error: "Planning not found" });

      const week = planning.weeks.find(w => w.weekStart === weekStart);
    if (!week) return res.status(404).json({ result: false, error: "Week not found" });

    const day = week.days.get(key);
    if (!day) return res.status(404).json({ result: false, error: "Day not found" });
    
    // ⚠️ Vérif de conflit
    if (day.consumed !== lastKnown) {
      return res.status(409).json({
        result: false,
        error: "conflictStock"
      });
    }

    const user = await User.findById(userId).select('myproducts');
    if (!user) return res.status(404).json({ result: false, error: 'Utilisateur introuvable' });

    const byId = new Map(user.myproducts.map(p => [String(p._id), p]));

    // validations
    for (const it of items) {
      if (!it?.productId || typeof it.qty !== 'number' || it.qty <= 0) {
        return res.status(400).json({ result: false, error: 'Chaque item doit avoir productId et qty>0' });
      }
      const sub = byId.get(String(it.productId));
      if (!sub) {
        return res.status(404).json({ result: false, error: `Produit introuvable dans le stock` });
      }
    }

    // récrédit
    for (const it of items) {
      const sub = byId.get(String(it.productId));
      sub.quantite = (sub.quantite ?? 0) + it.qty;
    }


     // Mise à jour
    day.consumed = consumed;
    await planning.save();
    await user.save();
    return res.json({ result: true, message: 'Stock rétabli (annulation).' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ result: false, error: 'Erreur interne.' });
  }
});

module.exports = router;