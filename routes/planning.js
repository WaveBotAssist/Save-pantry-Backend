// routes/planning.js
const express = require('express');
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
    dayData.recipes = (dayData.recipes || []).filter(r => r.slot !== slot);
    dayData.recipes.push({ recipeId: recipeId || null, title: recipeTitle || '', slot });

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
   DELETE /planning/meal  — Retire un repas d'un créneau
   body: { weekStart, dayKey, slot }
───────────────────────────────────────────────────────────────────────────── */
router.delete('/meal', async (req, res) => {
  try {
    const userId = req.user._id;
    const { weekStart, dayKey, slot } = req.body;

    if (!weekStart || !dayKey || !slot) {
      return res.status(400).json({ result: false, error: 'weekStart, dayKey et slot sont obligatoires.' });
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
      dayData.recipes = (dayData.recipes || []).filter(r => r.slot !== slot);
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
   body: { meals: [{weekStart, dayKey, slot, recipeId, recipeTitle}] }
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
        dayData.recipes = (dayData.recipes || []).filter(r => r.slot !== meal.slot);
        dayData.recipes.push({ recipeId: meal.recipeId || null, title: meal.recipeTitle || '', slot: meal.slot });
        week.days.set(meal.dayKey, dayData);
      }
    }

    cleanPlanning(planning, 60);
    planning.markModified('weeks');
    await planning.save();

    const io = req.app.get('io');
    for (const weekStart of Object.keys(weekGroups)) {
      io.to(`planning-${userId}`).emit('planning-updated', { weekStart });
    }

    res.json({ result: true });
  } catch (e) {
    console.error('❌ [POST /planning/bulk-meals]', e);
    res.status(500).json({ result: false, error: e.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /planning/recipe-stock-suggestions
   body: { recipeId }
   Retourne les produits du garde-manger qui correspondent aux ingrédients
   de la recette, pour permettre à l'utilisateur de déduire son stock.
───────────────────────────────────────────────────────────────────────────── */
const UserRecipe = require('../models/userRecipe');

router.post('/recipe-stock-suggestions', async (req, res) => {
  try {
    const userId = req.user._id;
    const { recipeId } = req.body;

    if (!recipeId) return res.status(400).json({ result: false, error: 'recipeId manquant.' });

    const [user, recipe] = await Promise.all([
      User.findById(userId).select('myproducts'),
      UserRecipe.findOne({ _id: recipeId, userId }).select('titre ingredients'),
    ]);

    if (!recipe) return res.status(404).json({ result: false, error: 'Recette introuvable.' });

    const matches = [];
    const usedProductIds = new Set();

    for (const ingredient of (recipe.ingredients || [])) {
      const ingLower = ingredient.toLowerCase();
      // Nettoyer le nom de l'ingrédient en retirant quantités et unités communes
      const ingName = ingLower
        .replace(/^\d+[\.,]?\d*\s*(g|kg|ml|cl|l|litres?|grammes?|kilos?|cuillères?|c\.?\s*à\s*[sc]\.?|pincée[s]?|tranches?|unités?|pièces?)\s*(à|de|d')?/i, '')
        .replace(/^(de |d'|du |des |un |une |quelques )/i, '')
        .trim();

      for (const product of (user.myproducts || [])) {
        if (usedProductIds.has(String(product._id))) continue;
        const prodLower = product.name.toLowerCase();
        if (ingName.includes(prodLower) || prodLower.includes(ingName) || ingLower.includes(prodLower)) {
          // Essayer de parser la quantité depuis la chaîne ingrédient
          const qtyMatch = ingredient.match(/^(\d+[\.,]?\d*)/);
          const suggestedQty = qtyMatch ? parseFloat(qtyMatch[1].replace(',', '.')) : 1;

          matches.push({
            productId: String(product._id),
            name: product.name,
            available: product.quantite ?? 0,
            unit: product.unit ?? '',
            suggestedQty: Math.min(suggestedQty, product.quantite ?? 0),
            ingredient,
          });
          usedProductIds.add(String(product._id));
          break;
        }
      }
    }

    res.json({ result: true, matches, recipeTitle: recipe.titre });
  } catch (e) {
    console.error('❌ [POST /planning/recipe-stock-suggestions]', e);
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
const { generateWeeklyPlan } = require('../services/recipeAI');

router.post('/generate', aiCredits, async (req, res) => {
  try {
    const { weekStart, duration = '1week' } = req.body;
    const userId = req.user._id;

    if (!weekStart) {
      return res.status(400).json({ result: false, error: 'weekStart manquant (format YYYY-MM-DD).' });
    }

    const numberOfDays = duration === '2weeks' ? 14 : 7;

    // Générer le tableau de dates à planifier
    const dates = Array.from({ length: numberOfDays }, (_, i) => {
      const d = new Date(weekStart + 'T12:00:00');
      d.setDate(d.getDate() + i);
      return d.toISOString().split('T')[0];
    });

    const [user, rawRecipes] = await Promise.all([
      User.findById(userId).select('myproducts'),
      UserRecipe.find({ userId }).select('_id titre ingredients'),
    ]);

    if (!user) {
      return res.status(404).json({ result: false, error: 'Utilisateur introuvable.' });
    }

    const recipes = rawRecipes.map(r => ({
      _id: r._id,
      titre: r.titre,
      ingredients: (r.ingredients ?? []).map(ing =>
        typeof ing === 'string' ? { name: ing, quantity: '', unit: '' } : ing
      ),
    }));

    const today   = new Date();
    const in3days = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000);

    const expiringProducts = (user.myproducts ?? []).filter(p =>
      p.expiration && new Date(p.expiration) <= in3days
    );
    const otherProducts = (user.myproducts ?? []).filter(p =>
      !p.expiration || new Date(p.expiration) > in3days
    );

    // Prendre plus de recettes pour les plans 2 semaines
    const maxRecipes = numberOfDays > 7 ? 60 : 40;
    const selectedRecipes = [...recipes].sort(() => Math.random() - 0.5).slice(0, maxRecipes);

    console.log(`[planning/generate] ${recipes.length} recette(s) — ${expiringProducts.length} expirant(s) — ${numberOfDays} jour(s) — ${selectedRecipes.length} recette(s) → Gemini`);

    const plan = await generateWeeklyPlan(expiringProducts, otherProducts, selectedRecipes, dates);

    await req.consumeCredit?.();
    res.json({ result: true, plan });
  } catch (err) {
    console.error('❌ [POST /planning/generate]', err.message);
    res.status(500).json({ result: false, error: 'Erreur lors de la génération du planning.' });
  }
});

module.exports = router;
