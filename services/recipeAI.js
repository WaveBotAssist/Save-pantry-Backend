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
- temps_preparation : durée totale en minutes (null si non indiqué)
- portion : nombre de personnes (null si non indiqué)
- categorie : une seule valeur parmi — Petit-déjeuner, Brunch, Entrée, Plat principal, Viande, Pates, Riz, Salade, Soupe, Dessert, Collation, Apéritif, Déjeuner, Dîner, Boisson, Autre
- confidence : 0 (image illisible) → 1 (parfaitement lisible)
- Si pas de recette : { "titre": "", "ingredients": [], "instructions": [], "confidence": 0 }`,
    config: { temperature: 0.1 },
  });
}


// ─── Génération de planning hebdomadaire ──────────────────────────────────────

/**
 * Génère un planning dîner sur 7 jours.
 *
 * Stratégie anti-gaspillage :
 *  1. Gemini couvre d'abord les produits expirants avec les recettes qui en utilisent le maximum
 *  2. Quand aucune recette ne correspond aux produits restants, il utilise librement les autres recettes
 *
 * @param {Array} expiringProducts - Produits expirant dans ≤ 3 jours
 * @param {Array} otherProducts    - Reste du garde-manger
 * @param {Array} recipes          - Recettes personnelles (max 40, mélangées aléatoirement)
 * @param {string} weekStart       - Date de début de semaine (YYYY-MM-DD)
 */
async function generateWeeklyPlan(expiringProducts, otherProducts, recipes, weekStart) {
  // Liste des produits expirants — priorité absolue dans le planning
  const expiringList = expiringProducts.length > 0
    ? expiringProducts.map(p =>
      `- ${p.name} (${p.quantite} ${p.unit}, expire le ${new Date(p.expiration).toLocaleDateString('fr-FR')})`
    ).join('\n')
    : 'Aucun produit expirant dans les 3 prochains jours';

  // Reste du stock — utilisé librement pour les autres jours
  const otherList = otherProducts.length > 0
    ? otherProducts.map(p => `- ${p.name} (${p.quantite} ${p.unit})`).join('\n')
    : 'Aucun autre produit en stock';

  // Recettes disponibles avec leurs ingrédients principaux
  const recipeList = recipes.length > 0
    ? recipes.map(r => {
      const ingredNames = (r.ingredients ?? []).slice(0, 5)
        .map(i => (typeof i === 'string' ? i : i.name))
        .filter(Boolean)
        .join(', ');
      return `- ID:${r._id} | ${r.titre} (${ingredNames})`;
    }).join('\n')
    : 'Aucune recette enregistrée';

  return callGemini({
    model: GEMINI_MODELS.flashLite,
    prompt: `Tu es un assistant de planification de repas anti-gaspillage.

PRODUITS EXPIRANTS (≤ 3 jours) — priorité absolue :
${expiringList}

RESTE DU STOCK :
${otherList}

RECETTES DISPONIBLES :
${recipeList}

Génère un planning dîner varié pour les 7 jours de la semaine du ${weekStart}.

RÈGLE PRIORITAIRE (anti-gaspillage) :
1. Commence par les produits expirants. Pour chaque jour, cherche d'abord une recette de la liste qui en utilise le maximum.
2. Si aucune recette de la liste ne les contient, propose une VRAIE recette connue (plat traditionnel, classique) qui utilise ces produits — recipeId: null. Ne passe PAS aux recettes ajoutées tant qu'il reste des produits expirants non couverts.
3. Retire les produits couverts et recommence avec ce qui reste.
4. Une fois tous les produits expirants couverts, utilise librement les recettes de la liste pour les jours restants.
5. Si aucun produit n'expire dans 3 jours, propose un planning varié avec les recettes disponibles.
6. Ne répète jamais le même plat deux fois. Varie les types (pasta, viande, légumes, soupe, wok, gratin...).

JSON uniquement :
{
  "meals": [
    {
      "dayKey": "Monday",
      "recipeTitle": "Nom du repas",
      "recipeId": "id_exact_ou_null",
      "reason": "Utilise les courgettes et les œufs qui expirent demain"
    }
  ],
  "missingIngredients": [
    { "name": "Pâtes", "quantity": "500", "unit": "g" }
  ]
}

- dayKey : "Monday" → "Sunday"
- recipeId : ID exact de la recette depuis la liste, sinon null
- reason : une phrase courte expliquant le choix anti-gaspillage
- missingIngredients : ingrédients absents du stock nécessaires au planning`,
    config: { temperature: 0.8 },
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
- Utilise les ingrédients du garde-manger. Priorité aux produits marqués [EXPIRE DANS XJ] ou [EXPIRÉ] pour éviter le gaspillage, mais uniquement s'ils s'intègrent naturellement dans un vrai plat.
- CRITIQUE — nom exact : pour chaque ingrédient qui provient du garde-manger, reprend son nom EXACTEMENT tel qu'il apparaît dans la liste ci-dessus (ex: si le garde-manger contient "GOUDA EN TRANCHE", écris "GOUDA EN TRANCHE" dans "name", pas "gouda" ni "fromage").
- Complète avec des basiques (sel, poivre, huile, beurre…) si nécessaire — ceux-là peuvent avoir un nom libre.
- Les quantités sont des quantités culinaires réelles (ex: "200" g). Jamais "pièce(s)".

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

module.exports = { extractRecipeFromImage, generateWeeklyPlan, generateRecipeFromStock };
