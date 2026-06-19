// routes/planning.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const User = require('../models/users');
const Planning = require('../models/planning');
const { cleanPlanning } = require('../utils/cleanPlanning');
const aiCredits = require('../middlewares/aiCredits');


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


/* ─────────────────────────────────────────────────────────────────────────────
   POST /planning/meal  — Ajoute ou remplace un repas dans un créneau
   body: { weekStart, dayKey, slot, recipeId, recipeTitle, recipeImage? }
───────────────────────────────────────────────────────────────────────────── */
router.post('/meal', async (req, res) => {
  try {
    const userId = req.user._id;
    const { weekStart, dayKey, slot, recipeId, recipeTitle, recipeImage } = req.body;

    if (!weekStart || !dayKey || !slot) {
      return res.status(400).json({ result: false, error: 'weekStart, dayKey et slot sont obligatoires.' });
    }

    let planning = await Planning.findOne({ userId });
    if (!planning) planning = new Planning({ userId, weeks: [] });

    let week = planning.weeks.find(w => w.weekStart === weekStart);
    if (!week) {
      planning.weeks.push({ weekStart, days: {} });
      week = planning.weeks[planning.weeks.length - 1];
    }

    if (typeof week.days.set !== 'function') {
      week.days = new Map(Object.entries(week.days || {}));
    }

    const dayData = week.days.get(dayKey) || { recipes: [], stockItems: [], consumed: false };
    dayData.recipes = dayData.recipes || [];
    dayData.recipes.push({
      _id:        new mongoose.Types.ObjectId(),
      recipeId:   recipeId || null,
      title:      recipeTitle || '',
      image:      recipeImage || null,
      slot,
    });

    week.days.set(dayKey, dayData);
    cleanPlanning(planning, 60);
    planning.markModified('weeks');
    await planning.save();

    req.app.get('io').to(`planning-${userId}`).emit('planning-updated', { weekStart });
    res.json({ result: true });
  } catch (e) {
    console.error('❌ [POST /planning/meal]', e);
    res.status(500).json({ result: false, error: e.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   DELETE /planning/meal  — Retire un repas précis (identifié par mealId)
   body: { weekStart, dayKey, mealId }
───────────────────────────────────────────────────────────────────────────── */
router.delete('/meal', async (req, res) => {
  try {
    const userId = req.user._id;
    const { weekStart, dayKey, mealId } = req.body;

    if (!weekStart || !dayKey || !mealId) {
      return res.status(400).json({ result: false, error: 'weekStart, dayKey et mealId sont obligatoires.' });
    }

    const planning = await Planning.findOne({ userId });
    if (!planning) return res.json({ result: true });

    const week = planning.weeks.find(w => w.weekStart === weekStart);
    if (!week) return res.json({ result: true });

    if (typeof week.days.set !== 'function') {
      week.days = new Map(Object.entries(week.days || {}));
    }

    const dayData = week.days.get(dayKey);
    if (dayData) {
      dayData.recipes = (dayData.recipes || []).filter(r => String(r._id) !== mealId);
      week.days.set(dayKey, dayData);
      planning.markModified('weeks');
      await planning.save();
    }

    req.app.get('io').to(`planning-${userId}`).emit('planning-updated', { weekStart });
    res.json({ result: true });
  } catch (e) {
    console.error('❌ [DELETE /planning/meal]', e);
    res.status(500).json({ result: false, error: e.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /planning/bulk-meals  — Enregistre en lot les repas générés par l'IA
   body: { meals: [{weekStart, dayKey, slot, recipeId, recipeTitle, image?}] }
───────────────────────────────────────────────────────────────────────────── */
router.post('/bulk-meals', async (req, res) => {
  try {
    const userId = req.user._id;
    const { meals } = req.body;

    if (!Array.isArray(meals) || meals.length === 0) {
      return res.status(400).json({ result: false, error: 'meals doit être un tableau non vide.' });
    }

    let planning = await Planning.findOne({ userId });
    if (!planning) planning = new Planning({ userId, weeks: [] });

    // Grouper par weekStart pour traiter chaque semaine une seule fois
    const weekGroups = {};
    for (const meal of meals) {
      if (!weekGroups[meal.weekStart]) weekGroups[meal.weekStart] = [];
      weekGroups[meal.weekStart].push(meal);
    }

    for (const [weekStart, weekMeals] of Object.entries(weekGroups)) {
      let week = planning.weeks.find(w => w.weekStart === weekStart);
      if (!week) {
        planning.weeks.push({ weekStart, days: {} });
        week = planning.weeks[planning.weeks.length - 1];
      }
      if (typeof week.days.set !== 'function') {
        week.days = new Map(Object.entries(week.days || {}));
      }

      for (const meal of weekMeals) {
        const dayData = week.days.get(meal.dayKey) || { recipes: [], stockItems: [], consumed: false };
        // Ne remplace que les anciennes suggestions IA sur ce créneau — laisse intacts les repas ajoutés manuellement
        dayData.recipes = (dayData.recipes || []).filter(r => !(r.slot === meal.slot && r.source === 'ai'));
        dayData.recipes.push({
          _id:        new mongoose.Types.ObjectId(),
          recipeId:   meal.recipeId || null,
          title:      meal.recipeTitle || '',
          image:      meal.image || null,
          slot:       meal.slot,
          source:     'ai',
        });
        week.days.set(meal.dayKey, dayData);
      }
    }

    cleanPlanning(planning, 60);
    planning.markModified('weeks');
    await planning.save();

    // Un seul event pour toutes les semaines traitées — le frontend
    // (usePlanningRealtime) invalide ["planning-full"] sans regarder le
    // contenu de l'event, pas besoin d'un emit par semaine.
    const io = req.app.get('io');
    io.to(`planning-${userId}`).emit('planning-updated');

    res.json({ result: true });
  } catch (e) {
    console.error('❌ [POST /planning/bulk-meals]', e);
    res.status(500).json({ result: false, error: e.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /planning/consume-stock
   body: { items: [{productId, qty}] }
   Déduit des quantités du garde-manger sans dépendance planning.
───────────────────────────────────────────────────────────────────────────── */
router.post('/consume-stock', async (req, res) => {
  try {
    const userId = req.user._id;
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ result: false, error: 'items doit être un tableau non vide.' });
    }

    const user = await User.findById(userId).select('myproducts');
    const byId = new Map((user.myproducts || []).map(p => [String(p._id), p]));

    for (const it of items) {
      const product = byId.get(String(it.productId));
      if (product) {
        product.quantite = Math.max(0, (product.quantite ?? 0) - (it.qty ?? 0));
      }
    }

    await user.save();

    req.app.get('io')
      .to(`planning-${userId}`)
      .emit('stock-updated', { myproducts: user.myproducts });

    res.json({ result: true });
  } catch (e) {
    console.error('❌ [POST /planning/consume-stock]', e);
    res.status(500).json({ result: false, error: e.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /planning/generate  — Génération IA d'un planning anti-gaspillage
   body: { weekStart: string (YYYY-MM-DD), duration?: "1week" | "2weeks" }
   Analyse le garde-manger + les recettes de l'utilisateur et propose
   un dîner par jour en priorisant les aliments proches de leur expiration.
───────────────────────────────────────────────────────────────────────────── */
const { generateUserPlanning } = require('../services/planningGeneration');

router.post('/generate', aiCredits, async (req, res) => {
  try {
    const { weekStart, duration = '1week' } = req.body;

    if (!weekStart) {
      return res.status(400).json({ result: false, error: 'weekStart manquant (format YYYY-MM-DD).' });
    }

    const plan = await generateUserPlanning(req.user._id, weekStart, duration);

    await req.consumeCredit?.();
    res.json({ result: true, plan });
  } catch (err) {
    if (err.message === 'USER_NOT_FOUND') return res.status(404).json({ result: false, error: 'Utilisateur introuvable.' });
    if (err.message === 'NO_RECIPES')     return res.status(400).json({ result: false, error: 'no_recipes' });
    console.error('❌ [POST /planning/generate]', err.message);
    res.status(500).json({ result: false, error: 'Erreur lors de la génération du planning.' });
  }
});

module.exports = router;
