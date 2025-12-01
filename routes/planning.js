const express = require('express');
const router = express.Router();
const User = require('../models/users');
const Planning = require('../models/planning');
const i18next = require('i18next');
const { cleanPlanning } = require('../utils/cleanPlanning');

/* ------------------------------------------------------------
   Utils : convert Mongoose Map -> plain JS object
------------------------------------------------------------ */
function convertWeek(week) {
  return {
    weekStart: week.weekStart,
    days: Object.fromEntries(
      Array.from(week.days.entries()).map(([key, value]) => [
        key,
        value.toObject ? value.toObject() : value
      ])
    )
  };
}

/* ------------------------------------------------------------
   GET /planning
------------------------------------------------------------ */
router.get('/', async (req, res) => {
  try {
    const planning = await Planning.findOne({ userId: req.user._id });

    if (!planning)
      return res.json({ result: true, planning: { weeks: [] } });

    const cleanWeeks = planning.weeks.map(convertWeek);

    res.json({ result: true, planning: { weeks: cleanWeeks } });

  } catch (e) {
    res.status(500).json({ result: false, error: e.message });
  }
});

/* ------------------------------------------------------------
   POST /planning (save) + Socket.IO sync
------------------------------------------------------------ */
router.post('/', async (req, res) => {
  try {
    const { weeks } = req.body;

    let planning = await Planning.findOne({ userId: req.user._id });

    if (!planning) {
      planning = new Planning({ userId: req.user._id, weeks });
    } else {
      planning.weeks = weeks;
    }

    cleanPlanning(planning, 60);
    await planning.save();

    // 🔥 Notify all devices of this user
    req.app.get('io')
      .to(`planning-${req.user._id}`)
      .emit("planning-updated");

    res.json({ result: true, planning });

  } catch (e) {
    res.status(500).json({ result: false, error: e.message });
  }
});

/* ------------------------------------------------------------
   POST /inventory/consume
------------------------------------------------------------ */
router.post('/inventory/consume', async (req, res) => {
  try {
    const userId = req.user._id;
    const { items, weekStart, key, consumed, lastKnown } = req.body;

    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ result: false, error: 'items doit être un tableau non vide' });

    const planning = await Planning.findOne({ userId });
    if (!planning) return res.status(404).json({ result: false, error: "Planning not found" });

    const week = planning.weeks.find(w => w.weekStart === weekStart);
    if (!week) return res.status(404).json({ result: false, error: "Week not found" });

    const day = week.days.get(key);
    if (!day) return res.status(404).json({ result: false, error: "Day not found" });

    if (day.consumed !== lastKnown) {
      return res.status(409).json({ result: false, error: "conflictStock" });
    }

    const user = await User.findById(userId).select('myproducts');
    const byId = new Map(user.myproducts.map(p => [String(p._id), p]));

    // Validate stock
    for (const it of items) {
      const sub = byId.get(String(it.productId));
      if (!sub)
        return res.status(404).json({ result: false, error: 'Produit introuvable dans le stock' });

      if ((sub.quantite ?? 0) < it.qty)
        return res.status(409).json({ result: false, error: i18next.t('insufficientStock') });
    }

    // Apply consumption
    for (const it of items) {
      const sub = byId.get(String(it.productId));
      sub.quantite = Math.max(0, (sub.quantite ?? 0) - it.qty);
    }

    day.consumed = consumed;

    await planning.save();
    await user.save();

    // 🔥 Notify all devices
    req.app.get('io')
      .to(`planning-${req.user._id}`)
      .emit("planning-updated");

    res.json({ result: true, message: 'Stock mis à jour (consommation).' });

  } catch (e) {
    res.status(500).json({ result: false, error: 'Erreur interne.' });
  }
});

/* ------------------------------------------------------------
   POST /inventory/undo
------------------------------------------------------------ */
router.post('/inventory/undo', async (req, res) => {
  try {
    const userId = req.user._id;
    const { items, weekStart, key, consumed, lastKnown } = req.body;

    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ result: false, error: 'items doit être un tableau non vide' });

    const planning = await Planning.findOne({ userId });
    if (!planning) return res.status(404).json({ result: false, error: "Planning not found" });

    const week = planning.weeks.find(w => w.weekStart === weekStart);
    if (!week) return res.status(404).json({ result: false, error: "Week not found" });

    const day = week.days.get(key);
    if (!day) return res.status(404).json({ result: false, error: "Day not found" });

    if (day.consumed !== lastKnown) {
      return res.status(409).json({ result: false, error: "conflictStock" });
    }

    const user = await User.findById(userId).select('myproducts');
    const byId = new Map(user.myproducts.map(p => [String(p._id), p]));

    // Refund quantities
    for (const it of items) {
      const sub = byId.get(String(it.productId));
      if (!sub)
        return res.status(404).json({ result: false, error: 'Produit introuvable dans le stock' });

      sub.quantite = (sub.quantite ?? 0) + it.qty;
    }

    day.consumed = consumed;

    await planning.save();
    await user.save();

    // 🔥 Notify all devices
    req.app.get('io')
      .to(`planning-${req.user._id}`)
      .emit("planning-updated");

    res.json({ result: true, message: 'Stock rétabli (annulation).' });

  } catch (e) {
    res.status(500).json({ result: false, error: 'Erreur interne.' });
  }
});

module.exports = router;
