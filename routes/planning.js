// routes/planning.js
const express = require('express');
const router = express.Router();
const User = require('../models/users');
const Planning = require('../models/planning');
const i18next = require('i18next');
const { cleanPlanning } = require('../utils/cleanPlanning');


/* ------------------------------------------------------------
   GET /planning  → renvoie tout le planning de l'utilisateur
------------------------------------------------------------ */
router.get('/', async (req, res) => {
  try {
    // .lean() renvoie un objet JS simple
    const planning = await Planning.findOne({ userId: req.user._id }).lean();

    if (!planning) {
      return res.json({ result: true, planning: { weeks: [] } });
    }

    // planning.weeks est déjà un tableau d’objets JS
    const cleanWeeks = planning.weeks.map(week => ({
      weekStart: week.weekStart,
      // week.days est déjà un objet classique (clés = Monday, Tuesday...)
      days: week.days || {},
    }));

    res.json({ result: true, planning: { weeks: cleanWeeks } });
  } catch (e) {
    console.error('❌ [GET /planning] Error:', e);
    res.status(500).json({ result: false, error: e.message });
  }
});

/* ------------------------------------------------------------
   POST /planning/day  → upsert d'un seul jour
   body: { weekStart, dayKey, day }
   day = { recipes: [], stockItems: [], consumed: bool }
------------------------------------------------------------ */
router.post('/day', async (req, res) => {
  try {
    const userId = req.user._id;
    const { weekStart, dayKey, day } = req.body;

    if (!weekStart || !dayKey || !day) {
      return res.status(400).json({
        result: false,
        error: 'weekStart, dayKey et day sont obligatoires',
      });
    }

    let planning = await Planning.findOne({ userId });

    // Si aucun planning → on en crée un
    if (!planning) {
      planning = new Planning({
        userId,
        weeks: [],
      });
    }

    // Chercher la semaine dans le tableau
    let week = planning.weeks.find(w => w.weekStart === weekStart);

    // Si pas de semaine → on la crée proprement pour Mongoose
    if (!week) {
      planning.weeks.push({
        weekStart,
        days: {}, // Mongoose va caster en Map automatiquement
      });
      week = planning.weeks[planning.weeks.length - 1];
    }

    // ⚠️ ici, week.days est un MongooseMap (ou va le devenir)
    // On s’assure d’avoir bien une instance utilisable en .set()
    // Normalement week.days a déjà une méthode .set
    if (typeof week.days.set !== "function") {
      // au cas où, fallback vers un objet simple
      week.days = new Map(Object.entries(week.days || {}));
    }

    // Upsert du jour dans la Map
    week.days.set(dayKey, {
      recipes: day.recipes || [],
      stockItems: day.stockItems || [],
      consumed: !!day.consumed,
    });

    // Nettoyage éventuel du planning (fonction existante)
    cleanPlanning(planning, 60);

    // On marque le champ comme modifié pour être sûr que Mongoose le persiste
    planning.markModified('weeks');
    await planning.save();

    // Notifier tous les devices de cet utilisateur
    req.app.get('io')
      .to(`planning-${userId}`)
      .emit('planning-updated', { weekStart });

    // On renvoie juste la semaine mise à jour (optionnel pour le front)
    res.json({ result: true, weekStart, dayKey });

  } catch (e) {
    console.error('❌ [POST /planning/day] Error:', e);
    res.status(500).json({ result: false, error: e.message });
  }
});

/* ------------------------------------------------------------
   POST /planning/inventory/consume
------------------------------------------------------------ */
router.post('/inventory/consume', async (req, res) => {
  try {
    const userId = req.user._id;
    const { items, weekStart, key, consumed, lastKnown } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ result: false, error: 'items doit être un tableau non vide' });
    }

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

    // 🆕 Valider le stock ET collecter les manques
    const missingItems = [];
    
    for (const it of items) {
      const sub = byId.get(String(it.productId));
      if (!sub) {
        return res.status(404).json({ result: false, error: 'Produit introuvable dans le stock' });
      }

      const available = sub.quantite ?? 0;
      const needed = it.qty;
      
      if (available < needed) {
        // 🔥 Collecter les détails du manque
        missingItems.push({
          productId: String(it.productId),
          name: sub.name,
          unit: sub.unit,
          image: sub.image,
          available: available,
          needed: needed,
          missing: needed - available
        });
      }
    }

    // 🔥 Si des produits manquent, renvoyer les détails
    if (missingItems.length > 0) {
      return res.status(409).json({ 
        result: false, 
        error: 'insufficientStock',
        missingItems: missingItems  // 🔥 Nouveau champ
      });
    }

    // Sauvegarder un snapshot des quantités AVANT consommation
    const stockSnapshot = items.map(it => ({
      productId: it.productId,
      quantityBefore: byId.get(String(it.productId)).quantite
    }));

    // Apply consumption
    for (const it of items) {
      const sub = byId.get(String(it.productId));
      sub.quantite = Math.max(0, (sub.quantite ?? 0) - it.qty);
    }

    day.consumed = consumed;
    day.stockSnapshot = stockSnapshot;

    planning.markModified('weeks');
    await planning.save();
    await user.save();

    // Notifier tous les appareils du changement de planning ET de stock
    const io = req.app.get('io');
    io.to(`planning-${userId}`).emit("planning-updated", { weekStart });
    io.to(`planning-${userId}`).emit("stock-updated", { 
      myproducts: user.myproducts 
    });

    res.json({ result: true, message: 'Stock mis à jour (consommation).' });
  } catch (e) {
    console.error('❌ [POST /planning/inventory/consume] Error:', e);
    res.status(500).json({ result: false, error: 'Erreur interne.' });
  }
})

/* ------------------------------------------------------------
   POST /planning/inventory/undo
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

   planning.markModified('weeks');
    await planning.save();
    await user.save();

    // Notifier tous les appareils du changement de planning ET de stock
    const io = req.app.get('io');
    io.to(`planning-${userId}`).emit("planning-updated", { weekStart });
    io.to(`planning-${userId}`).emit("stock-updated", { 
      myproducts: user.myproducts 
    });

    res.json({ result: true, message: 'Stock rétabli (annulation).' });

  } catch (e) {
    console.error('❌ [POST /planning/inventory/undo] Error:', e);
    res.status(500).json({ result: false, error: 'Erreur interne.' });
  }
});

module.exports = router;
