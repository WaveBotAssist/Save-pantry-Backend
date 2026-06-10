/**
 * ingredientParser.js
 *
 * Parse une chaîne ingrédient en {qty, unit, name} et convertit les unités
 * pour que la quantité à déduire soit toujours dans l'unité du produit en stock.
 *
 * Exemples :
 *   "500g de farine"          → {qty: 500, unit: "g",    name: "farine"}
 *   "1/2 oignon"              → {qty: 0.5, unit: null,   name: "oignon"}
 *   "2 c. à s. d'huile"      → {qty: 2,   unit: "c.s.", name: "huile"}
 *   "quelques feuilles de basilic" → {qty: null, unit: null, name: "basilic"}
 */

// ─── Tables de conversion vers l'unité de base ───────────────────────────────
// Masse → grammes | Volume → millilitres

const MASS_TO_G = {
  g: 1, gr: 1, gramme: 1, grammes: 1,
  kg: 1000, kilo: 1000, kilos: 1000, kilogramme: 1000, kilogrammes: 1000,
  lb: 453.6, livre: 453.6, livres: 453.6,
  oz: 28.35, once: 28.35, onces: 28.35,
};

const VOLUME_TO_ML = {
  ml: 1, millilitre: 1, millilitres: 1,
  cl: 10, centilitre: 10, centilitres: 10,
  dl: 100, décilitre: 100,
  l: 1000, litre: 1000, litres: 1000,
  'c.s.': 15, 'c. à s.': 15, cs: 15,
  'c.c.': 5,  'c. à c.': 5,  cc: 5,
  'cuillère à soupe': 15, 'cuillères à soupe': 15,
  'cuillère à café':  5,  'cuillères à café':  5,
  tasse: 250, cup: 240,
  verre: 200,
};

// ─── Patterns d'unités (multi-mots en premier) ────────────────────────────────

const UNIT_PATTERNS = [
  { re: /^cuill?[eè]res?\s+à\s+soupe\b/i,  unit: 'cuillère à soupe' },
  { re: /^cuill?[eè]res?\s+à\s+café\b/i,   unit: 'cuillère à café' },
  { re: /^c\.\s*à\s*s\.?\b/i,              unit: 'c.s.' },
  { re: /^c\.\s*à\s*c\.?\b/i,              unit: 'c.c.' },
  { re: /^kilogrammes?\b/i,                unit: 'kg' },
  { re: /^kilos?\b/i,                      unit: 'kg' },
  { re: /^kg\b/i,                          unit: 'kg' },
  { re: /^grammes?\b/i,                    unit: 'g' },
  { re: /^gr\.?\b/i,                       unit: 'g' },
  { re: /^g\b/i,                           unit: 'g' },
  { re: /^millilitres?\b/i,                unit: 'ml' },
  { re: /^ml\b/i,                          unit: 'ml' },
  { re: /^centilitres?\b/i,                unit: 'cl' },
  { re: /^cl\b/i,                          unit: 'cl' },
  { re: /^d[eé]cilitres?\b/i,             unit: 'dl' },
  { re: /^dl\b/i,                          unit: 'dl' },
  { re: /^litres?\b/i,                     unit: 'l' },
  { re: /^l\b/i,                           unit: 'l' },
  { re: /^tasses?\b/i,                     unit: 'tasse' },
  { re: /^verres?\b/i,                     unit: 'verre' },
  { re: /^tranches?\b/i,                   unit: 'tranche' },
  { re: /^pincées?\b/i,                    unit: 'pincée' },
  { re: /^pi[eè]ces?\b/i,                 unit: 'pièce' },
  { re: /^unit[eé]s?\b/i,                 unit: 'unité' },
  { re: /^boites?\b/i,                     unit: 'boite' },
  { re: /^bo[iî]tes?\b/i,                 unit: 'boite' },
  { re: /^sachets?\b/i,                    unit: 'sachet' },
  { re: /^pots?\b/i,                       unit: 'pot' },
  { re: /^branches?\b/i,                   unit: 'branche' },
  { re: /^bouquets?\b/i,                   unit: 'bouquet' },
  { re: /^gousses?\b/i,                    unit: 'gousse' },
];

// ─── Parse ────────────────────────────────────────────────────────────────────

/**
 * Décompose une chaîne ingrédient en {qty, unit, name}.
 * qty  : nombre (null si absent ou non parsable)
 * unit : chaîne normalisée (null si pas d'unité détectée)
 * name : nom de l'ingrédient nettoyé
 */
function parseIngredient(str) {
  let rest = str.toLowerCase().trim();
  let qty = null;

  // 1) Fraction avec entier "1 1/2"
  const intFrac = rest.match(/^(\d+)\s+(\d+)\/(\d+)/);
  if (intFrac) {
    qty  = parseInt(intFrac[1]) + parseInt(intFrac[2]) / parseInt(intFrac[3]);
    rest = rest.slice(intFrac[0].length).trim();
  } else {
    // 2) Fraction simple "1/2"
    const frac = rest.match(/^(\d+)\/(\d+)/);
    if (frac) {
      qty  = parseInt(frac[1]) / parseInt(frac[2]);
      rest = rest.slice(frac[0].length).trim();
    } else {
      // 3) Nombre décimal "500" ou "1,5"
      const num = rest.match(/^(\d+[\.,]?\d*)/);
      if (num) {
        qty  = parseFloat(num[1].replace(',', '.'));
        rest = rest.slice(num[0].length).trim();
      }
    }
  }

  // 4) Unité
  let unit = null;
  for (const { re, unit: u } of UNIT_PATTERNS) {
    if (re.test(rest)) {
      unit = u;
      rest = rest.replace(re, '').trim();
      break;
    }
  }

  // 5) Nettoyer "de / d' / du / des / un / une / quelques"
  rest = rest.replace(/^(de |d'|du |des |un |une |quelques )/i, '').trim();

  return { qty, unit, name: rest };
}

// ─── Conversion d'unités ─────────────────────────────────────────────────────

/**
 * Retourne le type d'une unité ("mass", "volume", "count") et sa valeur
 * convertie en unité de base (g ou ml).
 */
function toBase(qty, unit) {
  if (!qty || !unit) return { base: qty ?? 1, type: 'count' };

  const massMultiplier = MASS_TO_G[unit];
  if (massMultiplier !== undefined) return { base: qty * massMultiplier, type: 'mass' };

  const volMultiplier = VOLUME_TO_ML[unit];
  if (volMultiplier !== undefined) return { base: qty * volMultiplier, type: 'volume' };

  return { base: qty, type: 'count' };
}

/**
 * Revert une valeur en base vers l'unité cible.
 * Ex : 500 (g) → kg = 0.5
 */
function fromBase(baseQty, targetUnit) {
  if (!targetUnit) return baseQty;

  const massMultiplier = MASS_TO_G[targetUnit];
  if (massMultiplier !== undefined) return baseQty / massMultiplier;

  const volMultiplier = VOLUME_TO_ML[targetUnit];
  if (volMultiplier !== undefined) return baseQty / volMultiplier;

  return baseQty;
}

// ─── Calcul de la quantité à déduire ─────────────────────────────────────────

/**
 * Calcule la quantité à déduire du produit en stock.
 *
 * Gère les cas :
 *  - Même famille d'unités (g→kg, ml→cl, etc.) : conversion propre
 *  - Unités incompatibles (g vs ml) : utilise la quantité brute de la recette
 *  - Pas de quantité dans la recette : déduit 1 unité du stock
 *
 * @param {string} ingredientStr  Chaîne brute de la recette ("500g de farine")
 * @param {string} productUnit    Unité du produit en stock ("kg")
 * @param {number} productQty     Quantité disponible en stock
 * @returns {number}              Quantité à déduire, dans l'unité du produit
 */
function computeSuggestedQty(ingredientStr, productUnit, productQty) {
  const parsed = parseIngredient(ingredientStr);

  // Pas de quantité dans la recette → déduire 1 unité si possible
  if (!parsed.qty) {
    return Math.min(1, productQty ?? 0);
  }

  const { base: recipeBase, type: recipeType } = toBase(parsed.qty, parsed.unit);
  const { type: productType } = toBase(productQty, productUnit);

  let suggested;

  if (recipeType === productType && recipeType !== 'count') {
    // Même famille (g↔kg, ml↔cl…) → conversion propre
    suggested = fromBase(recipeBase, productUnit);
  } else if (!parsed.unit) {
    // Pas d'unité dans la recette → quantité déjà dans l'unité du stock
    // ex : "2 oignons" face à 3 en stock → déduit 2
    suggested = parsed.qty;
  } else if (recipeType !== 'count' && productType === 'count') {
    // Recette en masse/volume, stock en pièces → impossible à convertir
    // ex : "500g d'oignons" face à 3 en stock → déduit 1 pièce prudemment
    suggested = 1;
  } else {
    // Autre cas incompatible (volume vs masse) → quantité brute de la recette
    suggested = parsed.qty;
  }

  // Ne jamais suggérer plus que ce qui est disponible, arrondir à 2 décimales
  return Math.min(Math.round(suggested * 100) / 100, productQty ?? 0);
}

module.exports = { parseIngredient, computeSuggestedQty };
