/**
 * recipeLimit.js — Middleware de limite de recettes personnelles pour les comptes gratuits.
 * ─────────────────────────────────────────────────────────────────────────────
 * Même principe que aiCredits.js : un seul endroit décide si l'utilisateur a
 * encore le droit d'ajouter une recette, branché sur toutes les routes qui
 * créent une recette dans la collection "userRecipes" (ajout manuel, scan,
 * import URL, génération IA, import groupé).
 *
 * Anonyme (pas de req.user) : le backend n'a aucune visibilité sur le
 * stockage local de l'appareil → la limite y est appliquée côté frontend
 * (useLocalRecipeStore). Ici on laisse simplement passer.
 *
 * checkRecipeLimit(req) — même logique, sans toucher req/res/next. Utilisé
 * par les routes qui ont déjà leurs propres vérifications manuelles
 * (ex: /recipe/import-url) ou qui ont besoin du compte exact (ex: import groupé).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const UserRecipe = require('../models/userRecipe');
const { checkPremiumStatus } = require('./checkPremium');
const { FREE_RECIPE_LIMIT } = require('../config/recipeLimits');

/**
 * Vérifie si l'utilisateur connecté peut encore ajouter une recette.
 *
 * @returns {Promise<object>}
 *   - { ok: true,  count }              — sous la limite (ou anonyme, ou premium)
 *   - { ok: false, status: 403, body }  — limite atteinte
 */
async function checkRecipeLimit(req) {
  try {
    // Anonyme : pas de compte côté serveur, donc rien à compter ici.
    if (!req.user) return { ok: true };

    const isPremium = await checkPremiumStatus(req.user);
    if (isPremium) return { ok: true };

    const count = await UserRecipe.countDocuments({ userId: req.user._id });
    if (count >= FREE_RECIPE_LIMIT) {
      return {
        ok: false,
        status: 403,
        body: { result: false, error: 'recipe_limit_reached', limit: FREE_RECIPE_LIMIT },
      };
    }

    return { ok: true, count };
  } catch (err) {
    console.error('❌ [checkRecipeLimit]', err.message);
    // En cas d'erreur technique (MongoDB down, etc.), on laisse passer pour
    // ne pas bloquer l'utilisateur à cause d'un problème infra.
    return { ok: true };
  }
}

/**
 * Middleware Express — applique checkRecipeLimit() et coupe la requête si la limite est atteinte.
 */
async function recipeLimitMiddleware(req, res, next) {
  const result = await checkRecipeLimit(req);
  if (!result.ok) return res.status(result.status).json(result.body);
  next();
}

module.exports = recipeLimitMiddleware;
module.exports.checkRecipeLimit = checkRecipeLimit;
