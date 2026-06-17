// routes/planning.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const User = require('../models/users');
const UserRecipe = require('../models/userRecipe');
const Planning = require('../models/planning');
const { cleanPlanning } = require('../utils/cleanPlanning');
const aiCredits = require('../middlewares/aiCredits');
const { calculerCompatibilite } = require('../services/compatibilityService');
const { getCatalogMatches } = require('../services/catalogMatching');


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
      User.findById(userId)
        .select('myproducts favorites language')
        .populate({ path: 'favorites', select: '_id titre ingredients image' }),
      UserRecipe.find({ userId }).select('_id titre ingredients image'),
    ]);

    if (!user) {
      return res.status(404).json({ result: false, error: 'Utilisateur introuvable.' });
    }

    const myproducts = user.myproducts ?? [];

    // Recettes personnelles + favoris du catalogue, avec leur compatibilité
    // stock (% d'ingrédients déjà présents dans le garde-manger)
    const personalAndFavorites = [
      ...rawRecipes.map(r => ({ _id: r._id, titre: r.titre, ingredients: r.ingredients ?? [], image: r.image ?? '' })),
      ...(user.favorites ?? []).map(r => ({ _id: r._id, titre: r.titre, ingredients: r.ingredients ?? [], image: r.image ?? '' })),
    ].map(r => ({
      ...r,
      pourcentageCompatibilite: calculerCompatibilite(r, myproducts).pourcentageCompatibilite,
    }));

    // Complète avec des recettes du catalogue : en priorité celles qui matchent
    // le stock (% > 0, comme "Découvrir"), puis des recettes aléatoires du
    // catalogue si besoin — garantit assez de variété même si le pool
    // perso/favoris est trop petit (ex: 1 seule recette favorite → éviterait
    // qu'elle se retrouve répétée sur toute la semaine).
    // On exclut celles déjà présentes en perso/favoris (un favori est une recette
    // du catalogue, il pourrait ressortir ici aussi).
    const existingIds = new Set(personalAndFavorites.map(r => String(r._id)));
    const catalogMatches = (await getCatalogMatches(myproducts, user.language, 20))
      .filter(r => !existingIds.has(String(r._id)));

    // Produits expirant dans ≤ 3 jours — anti-gaspillage : ces recettes
    // passent en tête du niveau "avec stock" (cf. tri ci-dessous), et la
    // liste est aussi transmise à Gemini (règle 2 du prompt) pour le
    // placement sur le calendrier final.
    const today   = new Date();
    const in3days = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000);
    const expiringProducts = myproducts.filter(p =>
      p.expiration && new Date(p.expiration) <= in3days
    );
    const otherProducts = myproducts.filter(p =>
      !p.expiration || new Date(p.expiration) > in3days
    );
    // Urgence d'une recette : timestamp d'expiration le plus proche parmi les
    // produits expirants qu'elle utilise (Infinity si aucun). Une date déjà
    // passée (produit périmé) donne un timestamp plus petit qu'une date dans
    // 3 jours → encore plus urgent, donc encore plus prioritaire.
    // Accepte aussi bien les ingrédients bruts (chaînes, depuis
    // personalAndFavorites/catalogMatches) que normalisés en objets
    // {name, quantity, unit} (depuis selectedRecipes) — calculerCompatibilite
    // attend des chaînes.
    const expirationUrgency = new Map();
    [...personalAndFavorites, ...catalogMatches].forEach(r => {
      const ingredients = (r.ingredients ?? []).map(ing => (typeof ing === 'string' ? ing : ing.name));
      const dates = expiringProducts
        .filter(p => calculerCompatibilite({ ingredients }, [p]).pourcentageCompatibilite > 0)
        .map(p => new Date(p.expiration).getTime());
      expirationUrgency.set(String(r._id), dates.length > 0 ? Math.min(...dates) : Infinity);
    });
    const urgency = (r) => expirationUrgency.get(String(r._id)) ?? Infinity;
    // Compare deux recettes par urgence : la plus urgente (timestamp le plus
    // petit, donc périmée depuis le plus longtemps) passe en premier ; celles
    // sans produit expirant (Infinity) passent en dernier. À urgence égale
    // (même produit expirant utilisé par une recette perso/favoris ET une
    // recette catalogue), la recette perso/favoris passe devant.
    const compareUrgency = (a, b) => {
      const ua = urgency(a), ub = urgency(b);
      if (ua !== ub) {
        if (ua === Infinity) return 1;
        if (ub === Infinity) return -1;
        return ua - ub;
      }
      const aPerso = existingIds.has(String(a._id));
      const bPerso = existingIds.has(String(b._id));
      if (aPerso !== bPerso) return aPerso ? -1 : 1;
      return 0;
    };

    // Priorité (4 niveaux) : perso/favoris avec stock > catalogue avec stock
    // > perso/favoris sans stock > catalogue sans stock. catalogMatches mélange
    // déjà "avec stock" (triés) et "sans stock" (aléatoire, pour la variété) —
    // on les sépare pour les replacer aux niveaux 2 et 4.
    const withStock = personalAndFavorites
      .filter(r => r.pourcentageCompatibilite > 0)
      .sort((a, b) =>
        compareUrgency(a, b)
        || b.pourcentageCompatibilite - a.pourcentageCompatibilite
      );
    const withoutStock = personalAndFavorites.filter(r => r.pourcentageCompatibilite === 0);

    // Même logique que withStock : si un produit expirant n'est utilisé par
    // aucune recette perso/favoris, on s'assure qu'au moins une recette du
    // catalogue qui l'utilise passe en tête du niveau 2.
    const catalogWithStock = catalogMatches
      .filter(r => r.pourcentageCompatibilite > 0)
      .sort((a, b) =>
        compareUrgency(a, b)
        || b.pourcentageCompatibilite - a.pourcentageCompatibilite
      );
    const catalogWithoutStock = catalogMatches.filter(r => r.pourcentageCompatibilite === 0);

    const recipes = [...withStock, ...catalogWithStock, ...withoutStock, ...catalogWithoutStock].map(r => ({
      _id: r._id,
      titre: r.titre,
      image: r.image ?? '',
      ingredients: (r.ingredients ?? []).map(ing =>
        typeof ing === 'string' ? { name: ing, quantity: '', unit: '' } : ing
      ),
    }));

    if (recipes.length === 0) {
      return res.status(400).json({ result: false, error: 'no_recipes' });
    }

    // Prendre plus de recettes pour les plans 2 semaines — déjà triées par
    // pertinence stock, on garde cet ordre (plus de mélange aléatoire)
    const maxRecipes = numberOfDays > 7 ? 60 : 40;
    const selectedRecipes = recipes.slice(0, maxRecipes);

    console.log(`[planning/generate] ${recipes.length} recette(s) (${withStock.length} perso/favoris+stock, ${catalogWithStock.length} catalogue+stock, ${withoutStock.length} perso/favoris sans stock, ${catalogWithoutStock.length} catalogue sans stock) — ${expiringProducts.length} expirant(s) — ${numberOfDays} jour(s) — ${selectedRecipes.length} recette(s) → Gemini`);

    const plan = await generateWeeklyPlan(expiringProducts, otherProducts, selectedRecipes, dates);

    // Garde-fou : ne garder que les repas dont le recipeId correspond bien à
    // une recette envoyée à Gemini — élimine les inventions (ex: un produit
    // du stock proposé comme nom de recette).
    const recipeById = new Map(selectedRecipes.map(r => [String(r._id), r]));
    plan.meals = (plan.meals ?? [])
      .filter(m => recipeById.has(String(m.recipeId)))
      // L'IA peut choisir une recette perso, favorite ou catalogue — on
      // attache son image ici pour que le front n'ait pas à la rechercher
      // dans plusieurs caches (recettes / favoris / catalogue)
      .map(m => ({ ...m, image: recipeById.get(String(m.recipeId)).image || null }));

    // Comble les jours sans repas : Gemini peut en oublier un, ou le
    // garde-fou ci-dessus a retiré un recipeId invalide — on assigne la
    // recette suivante la plus pertinente (déjà triée par pertinence stock),
    // en évitant si possible les recettes déjà placées dans le planning.
    const plannedDates = new Set(plan.meals.map(m => m.date));
    const missingDates = dates.filter(d => !plannedDates.has(d));

    if (missingDates.length > 0) {
      const usedIds = new Set(plan.meals.map(m => String(m.recipeId)));
      const fallbackPool = selectedRecipes.filter(r => !usedIds.has(String(r._id)));
      const pool = fallbackPool.length > 0 ? fallbackPool : selectedRecipes;

      missingDates.forEach((date, i) => {
        const recipe = pool[i % pool.length];
        plan.meals.push({
          date,
          recipeTitle: recipe.titre,
          recipeId: recipe._id,
          reason: '',
          image: recipe.image || null,
        });
      });

      plan.meals.sort((a, b) => a.date.localeCompare(b.date));
    }

    // Place les recettes anti-gaspillage (utilisant un produit ≤3j, y compris
    // déjà périmé) sur les premiers jours du calendrier, triées par urgence —
    // le produit périmé depuis le plus longtemps passe en premier — même
    // plusieurs jours à la suite si besoin.
    const expiringMeals = [];
    const otherMeals = [];
    plan.meals.forEach(m => {
      const recipe = recipeById.get(String(m.recipeId));
      (urgency(recipe) !== Infinity ? expiringMeals : otherMeals).push(m);
    });
    expiringMeals.sort((a, b) =>
      compareUrgency(recipeById.get(String(a.recipeId)), recipeById.get(String(b.recipeId)))
    );
    plan.meals = [...expiringMeals, ...otherMeals].map((m, i) => ({ ...m, date: dates[i] ?? m.date }));

    await req.consumeCredit?.();
    res.json({ result: true, plan });
  } catch (err) {
    console.error('❌ [POST /planning/generate]', err.message);
    res.status(500).json({ result: false, error: 'Erreur lors de la génération du planning.' });
  }
});

module.exports = router;
