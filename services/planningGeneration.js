// services/planningGeneration.js
//
// Pipeline complet de génération IA du planning anti-gaspillage — extrait de
// routes/planning.js pour que la route HTTP ne fasse que : valider la requête,
// appeler generateUserPlanning(), consommer le crédit, répondre.
//
// Étapes du pipeline (dans l'ordre d'exécution de generateUserPlanning) :
//   1. buildDateRange          — calcule les dates à planifier
//   2. loadUserContext         — charge l'utilisateur (stock, favoris, recettes perso)
//   3. splitExpiringProducts   — sépare le stock qui expire (≤3j) du reste
//   4. buildRecipePool         — construit et trie le pool de recettes candidates
//   5. generateWeeklyPlan      — appel Gemini (services/recipeAI.js)
//   6. reconcilePlan           — garde-fou + jours manquants + ordre anti-gaspillage

const User = require('../models/users');
const UserRecipe = require('../models/userRecipe');
const { calculerCompatibilite } = require('./compatibilityService');
const { getCatalogMatches } = require('./catalogMatching');
const { generateWeeklyPlan } = require('./recipeAI');

/** Construit le tableau de dates (YYYY-MM-DD) à planifier, à partir du premier jour et du nombre de jours. */
function buildDateRange(weekStart, numberOfDays) {
  return Array.from({ length: numberOfDays }, (_, i) => {
    const d = new Date(weekStart + 'T12:00:00');
    d.setDate(d.getDate() + i);
    return d.toISOString().split('T')[0];
  });
}

/** Charge l'utilisateur (produits, favoris, langue) et ses recettes personnelles. */
async function loadUserContext(userId) {
  const [user, rawRecipes] = await Promise.all([
    User.findById(userId)
      .select('myproducts favorites language')
      .populate({ path: 'favorites', select: '_id titre ingredients image' }),
    UserRecipe.find({ userId }).select('_id titre ingredients image'),
  ]);

  if (!user) throw new Error('USER_NOT_FOUND');

  return { user, rawRecipes };
}

/** Sépare le stock entre produits expirant dans ≤3 jours (priorité anti-gaspillage) et le reste. */
function splitExpiringProducts(myproducts) {
  const today = new Date();
  const in3days = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000);
  return {
    expiringProducts: myproducts.filter(p => p.expiration && new Date(p.expiration) <= in3days),
    otherProducts: myproducts.filter(p => !p.expiration || new Date(p.expiration) > in3days),
  };
}

/**
 * Calcule, pour chaque recette, l'urgence d'expiration : timestamp d'expiration
 * le plus proche parmi les produits expirants qu'elle utilise (Infinity si aucun).
 * Une date déjà passée (produit périmé) donne un timestamp plus petit qu'une
 * date dans 3 jours → encore plus urgent, donc encore plus prioritaire.
 */
function buildExpirationUrgencyMap(allRecipes, expiringProducts) {
  const map = new Map();
  allRecipes.forEach(r => {
    const ingredients = (r.ingredients ?? []).map(ing => (typeof ing === 'string' ? ing : ing.name));
    const dates = expiringProducts
      .filter(p => calculerCompatibilite({ ingredients }, [p]).pourcentageCompatibilite > 0)
      .map(p => new Date(p.expiration).getTime());
    map.set(String(r._id), dates.length > 0 ? Math.min(...dates) : Infinity);
  });
  return map;
}

/**
 * Construit le pool de recettes candidates (perso/favoris + catalogue),
 * trié par priorité anti-gaspillage (4 niveaux : perso/favoris avec stock >
 * catalogue avec stock > perso/favoris sans stock > catalogue sans stock).
 */
async function buildRecipePool({ user, rawRecipes, myproducts, expiringProducts }) {
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
  // qu'elle se retrouve répétée sur toute la semaine). On exclut celles déjà
  // présentes en perso/favoris (un favori est une recette du catalogue, il
  // pourrait ressortir ici aussi).
  const existingIds = new Set(personalAndFavorites.map(r => String(r._id)));
  const catalogMatches = (await getCatalogMatches(myproducts, user.language, 20))
    .filter(r => !existingIds.has(String(r._id)));

  const urgencyMap = buildExpirationUrgencyMap([...personalAndFavorites, ...catalogMatches], expiringProducts);
  const urgency = (r) => urgencyMap.get(String(r._id)) ?? Infinity;

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

  // catalogMatches mélange déjà "avec stock" (triés) et "sans stock"
  // (aléatoire, pour la variété) — on les sépare pour les replacer aux
  // niveaux 2 et 4 de la priorité finale.
  const withStock = personalAndFavorites
    .filter(r => r.pourcentageCompatibilite > 0)
    .sort((a, b) => compareUrgency(a, b) || b.pourcentageCompatibilite - a.pourcentageCompatibilite);
  const withoutStock = personalAndFavorites.filter(r => r.pourcentageCompatibilite === 0);

  const catalogWithStock = catalogMatches
    .filter(r => r.pourcentageCompatibilite > 0)
    .sort((a, b) => compareUrgency(a, b) || b.pourcentageCompatibilite - a.pourcentageCompatibilite);
  const catalogWithoutStock = catalogMatches.filter(r => r.pourcentageCompatibilite === 0);

  const recipes = [...withStock, ...catalogWithStock, ...withoutStock, ...catalogWithoutStock].map(r => ({
    _id: r._id,
    titre: r.titre,
    image: r.image ?? '',
    ingredients: (r.ingredients ?? []).map(ing =>
      typeof ing === 'string' ? { name: ing, quantity: '', unit: '' } : ing
    ),
  }));

  return {
    recipes,
    counts: {
      withStock: withStock.length,
      catalogWithStock: catalogWithStock.length,
      withoutStock: withoutStock.length,
      catalogWithoutStock: catalogWithoutStock.length,
    },
    urgency,
    compareUrgency,
  };
}

/**
 * Garde-fou post-Gemini : élimine les recipeId inventés, attache l'image de
 * chaque recette, comble les jours oubliés, puis replace les recettes
 * anti-gaspillage en tête de calendrier par ordre d'urgence.
 */
function reconcilePlan(plan, { dates, selectedRecipes, urgency, compareUrgency }) {
  const recipeById = new Map(selectedRecipes.map(r => [String(r._id), r]));

  // Ne garder que les repas dont le recipeId correspond bien à une recette
  // envoyée à Gemini — élimine les inventions (ex: un produit du stock
  // proposé comme nom de recette). On attache aussi l'image ici pour que le
  // front n'ait pas à la rechercher dans plusieurs caches (recettes / favoris / catalogue).
  let meals = (plan.meals ?? [])
    .filter(m => recipeById.has(String(m.recipeId)))
    .map(m => ({ ...m, image: recipeById.get(String(m.recipeId)).image || null }));

  // Comble les jours sans repas : Gemini peut en oublier un, ou le garde-fou
  // ci-dessus a retiré un recipeId invalide — on assigne la recette suivante
  // la plus pertinente (déjà triée par pertinence stock), en évitant si
  // possible les recettes déjà placées dans le planning.
  const plannedDates = new Set(meals.map(m => m.date));
  const missingDates = dates.filter(d => !plannedDates.has(d));

  if (missingDates.length > 0) {
    const usedIds = new Set(meals.map(m => String(m.recipeId)));
    const fallbackPool = selectedRecipes.filter(r => !usedIds.has(String(r._id)));
    const pool = fallbackPool.length > 0 ? fallbackPool : selectedRecipes;

    missingDates.forEach((date, i) => {
      const recipe = pool[i % pool.length];
      meals.push({ date, recipeTitle: recipe.titre, recipeId: recipe._id, reason: '', image: recipe.image || null });
    });

    meals.sort((a, b) => a.date.localeCompare(b.date));
  }

  // Place les recettes anti-gaspillage (utilisant un produit ≤3j, y compris
  // déjà périmé) sur les premiers jours du calendrier, triées par urgence —
  // le produit périmé depuis le plus longtemps passe en premier — même
  // plusieurs jours à la suite si besoin.
  const expiringMeals = [];
  const otherMeals = [];
  meals.forEach(m => {
    const recipe = recipeById.get(String(m.recipeId));
    (urgency(recipe) !== Infinity ? expiringMeals : otherMeals).push(m);
  });
  expiringMeals.sort((a, b) =>
    compareUrgency(recipeById.get(String(a.recipeId)), recipeById.get(String(b.recipeId)))
  );

  return { ...plan, meals: [...expiringMeals, ...otherMeals].map((m, i) => ({ ...m, date: dates[i] ?? m.date })) };
}

/**
 * Génère un planning dîner anti-gaspillage pour un utilisateur.
 * @throws {Error} message 'USER_NOT_FOUND' | 'NO_RECIPES'
 */
async function generateUserPlanning(userId, weekStart, duration) {
  const numberOfDays = duration === '2weeks' ? 14 : 7;
  const dates = buildDateRange(weekStart, numberOfDays);

  const { user, rawRecipes } = await loadUserContext(userId);
  const myproducts = user.myproducts ?? [];
  const { expiringProducts, otherProducts } = splitExpiringProducts(myproducts);

  const { recipes, counts, urgency, compareUrgency } =
    await buildRecipePool({ user, rawRecipes, myproducts, expiringProducts });

  if (recipes.length === 0) throw new Error('NO_RECIPES');

  // Prendre plus de recettes pour les plans 2 semaines — déjà triées par
  // pertinence stock, on garde cet ordre (plus de mélange aléatoire)
  const maxRecipes = numberOfDays > 7 ? 60 : 40;
  const selectedRecipes = recipes.slice(0, maxRecipes);

  console.log(
    `[planning/generate] ${recipes.length} recette(s) ` +
    `(${counts.withStock} perso/favoris+stock, ${counts.catalogWithStock} catalogue+stock, ` +
    `${counts.withoutStock} perso/favoris sans stock, ${counts.catalogWithoutStock} catalogue sans stock) — ` +
    `${expiringProducts.length} expirant(s) — ${numberOfDays} jour(s) — ${selectedRecipes.length} recette(s) → Gemini`
  );

  const rawPlan = await generateWeeklyPlan(expiringProducts, otherProducts, selectedRecipes, dates);

  return reconcilePlan(rawPlan, { dates, selectedRecipes, urgency, compareUrgency });
}

module.exports = { generateUserPlanning };
