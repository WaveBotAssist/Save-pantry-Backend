/**
 * recipeAI.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Fonctions IA pour les recettes et le planning.
 * Toute la configuration Gemini est centralisée dans config/geminiClient.js.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { callGemini, GEMINI_MODELS } = require('../config/geminiClient');

// ─── Extraction depuis une image ──────────────────────────────────────────────

async function extractRecipeFromImage(base64Image, mimeType = 'image/jpeg') {
  return callGemini({
    model: GEMINI_MODELS.flash,
    image: { data: base64Image, mimeType },
    prompt: `Analyse cette image de recette et extrais les informations. JSON uniquement, aucun texte avant ou après.

Format attendu :
{
  "titre": "Nom de la recette",
  "ingredients": [
    { "name": "Farine", "quantity": "200", "unit": "g" }
  ],
  "instructions": ["Étape 1 détaillée...", "Étape 2..."],
  "temps_preparation": 30,
  "portion": 4,
  "categorie": "Plat principal",
  "confidence": 0.95
}

Règles :
- titre : nom principal de la recette
- ingredients : TOUS les ingrédients avec quantité et unité. Si la liste n'est pas visible mais que les instructions les mentionnent, déduis-les depuis le texte des étapes. Ne laisse jamais ce tableau vide si la recette est identifiable.
- instructions : étapes dans l'ordre, une étape par élément
- temps_preparation : durée totale en minutes, UN SEUL NOMBRE ENTIER, jamais de texte ni de fourchette (null si non indiqué). Ex: "30-40 minutes" → 35
- portion : nombre de personnes, UN SEUL NOMBRE ENTIER, jamais de texte ni de fourchette (null si non indiqué). Ex: "5 à 6 personnes" → 5
- categorie : une seule valeur parmi — Petit-déjeuner, Brunch, Entrée, Plat principal, Viande, Pates, Riz, Salade, Soupe, Dessert, Collation, Apéritif, Déjeuner, Dîner, Boisson, Autre
- confidence : 0 (image illisible) → 1 (parfaitement lisible)
- Si pas de recette : { "titre": "", "ingredients": [], "instructions": [], "confidence": 0 }`,
    config: { temperature: 0.1 },
  });
}


// ─── Extraction depuis le texte d'une vidéo (description + sous-titres) ──────

/**
 * Transforme le texte écrit par le créateur d'une vidéo (description
 * YouTube + sous-titres, ou légende Instagram/TikTok) en recette structurée.
 *
 * @param {string} text     - Description et/ou sous-titres de la vidéo
 * @param {string} platform - 'youtube' | 'instagram' | 'tiktok' (pour le contexte du prompt)
 */
async function extractRecipeFromVideoText(text, platform) {
  const recipe = await callGemini({
    model: GEMINI_MODELS.flashLite,
    prompt: `Voici le texte associé à une vidéo de recette de cuisine (${platform}) :
la description du créateur et/ou la transcription des sous-titres (les deux
séparés par une ligne vide si disponibles). Ce texte peut contenir des
éléments hors-sujet (hashtags, emojis, appels à s'abonner/liker, liens,
mentions de sponsors, hésitations à l'oral comme "euh", "voilà") à ignorer.

TEXTE :
"""
${text}
"""

Analyse ce texte et extrais la recette de cuisine qu'il décrit. JSON uniquement, aucun texte avant ou après.

Format attendu :
{
  "titre": "Nom de la recette",
  "ingredients": [
    { "name": "Farine", "quantity": "200", "unit": "g" }
  ],
  "instructions": ["Étape 1 détaillée...", "Étape 2..."],
  "temps_preparation": 30,
  "portion": 4,
  "categorie": "Plat principal",
  "confidence": 0.9
}

Règles :
- titre : nom de la recette préparée dans la vidéo
- ingredients : TOUS les ingrédients mentionnés, avec quantité et unité séparées. Si une quantité n'est pas précisée, laisse "quantity" et "unit" vides ("").
- instructions : étapes de préparation dans l'ordre, reformulées de façon claire et concise (pas de transcription mot à mot des hésitations orales)
- temps_preparation : durée totale en minutes, UN SEUL NOMBRE ENTIER, jamais de texte ni de fourchette (null si non indiqué). Ex: "30-40 minutes" → 35
- portion : nombre de personnes, UN SEUL NOMBRE ENTIER, jamais de texte ni de fourchette (null si non indiqué). Ex: "5 à 6 personnes" → 5
- categorie : une seule valeur parmi — Petit-déjeuner, Brunch, Entrée, Plat principal, Viande, Pates, Riz, Salade, Soupe, Dessert, Collation, Apéritif, Déjeuner, Dîner, Boisson, Autre
- confidence : 0 (aucune recette identifiable dans ce texte) → 1 (recette complète et claire)
- Si ce texte ne décrit aucune recette de cuisine : { "titre": "", "ingredients": [], "instructions": [], "confidence": 0 }`,
    config: { temperature: 0.1 },
  });

  // Filet de sécurité : si Gemini renvoie malgré tout une fourchette ("5 à 6")
  // ou du texte pour ces deux champs, on extrait le premier nombre pour éviter
  // une erreur de validation Mongoose (UserRecipe attend un Number).
  return {
    ...recipe,
    temps_preparation: toIntOrNull(recipe.temps_preparation),
    portion: toIntOrNull(recipe.portion),
  };
}

/** Extrait le premier nombre entier d'une valeur ("5 à 6" → 5, 30 → 30, "" → null). */
function toIntOrNull(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null;
  const match = String(value).match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}


// ─── Génération de planning sur N jours ──────────────────────────────────────

/**
 * Génère un planning dîner pour une liste de dates (7 ou 14 jours).
 *
 * Stratégie anti-gaspillage :
 *  1. Gemini couvre d'abord les produits expirants avec les recettes qui en utilisent le maximum
 *  2. Quand aucune recette ne correspond, il propose un plat connu (recipeId: null)
 *  3. Varie les types de plat sur toute la durée pour éviter la monotonie
 *
 * @param {Array}    expiringProducts - Produits expirant dans ≤ 3 jours
 * @param {Array}    otherProducts    - Reste du garde-manger
 * @param {Array}    recipes          - Recettes personnelles (mélangées aléatoirement)
 * @param {string[]} dates            - Dates à planifier au format YYYY-MM-DD
 */
async function generateWeeklyPlan(expiringProducts, otherProducts, recipes, dates) {
  const expiringList = expiringProducts.length > 0
    ? expiringProducts.map(p =>
      `- ${p.name} (${p.quantite} ${p.unit}, expire le ${new Date(p.expiration).toLocaleDateString('fr-FR')})`
    ).join('\n')
    : 'Aucun produit expirant dans les 3 prochains jours';

  const otherList = otherProducts.length > 0
    ? otherProducts.map(p => `- ${p.name} (${p.quantite} ${p.unit})`).join('\n')
    : 'Aucun autre produit en stock';

  const recipeList = recipes.length > 0
    ? recipes.map(r => {
      const ingredNames = (r.ingredients ?? []).slice(0, 5)
        .map(i => (typeof i === 'string' ? i : i.name))
        .filter(Boolean)
        .join(', ');
      return `- ID:${r._id} | ${r.titre} (${ingredNames})`;
    }).join('\n')
    : 'Aucune recette enregistrée';

  const daysList = dates.map(d => {
    const dayName = new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long' });
    return `${dayName} ${d}`;
  }).join('\n- ');

  return callGemini({
    model: GEMINI_MODELS.flashLite,
    prompt: `Tu es un assistant de planification de repas anti-gaspillage.

PRODUITS EXPIRANTS (≤ 3 jours) — priorité absolue :
${expiringList}

RESTE DU STOCK :
${otherList}

RECETTES DISPONIBLES :
${recipeList}

Génère un planning dîner varié pour les ${dates.length} jours suivants :
- ${daysList}

RÈGLE PRIORITAIRE (anti-gaspillage) :
1. Choisis UNIQUEMENT parmi les recettes de la liste ci-dessus — n'invente jamais de plat, recipeId doit toujours être un ID exact de cette liste.
2. Commence par les produits expirants. Pour chaque jour, cherche d'abord la recette de la liste qui en utilise le maximum.
3. Si aucune recette de la liste ne contient les produits expirants, choisis quand même une recette EXISTANTE de la liste pour ce jour.
4. Chaque recette ne doit apparaître qu'UNE SEULE FOIS dans tout le planning — ne propose jamais deux fois le même recipeId, même à des dates différentes.      
5. Exception : si le nombre de jours dépasse le nombre de recettes disponibles, répète uniquement en dernier recours, et espace les répétitions le plus possible jamais deux jours qui se suivent).    
6. Si la liste est vide, laisse "meals" vide — ne propose rien.

JSON uniquement :
{
  "meals": [
    {
      "date": "YYYY-MM-DD",
      "recipeTitle": "Nom du repas",
      "recipeId": "id_exact_de_la_liste",
      "reason": "Courgettes et œufs à utiliser"
    }
  ],
  "missingIngredients": [
    { "name": "Pâtes", "quantity": "500", "unit": "g" }
  ]
}

- date : date exacte depuis la liste ci-dessus (format YYYY-MM-DD)
- recipeId : ID exact de la recette depuis la liste — jamais null, jamais inventé
- reason : 5 mots maximum, jamais une phrase complète
- missingIngredients : ingrédients absents du stock nécessaires au planning`,
    // maxOutputTokens : un simple doublement (6144) laissait trop peu de marge
    // pour 14 jours — la moindre "reason" un peu longue suffisait à tronquer
    // le JSON en plein milieu (SyntaxError au parsing, puis retry inutile sur
    // le même budget trop juste). 16384 laisse une vraie marge (gratuit si non
    // utilisé — Gemini facture les tokens générés, pas le plafond configuré).
    // "reason" raccourci au prompt pour réduire la variance de longueur.
    config: { temperature: 0.6, maxOutputTokens: dates.length > 7 ? 16384 : 4096 },
    // Le planning 2 semaines envoie ~1,5x plus de recettes — le budget par
    // défaut (20s) le faisait parfois timeout avant que Gemini ait fini.
    timeoutMs: dates.length > 7 ? 38_000 : 20_000,
  });
}

// ─── Génération d'une recette depuis le stock ─────────────────────────────────

async function generateRecipeFromStock(products, lang = 'fr') {
  const langInstruction = lang === 'fr'
    ? 'Réponds entièrement en français.'
    : 'Respond entirely in English.';
  const now = new Date();

  const pantryList = products.length > 0
    ? products.map(p => {
        if (!p.expiration) return `- ${p.name}`;
        const daysLeft = Math.ceil((new Date(p.expiration) - now) / 86_400_000);
        if (daysLeft < 0)  return `- ${p.name} [EXPIRÉ]`;
        if (daysLeft <= 3) return `- ${p.name} [EXPIRE DANS ${daysLeft}J]`;
        return `- ${p.name}`;
      }).join('\n')
    : 'Garde-manger vide';

  return callGemini({
    model: GEMINI_MODELS.flashLite,
    prompt: `Tu es un chef cuisinier. Propose UNE recette réelle et connue (pas inventée) réalisable avec ce garde-manger.

GARDE-MANGER :
${pantryList}

Règles :
- Si moins de 2 vrais aliments dans la liste → retourne : { "erreur": "stock_invalide" }
- La recette doit avoir un nom connu et reconnaissable (ex: "Omelette aux champignons", "Pâtes carbonara"). Jamais un nom inventé.
- Le garde-manger est une source d'ingrédients disponibles, pas une liste à tout utiliser. Choisis UNE recette réelle, puis n'inclus que les ingrédients du garde-manger qui appartiennent naturellement à ce plat. Ne force jamais un ingrédient (croissant, café, dessert, boisson…) dans un plat où il n'a pas sa place culinaire. Mieux vaut ignorer un ingrédient du garde-manger que de dénaturer la recette.
- Priorité aux produits marqués [EXPIRE DANS XJ] ou [EXPIRÉ] pour éviter le gaspillage, mais seulement si ce produit s'intègre naturellement dans la recette choisie.
- CRITIQUE — nom exact : pour chaque ingrédient qui provient du garde-manger, reprend son nom EXACTEMENT tel qu'il apparaît dans la liste ci-dessus (ex: si le garde-manger contient "GOUDA EN TRANCHE", écris "GOUDA EN TRANCHE" dans "name", pas "gouda" ni "fromage").
- Complète avec des basiques (sel, poivre, huile, beurre…) si nécessaire — ceux-là peuvent avoir un nom libre.
- "quantity" doit être un nombre entier ou décimal uniquement (ex: "200", "2", "0.5"). Jamais un adjectif, jamais du texte (interdit : "2 moyen", "1 grand", "quelques", "au goût").
- "unit" contient l'unité séparée (g, kg, ml, cl, L, c. à soupe, c. à café, pincée, tranche, feuille). Pour les ingrédients comptables sans unité de masse, utilise "unité" comme unit (ex: quantity: "2", unit: "unité").

JSON uniquement :

Format si stock valide :
{
  "titre": "Nom de la recette",
  "categorie": "Plat principal",
  "ingredients": [
    { "name": "Nom ingrédient", "quantity": "quantité", "unit": "unité" }
  ],
  "instructions": ["Étape 1...", "Étape 2..."],
  "temps_preparation": 30,
  "portion": 4,
  "confidence": 1
}

categorie — exactement une valeur parmi : Petit-déjeuner | Brunch | Entrée | Plat principal | Viande | Pates | Riz | Salade | Soupe | Dessert | Collation | Apéritif | Déjeuner | Dîner | Boisson | Autre

Format si stock invalide :
{ "erreur": "stock_invalide" }

${langInstruction}`,
    config: { temperature: 0.3 },
  });
}

module.exports = { extractRecipeFromImage, extractRecipeFromVideoText, generateWeeklyPlan, generateRecipeFromStock };
