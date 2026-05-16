/**
 * Service de compatibilité recette / garde-manger.
 *
 * Utilisé par :
 *   - routes/recipe.js
 *   - routes/favoritesRecipes.js
 *
 * Compatible FR + EN.
 *
 * Stratégie :
 *   1. supprimerMesures() — retire toutes les formes de cuillère à soupe/café et unités
 *   2. Filtre les ingrédients fantômes (mesure seule sans nom de produit)
 *   3. produitPresent()   — matching mot-à-mot avec 3 garde-fous
 *   4. MOTS_MESURE_SEULS  — empêche les pures unités de mesure d'être en stock
 */

/** Normalise une chaîne : minuscules, sans accents, sans ponctuation. */
const normaliser = str =>
  (str ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/œ/g, 'oe')          // œ → oe
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// ─── Autres unités de mesure ───────────────────────────────────────────────────

/**
 * Expressions de mesure avec connecteur "de" / "of".
 * Appliquées après les cuillères dans supprimerMesures().
 */
const RE_MESURES = new RegExp(
  [
    // FR
    'sachets? de',   'pincees? de',  'boites? de',   'bottes? de',
    'tranches? de',  'verres? de',   'gousses? de',  'filets? de',
    'poignees? de',  'tasses? de',   'doses? de',    'morceaux? de',
    'portions? de',  'brins? de',    'feuilles? de', 'zestes? de',
    'branches? de',  'lamelles? de', 'rondelles? de','cubes? de',
    'bouquets? de',
    // EN
    'cups? of',       'packets? of',   'pinch(?:es)? of', 'slices? of',
    'pieces? of',     'handfuls? of',  'bunches? of',     'cloves? of',
    'sprigs? of',     'dashes? of',    'drops? of',       'knobs? of',
    'cans? of',       'bags? of',      'jars? of',        'bottles? of',
    'leaves? of',     'cubes? of',     'portions? of',
    'oz', 'lbs?',
  ].map(p => `\\b${p}\\b`).join('|'),
  'g'
);

// ─── Mots interdits en stock ───────────────────────────────────────────────────

/**
 * Mots qui ne désignent jamais un aliment seuls — uniquement des unités de mesure.
 *
 * "soupe", "cafe", "coffee", "tea" ne sont PAS ici : ce sont de vrais aliments.
 * Leur faux positif est géré par supprimerMesures() qui retire la phrase complète
 * "cuillère à soupe" / "cuillère à café" de l'ingrédient avant la correspondance.
 */
const MOTS_MESURE_SEULS = new Set([
  // FR
  'cuillere', 'cuilleres', 'cuil', 'cuils',
  'sachet',   'sachets',
  'pincee',   'pincees',
  'verre',    'verres',
  'tasse',    'tasses',
  // EN
  'tablespoon', 'tablespoons',
  'teaspoon',   'teaspoons',
  'tbsp',       'tbsps',
  'tsp',        'tsps',
  'bag',        'bags',
  'packet',     'packets',
  'cup',        'cups',
]);

/**
 * Mots qui, placés avant "de", indiquent un CONTEXTE DE QUANTITÉ et non un composé alimentaire.
 * Ex : "500 ml de bouillon" → "ml" est une unité → "bouillon" n'est pas un composé.
 * Inclut MOTS_MESURE_SEULS + unités de volume/masse.
 */
const MOTS_QUANTITE = new Set([
  ...MOTS_MESURE_SEULS,
  // Volumes
  'l', 'ml', 'cl', 'dl',
  'litre', 'litres',
  'centilitre', 'centilitres', 'millilitre', 'millilitres',
  // Masses
  'g', 'kg', 'mg',
  'gramme', 'grammes', 'kilogramme', 'kilogrammes',
  // Divers
  'once', 'onces',
]);

// ─── Qualificatifs simples ────────────────────────────────────────────────────

/**
 * Mots qui peuvent suivre un nom de produit sans en changer la nature.
 * "chocolat noir" reste du chocolat → autorisé.
 * "sauce barbecue" est un produit différent → "barbecue" n'est pas dans cette liste.
 */
const QUALIFICATIFS_SIMPLES = new Set([
  // Couleurs / aspects
  'noir', 'noire', 'blanc', 'blanche', 'rouge', 'vert', 'verte',
  'jaune', 'rose', 'brun', 'brune', 'dore', 'doree',
  // Intensité / degré
  'amer', 'amere', 'doux', 'douce', 'fort', 'forte', 'extra', 'mi',
  // Traitement / état
  'frais', 'fraiche', 'entier', 'entiere', 'complet', 'complete',
  'leger', 'legere', 'nature', 'naturel', 'naturelle',
  'sec', 'seche', 'sale', 'sucre', 'sucree',
  // EN
  'dark', 'white', 'light', 'mild', 'strong', 'fresh', 'dried', 'whole',
  'sweet', 'bitter', 'plain', 'pure',
]);

// ─── Logique principale ───────────────────────────────────────────────────────

/**
 * Supprime toutes les expressions de mesure d'un ingrédient normalisé.
 *
 * Les cuillères sont strippées en premier avec des regexes littérales (pas de
 * construction dynamique) pour garantir l'absence de bug d'échappement.
 *
 * Formes couvertes après normaliser() :
 *   cuillere(s) a soupe / cafe      cuil(s) a soupe / cafe
 *   cuillere(s) soupe / cafe        cuil(s) soupe / cafe   (sans "à")
 *   c a s / c a c                   c s / c c              (abréviations)
 *   cas / cac / cs / cc             tablespoon(s) / teaspoon(s) / tbsp / tsp (EN)
 */
function supprimerMesures(txt) {
  // FR — formes longues avec "à"
  txt = txt.replace(/\bcuilleres?\s+a\s+soupe\b/g, ' ');
  txt = txt.replace(/\bcuilleres?\s+a\s+cafe\b/g,  ' ');
  // FR — formes longues sans "à"
  txt = txt.replace(/\bcuilleres?\s+soupe\b/g, ' ');
  txt = txt.replace(/\bcuilleres?\s+cafe\b/g,  ' ');
  // FR — formes courtes avec "à"
  txt = txt.replace(/\bcuils?\s+a\s+soupe\b/g, ' ');
  txt = txt.replace(/\bcuils?\s+a\s+cafe\b/g,  ' ');
  // FR — formes courtes sans "à"
  txt = txt.replace(/\bcuils?\s+soupe\b/g, ' ');
  txt = txt.replace(/\bcuils?\s+cafe\b/g,  ' ');
  // FR — abréviations avec espaces : c.à.s. → c a s, c.s. → c s
  txt = txt.replace(/\bc\s+a\s+s\b/g, ' ');
  txt = txt.replace(/\bc\s+a\s+c\b/g, ' ');
  txt = txt.replace(/\bc\s+s\b/g,     ' ');
  txt = txt.replace(/\bc\s+c\b/g,     ' ');
  // FR — abréviations compactes
  txt = txt.replace(/\bcas\b/g, ' ');
  txt = txt.replace(/\bcac\b/g, ' ');
  txt = txt.replace(/\bcs\b/g,  ' ');
  txt = txt.replace(/\bcc\b/g,  ' ');
  // EN
  txt = txt.replace(/\btablespoons?\b/g, ' ');
  txt = txt.replace(/\bteaspoons?\b/g,   ' ');
  txt = txt.replace(/\btbsps?\b/g,       ' ');
  txt = txt.replace(/\btsps?\b/g,        ' ');
  // Autres mesures avec "de" / "of"
  txt = txt.replace(RE_MESURES, ' ');

  // Unités de volume/masse + "de" (ex: "500 ml de bouillon", "3 g de farine")
  txt = txt.replace(/\bml\s+de\b/g,          ' ');
  txt = txt.replace(/\bcl\s+de\b/g,          ' ');
  txt = txt.replace(/\bdl\s+de\b/g,          ' ');
  txt = txt.replace(/\bkg\s+de\b/g,          ' ');
  txt = txt.replace(/\bmg\s+de\b/g,          ' ');
  txt = txt.replace(/\bg\s+de\b/g,           ' ');
  txt = txt.replace(/\blitres?\s+de\b/g,     ' ');
  txt = txt.replace(/\bgrammes?\s+de\b/g,    ' ');

  // Quantificateurs (ex: "un peu de sel", "quelques rondelles de tomate")
  txt = txt.replace(/\bun\s+peu\s+de\b/g,    ' ');
  txt = txt.replace(/\ba\s+little\s+of\b/g,  ' ');

  return txt.replace(/\s+/g, ' ').trim();
}

/**
 * Retourne true si l'ingrédient nettoyé est un fantôme :
 * uniquement une mesure sans nom de produit (ex : "cuil. à soupe" seul).
 * Ces ingrédients sont ignorés dans le calcul de compatibilité.
 */
function estIngredientFantome(normStripped) {
  return !normStripped || /^[\d\s]*$/.test(normStripped);
}

/**
 * Vérifie si un produit du garde-manger correspond à un ingrédient nettoyé.
 * Matching mot-à-mot avec trois garde-fous :
 *
 *   1. Connecteur composé gauche — rejet si précédé de "au / aux / à la / à l'"
 *      (évite que "beurre" couvre l'ingrédient "croissant au beurre")
 *
 *   2. Pluriel — le dernier mot du produit peut être au pluriel (+s)
 *      (accepte "pomme" → "pommes")
 *
 *   3. Limite droite — rien d'autre ne suit sauf un chiffre
 *      (évite "sauce" dans "sauce barbecue", "pomme" dans "pommes de terre")
 *
 * @param {string} normIngredient  Ingrédient après normaliser() + supprimerMesures()
 * @param {string} normProduit     Produit après normaliser()
 */
function produitPresent(normIngredient, normProduit) {
  if (!normIngredient || !normProduit) return false;

  const iWords = normIngredient.split(' ');
  const pWords = normProduit.split(' ');

  for (let i = 0; i <= iWords.length - pWords.length; i++) {

    // Garde-fou 1a : connecteur composé "au / aux / à la / à l'"
    // Évite que "beurre" couvre "croissant au beurre"
    const motAvant = iWords[i - 1] ?? null;
    const deuxAvant = iWords[i - 2] ?? null;
    if (motAvant === 'au' || motAvant === 'aux') continue;
    if (motAvant === 'la' && deuxAvant === 'a') continue;
    if (motAvant === 'l'  && deuxAvant === 'a') continue;

    // Garde-fou 1b : composé "X de Y" où X est un aliment
    // Évite que "légumes" couvre "bouillon de légumes"
    // Exception : X est un chiffre ("100g de farine") ou une unité ("500 ml de bouillon")
    if ((motAvant === 'de' || motAvant === 'des' || motAvant === 'd') && i > 1) {
      const motAvantDe = iWords[i - 2] ?? '';
      const estQuantite = /^\d/.test(motAvantDe) || MOTS_QUANTITE.has(motAvantDe);
      if (!estQuantite) continue;
    }

    // Garde-fou 2 : correspondance mot-à-mot (singulier ou pluriel)
    const segment = iWords.slice(i, i + pWords.length);
    const correspond = pWords.every((mot, idx) => {
      const cible = segment[idx];
      return cible === mot || cible === `${mot}s`;
    });
    if (!correspond) continue;

    // Garde-fou 3 : limite droite
    // Autorise les qualificatifs simples (couleurs, intensités) qui ne changent pas
    // la nature de l'aliment : "chocolat noir" est du chocolat, "sauce barbecue" ne l'est pas.
    const motApres = iWords[i + pWords.length] ?? null;
    if (motApres && !/^\d/.test(motApres) && !QUALIFICATIFS_SIMPLES.has(motApres)) continue;

    return true;
  }

  return false;
}

/**
 * Calcule la compatibilité d'une recette avec les produits du garde-manger.
 *
 * @param {Object} recette     - Objet recette avec un tableau `ingredients`
 * @param {Array}  myproducts  - Produits du garde-manger ({ name: string, ... })
 * @returns {{
 *   detailsIngredients: Array,
 *   ingredientsManquants: string[],
 *   pourcentageCompatibilite: number,
 *   score: number
 * }}
 */
function calculerCompatibilite(recette, myproducts = []) {
  const ingredients = (recette.ingredients ?? [])
    .map(i => i.trim())
    .filter(Boolean);

  // Exclut les mots qui ne sont jamais des aliments (pures unités de mesure)
  const produitsNormalises = myproducts
    .map(p => normaliser(p.name))
    .filter(Boolean)
    .filter(p => !MOTS_MESURE_SEULS.has(p));

  const detailsIngredients = ingredients.map(ingredient => {
    const normIngredient = supprimerMesures(normaliser(ingredient));

    // Ingrédient fantôme : uniquement une mesure sans produit (ex: "cuil. à soupe")
    // → ignoré dans le score, non affiché comme manquant
    if (estIngredientFantome(normIngredient)) {
      return { ingredient, disponible: true, produitCorrespondant: null };
    }

    const produitCorrespondant = produitsNormalises.find(produit =>
      produitPresent(normIngredient, produit)
    ) ?? null;

    return {
      ingredient,
      disponible: produitCorrespondant !== null,
      produitCorrespondant,
    };
  });

  const ingredientsManquants = detailsIngredients
    .filter(i => !i.disponible)
    .map(i => i.ingredient);

  const total = ingredients.length;
  const score = total - ingredientsManquants.length;
  const pourcentageCompatibilite = total > 0
    ? Math.round((score / total) * 100)
    : 0;

  return {
    detailsIngredients,
    ingredientsManquants,
    pourcentageCompatibilite,
    score,
  };
}

module.exports = { calculerCompatibilite };
