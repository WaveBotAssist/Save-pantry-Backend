/**
 * catalogMatching.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Sélection de recettes du catalogue (collection `recipes`) pour compléter le
 * pool envoyé au planning IA — compatibilité calculée via calculerCompatibilite,
 * même logique que la sélection "avec stock" de "Découvrir" (routes/recipe.js,
 * POST /myrecipes).
 *
 * Garantit toujours jusqu'à `limit` recettes (sauf catalogue trop petit) : en
 * priorité celles qui matchent le stock (% > 0, triées décroissant), puis des
 * recettes aléatoires du catalogue pour compléter — afin que le planning ait
 * toujours assez de variété, même si le stock ne matche aucune recette.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const Recipes = require('../models/recipe');
const { calculerCompatibilite } = require('./compatibilityService');

/** Mélange Fisher-Yates — utilisé pour varier les recettes de remplissage. */
function melanger(tableau) {
  const copie = [...tableau];
  for (let i = copie.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copie[i], copie[j]] = [copie[j], copie[i]];
  }
  return copie;
}

/**
 * @param {Array}  myproducts - Garde-manger de l'utilisateur (peut être vide)
 * @param {string} lang       - Langue des recettes ('fr' | 'en')
 * @param {number} limit      - Nombre maximum de recettes retournées
 * @returns {Promise<Array<{_id, titre, ingredients, image, pourcentageCompatibilite}>>}
 */
async function getCatalogMatches(myproducts, lang = 'fr', limit = 20) {
  const recettes = await Recipes.find(
    {
      langue: lang,
      $or: [
        { status: { $exists: false } },
        { status: { $nin: ['pending', 'rejected'] } },
      ],
    },
    { _id: 1, titre: 1, ingredients: 1, image: 1 }
  );

  const avecCompat = recettes.map(r => ({
    _id: r._id,
    titre: r.titre,
    ingredients: r.ingredients ?? [],
    image: r.image ?? '',
    pourcentageCompatibilite: calculerCompatibilite(r, myproducts).pourcentageCompatibilite,
  }));

  const avecStock = avecCompat
    .filter(r => r.pourcentageCompatibilite > 0)
    .sort((a, b) => b.pourcentageCompatibilite - a.pourcentageCompatibilite);

  if (avecStock.length >= limit) return avecStock.slice(0, limit);

  // Pas assez de recettes qui matchent le stock — complète avec des recettes
  // aléatoires du catalogue pour garantir assez de variété au planning
  const sansStock = melanger(avecCompat.filter(r => r.pourcentageCompatibilite === 0));

  return [...avecStock, ...sansStock].slice(0, limit);
}

module.exports = { getCatalogMatches };
