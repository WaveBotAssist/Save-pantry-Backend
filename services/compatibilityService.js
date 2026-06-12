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
 *      (y compris l'abréviation hybride "c. à soupe"/"c. à café" générée par l'IA),
 *      ainsi que les indications de dosage libre ("au goût"/"to taste")
 *   2. Filtre les ingrédients fantômes (mesure seule sans nom de produit)
 *   3. produitPresent()   — matching mot-à-mot avec 3 garde-fous
 *   4. MOTS_MESURE_SEULS  — empêche les pures unités de mesure d'être en stock
 *   5. stripAppellation() — pour les produits du stock avec une appellation
 *      ("Œufs bio"), ajoute une variante sans ce mot ("œufs") pour matcher
 *      les ingrédients de recette qui ne précisent pas l'appellation
 */

/** Normalise une chaîne : minuscules, sans accents, sans ponctuation. */
const normaliser = str =>
  (str ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/œ/g, 'oe')
    .replace(/\([a-z]{1,3}\)/g, ' ') // "(s)", "(es)", "(x)" — artefacts de format IA
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
    'sachets? de',    'pincees? de',   'boites? de',    'bottes? de',
    'tranches? de',   'verres? de',    'gousses? de',   'filets? de',
    'poignees? de',   'tasses? de',    'doses? de',     'morceaux? de',
    'portions? de',   'brins? de',     'feuilles? de',  'zestes? de',
    'branches? de',   'lamelles? de',  'rondelles? de', 'cubes? de',
    'bouquets? de',   'noisettes? de', 'traits? de',    'nuages? de',
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
  'tranche',  'tranches',   // "8 tranches gouda" → "tranche" est une unité de portion
  'portion',  'portions',
  'part',     'parts',
  'morceau',  'morceaux',
  'rondelle', 'rondelles',
  'lamelle',  'lamelles',
  // EN
  'tablespoon', 'tablespoons',
  'teaspoon',   'teaspoons',
  'tbsp',       'tbsps',
  'tsp',        'tsps',
  'bag',        'bags',
  'packet',     'packets',
  'cup',        'cups',
  'slice',      'slices',
  'piece',      'pieces',
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
 *
 * Doit rester alignée avec QUALIFICATIFS_SIMPLES dans
 * Frontend/src/shared/ingredients/ingredientMatching.ts (même rôle, deux moteurs
 * de matching séparés : catalogue/favoris ici, fiche recette + planning côté front).
 */
const QUALIFICATIFS_SIMPLES = new Set([
  // Couleurs / aspects
  'noir', 'noire', 'blanc', 'blanche', 'rouge', 'vert', 'verte', 'bleu',
  'jaune', 'rose', 'brun', 'brune', 'dore', 'doree',
  // Intensité / degré
  'amer', 'amere', 'doux', 'douce', 'fort', 'forte', 'extra', 'mi',
  // Traitement / état
  'frais', 'fraiche', 'entier', 'entiere', 'entiers', 'entieres', 'complet', 'complete',
  'leger', 'legere', 'nature', 'naturel', 'naturelle',
  'sec', 'seche', 'sale', 'sucre', 'sucree', 'fin', 'fine', 'fins', 'fines',
  // Texture / consistance
  'cremeux', 'cremeuse', 'cremeuses',
  'tendre', 'tendres', 'mou', 'molle', 'mous', 'molles',
  'liquide', 'epais', 'epaisse', 'onctueux', 'onctueuse',
  'veloute', 'veloutee', 'mousseux', 'mousseuse',
  'soft', 'tender', 'runny', 'firm', 'hard',
  // Composition / type
  'demi', 'semi', 'allege', 'allegee', 'enrichi', 'enrichie',
  'concentre', 'concentree', 'condense', 'condensee',
  // Texture / consistance EN
  'creamy', 'thick', 'liquid', 'smooth', 'silky', 'velvety', 'foamy',
  // Composition / type EN
  'half', 'enriched', 'fortified', 'reduced', 'skimmed', 'salted', 'unsalted', 'condensed', 'concentrated',
  // Préparations EN — viennent après l'ingrédient ("lemon juice", "vanilla extract"...)
  'juice', 'extract', 'coulis', 'puree', 'paste', 'powder', 'flakes', 'zest',
  // Préparation culinaire (ne change pas la nature de l'aliment)
  'dur', 'dure', 'durs', 'dures',
  'fondu', 'fondue', 'fondus', 'fondues',
  'battu', 'battue', 'battus', 'battues',
  'rape', 'rapee', 'rapes', 'rapees',
  'hache', 'hachee', 'haches', 'hachees',
  'emince', 'emincee', 'eminces', 'emincees',
  'coupe', 'coupee', 'coupes', 'coupees',
  'ecrase', 'ecrasee', 'ecrases', 'ecrasees',
  'mixe', 'mixee', 'mixes', 'mixees',
  'cuit', 'cuite', 'cuits', 'cuites',
  'grille', 'grillee', 'grilles', 'grillees',
  'epluchee', 'epluche', 'epluches', 'epluchees',
  'tamise', 'tamisee',
  // Origine / élevage / qualité (FR) — "oeufs au sol", "poulet bio", "oeufs fermiers"
  'sol', 'bio', 'fermier', 'fermiere', 'fermiers', 'fermieres', 'plein', 'label',
  // EN
  'dark', 'white', 'light', 'mild', 'strong', 'fresh', 'dried', 'whole',
  'sweet', 'bitter', 'plain', 'pure',
  'melted', 'beaten', 'grated', 'chopped', 'minced', 'sliced',
  'crushed', 'mashed', 'cooked', 'grilled', 'peeled', 'sifted',
  'organic', 'free', 'range', 'farm',
]);

// ─── Appellations produit ───────────────────────────────────────────────────

/**
 * Mots ajoutés en fin de nom de produit pour préciser sa provenance/qualité,
 * mais qui ne changent pas la nature de l'aliment pour une recette.
 * "Œufs bio" reste des œufs, "Poulet fermier" reste du poulet.
 *
 * Volontairement restreint aux mots sans ambiguïté : "rouge"/"label" sont
 * exclus car "Riz rouge" ou "Vin rouge" sont des produits différents de
 * "Riz"/"Vin" — les retirer changerait la nature de l'aliment.
 */
const MOTS_APPELLATION = new Set([
  'bio', 'fermier', 'fermiere', 'fermiers', 'fermieres',
]);

/**
 * Retire les mots d'appellation en fin de nom de produit normalisé.
 * "oeufs bio" → "oeufs", "poulet fermier" → "poulet".
 * Retourne la chaîne inchangée si aucun mot d'appellation en fin de nom.
 */
function stripAppellation(normProduit) {
  const words = normProduit.split(' ');
  while (words.length > 1 && MOTS_APPELLATION.has(words[words.length - 1])) {
    words.pop();
  }
  return words.join(' ');
}

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
  // FR — abréviation hybride "c. à soupe" / "c. à café" (format produit par l'IA, recipeAI.js)
  txt = txt.replace(/\bc\s+a\s+soupe\b/g, ' ');
  txt = txt.replace(/\bc\s+a\s+cafe\b/g,  ' ');
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

  // Variétés / cultivars — tout ce qui suit est un nom de variété, pas l'aliment
  // "4 pommes type Golden" → "4 pommes", "poires variété Louise-Bonne" → "poires"
  // — la variété précise n'est jamais le nom du produit en stock ("Pommes").
  txt = txt.replace(/\btypes?\b.*/i,    ' ');
  txt = txt.replace(/\bvarietes?\b.*/i, ' ');

  // Articles et quantificateurs isolés — retirés AVANT les gardes pour ne pas les bloquer
  // Ex FR : "un oignon" → "oignon", "du beurre" → "beurre", "quelques tomates" → "tomates"
  // Ex EN : "an onion" → "onion", "a clove" → "clove", "some cream" → "cream"
  txt = txt.replace(/\bquelques\b/g, ' ');
  txt = txt.replace(/\benviron\b/g,  ' ');
  txt = txt.replace(/\bun\b/g,       ' ');
  txt = txt.replace(/\bune\b/g,      ' ');
  txt = txt.replace(/\bdu\b/g,       ' ');
  txt = txt.replace(/\bsome\b/g,     ' ');
  txt = txt.replace(/\ban\b/g,       ' ');
  txt = txt.replace(/\ba\b/g,        ' ');

  // Contenants et unités de comptage sans connecteur
  // Couvre les formats IA "2 gousses Ail", "1 tranche Jambon", "1 pièce Oignon", etc.
  txt = txt.replace(/\bpieces?\b/g,   ' ');
  txt = txt.replace(/\bunites?\b/g,   ' ');
  txt = txt.replace(/\bgousses?\b/g,  ' ');
  txt = txt.replace(/\btranches?\b/g, ' ');
  txt = txt.replace(/\bbrins?\b/g,    ' ');
  txt = txt.replace(/\bfeuilles?\b/g, ' ');
  txt = txt.replace(/\bbranches?\b/g, ' ');
  txt = txt.replace(/\bzestes?\b/g,   ' ');
  txt = txt.replace(/\bbottes?\b/g,   ' ');
  txt = txt.replace(/\btiges?\b/g,    ' ');
  // EN — mêmes unités sans "of"
  txt = txt.replace(/\bcloves?\b/g,   ' ');
  txt = txt.replace(/\bsprigs?\b/g,   ' ');
  txt = txt.replace(/\bleaves?\b/g,   ' ');
  txt = txt.replace(/\bbunches?\b/g,  ' ');

  // Métadonnées sur l'ingrédient — pas son nom (ex: "miel (facultatif)" → "miel")
  txt = txt.replace(/\(facultatif\)/g,  ' ');
  txt = txt.replace(/\(optionnel\)/g,   ' ');
  txt = txt.replace(/\(optional\)/g,    ' ');
  txt = txt.replace(/\bfacultatif\b/g,  ' ');
  txt = txt.replace(/\boptionnel\b/g,   ' ');
  txt = txt.replace(/\boptional\b/g,    ' ');

  // Indications de dosage libre — ne changent pas la nature de l'aliment
  // ex: "Sel et poivre au goût" → "Sel et poivre"
  txt = txt.replace(/\bau gout\b/g,  ' ');
  txt = txt.replace(/\bto taste\b/g, ' ');


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
 *   2. Pluriel ±s / ±x — "pomme" ↔ "pommes", "poireau" ↔ "poireaux"
 *      (correspondance conservative : pas de préfixe arbitraire)
 *
 *   3. Limite droite — rien après le segment sauf un chiffre ou un qualificatif simple
 *      (évite "sauce" dans "sauce barbecue", mais accepte "chocolat" dans "chocolat noir")
 *
 * @param {string} normIngredient  Ingrédient après normaliser() + supprimerMesures()
 * @param {string} normProduit     Produit après normaliser()
 */
function produitPresent(normIngredient, normProduit) {
  if (!normIngredient || !normProduit) return false;

  const iWords = normIngredient.split(' ');
  const pWords = normProduit.split(' ');

  // Vérification préfixe : si l'ingrédient est plus court que le produit,
  // l'ingrédient peut correspondre au début du nom produit.
  // "mayonnaise" → "MAYONNAISE OEUF" ✅, "oeuf" → "MAYONNAISE OEUF" ❌
  if (pWords.length > iWords.length) {
    const prefixMatch = iWords.every((iw, idx) => {
      const pw = pWords[idx];
      if (!pw) return false;
      return iw === pw || iw === pw + 's' || pw === iw + 's' || iw === pw + 'x' || pw === iw + 'x';
    });
    if (prefixMatch) return true;
  }

  for (let i = 0; i <= iWords.length - pWords.length; i++) {

    // Garde-fou 1a : connecteur composé "au / aux / à la / à l'"
    // Évite que "beurre" couvre "croissant au beurre"
    const motAvant = iWords[i - 1] ?? null;
    const deuxAvant = iWords[i - 2] ?? null;
    if (motAvant === 'au' || motAvant === 'aux') continue;
    if (motAvant === 'la' && deuxAvant === 'a') continue;
    if (motAvant === 'l'  && deuxAvant === 'a') continue;

    // Garde-fou 1b : composé "X de/of Y" où X est un aliment
    // Évite que "légumes" couvre "bouillon de légumes", "mushroom" couvre "cream of mushroom"
    // Exception : X est un chiffre ("100g de farine") ou une unité ("500 ml de bouillon")
    if (motAvant === 'de' || motAvant === 'des' || motAvant === 'd' || motAvant === 'of') {
      const motAvantDe = iWords[i - 2] ?? '';
      // motAvantDe vide = ingrédient commence par "de/des/of" → autorisé
      if (motAvantDe && !/^\d/.test(motAvantDe) && !MOTS_QUANTITE.has(motAvantDe)) continue;
    }

    // Garde-fou 1c : position gauche — si le produit ne commence pas l'ingrédient,
    // le mot précédent doit être un chiffre, une unité de mesure ou un connecteur.
    // Ex : "sauce soja" + produit "soja" → motAvant="sauce" → rejet
    //      "3 oeufs"    + produit "oeuf" → motAvant="3"     → autorisé
    if (i > 0 &&
        motAvant !== 'de' && motAvant !== 'des' && motAvant !== 'd' &&
        motAvant !== 'of' && motAvant !== 'et'  && motAvant !== 'and' &&
        !/^\d/.test(motAvant) && !MOTS_QUANTITE.has(motAvant)) continue;

    // Garde-fou 2 : correspondance mot-à-mot (singulier ou pluriel ±s / ±x)
    const segment = iWords.slice(i, i + pWords.length);
    const correspond = pWords.every((mot, idx) => {
      const cible = segment[idx];
      return (
        cible === mot          ||
        cible === mot + 's'    || mot === cible + 's'   ||
        cible === mot + 'x'    || mot === cible + 'x'
      );
    });
    if (!correspond) continue;

    // Garde-fou 3 : limite droite — rien après le segment sauf un chiffre ou un qualificatif simple
    // Ex : "sauce barbecue" → "barbecue" absent de QUALIFICATIFS_SIMPLES → rejet
    //      "beurre fondu"   → "fondu" présent dans QUALIFICATIFS_SIMPLES → accepté
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
  // et ajoute, pour les produits avec appellation ("Œufs bio"), une variante
  // sans le mot d'appellation ("œufs") pour matcher "3 œufs" dans la recette.
  const produitsNormalises = myproducts
    .map(p => normaliser(p.name))
    .filter(Boolean)
    .filter(p => !MOTS_MESURE_SEULS.has(p))
    .flatMap(p => {
      const stripped = stripAppellation(p);
      return stripped !== p ? [p, stripped] : [p];
    });

  const detailsIngredients = ingredients.map(ingredient => {
    const normIngredient = supprimerMesures(normaliser(ingredient));

    // Ingrédient fantôme : uniquement une mesure sans produit (ex: "cuil. à soupe")
    // → ignoré dans le score, non affiché comme manquant
    if (estIngredientFantome(normIngredient)) {
      return { ingredient, disponible: true, produitCorrespondant: null };
    }

    // Alternatives "X ou Y" — vérifie chaque option séparément
    // "miel ou sucre" → ["miel", "sucre"] — disponible si l'une ou l'autre est en stock
    const alternatives = normIngredient.split(/\bou\b|\bor\b/).map(s => s.trim()).filter(Boolean);

    const produitCorrespondant = produitsNormalises.find(produit =>
      alternatives.some(alt => produitPresent(alt, produit))
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
