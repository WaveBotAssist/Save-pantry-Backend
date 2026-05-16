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
  "confidence": 0.95
}

Règles :
- titre : nom principal de la recette
- ingredients : chaque ingrédient avec sa quantité et son unité
- instructions : étapes dans l'ordre, une étape par élément
- temps_preparation : durée totale en minutes (null si non indiqué)
- portion : nombre de personnes (null si non indiqué)
- confidence : 0 (image illisible) → 1 (parfaitement lisible)
- Si pas de recette : { "titre": "", "ingredients": [], "instructions": [], "confidence": 0 }`,
    config: { temperature: 0.1 },
  });
}

// ─── Extraction depuis une URL ────────────────────────────────────────────────

async function extractRecipeFromUrl(url) {
  const cheerio = require("cheerio");//Cheerio Librairie JavaScript qui permet de lire et manipuler du HTML très facilement
  const fetch = require('node-fetch');


  const controller = new AbortController();//API JavaScript qui permet d’annuler une requête asynchrone
  const timeout = setTimeout(() => controller.abort(), 10_000);// Après 10 secondes le fetch est stoppé

  let html;
  try {
    const res = await fetch(url, {
      signal: controller.signal, //écoute ce signal
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} — impossible d'accéder à la page.`);
    html = await res.text();

  } finally {
    clearTimeout(timeout);
  }
  // Cherche la balise og:image dans le HTML brut grace a cheerio
  const $ = cheerio.load(html);//$ devient une fonction pour naviguer dans le HTML Exactement comme document.querySelector

  const image =
  $('meta[property="og:image"]').attr("content") //.text() lire le text .attr() lire l attribut
  ||
    $('meta[property="og:image:url"]').attr('content') ||
    // Twitter card
    $('meta[name="twitter:image"]').attr('content') ||
    $('meta[name="twitter:image:src"]').attr('content') ||
   // Certains sites utilisent name au lieu de property
    $('meta[name="og:image"]').attr('content') ||
   // Schema.org
    $('meta[itemprop="image"]').attr('content')
  ||
   // Lien image_src (ancien format)
    $('link[rel="image_src"]').attr('href') ||
   // Première grande image dans le contenu
  (fallback)
    $('article img, .recipe img, mainimg').first().attr('src') ||
   null;


  $("script").remove(); //supprime les script
  $("style").remove(); // supprime les styles

  const text = $("body")
    .text()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12_000);

  if (text.length < 100) throw new Error("La page ne contient pas assez de contenu textuel.");

  return callGemini({
    model: GEMINI_MODELS.flashLite,
    prompt: `Voici le contenu texte d'une page web. Extrais la recette si elle est présente. JSON uniquement.

Format attendu :
{
  "titre": "Nom de la recette",
  "image": ${image}
  "ingredients": [
    { "name": "Farine", "quantity": "200", "unit": "g" }
  ],
  "instructions": ["Étape 1...", "Étape 2..."],
  "temps_preparation": 30,
  "portion": 4,
  "confidence": 0.95,
  "categorie": "Plat principal"
  }

Règles :
- Extrais UNIQUEMENT les données de la recette, ignore publicité et navigation
- temps_preparation en minutes (null si absent), portion en personnes (null si absent)
- confidence : 0 si aucune recette, 1 si recette complète
- Si aucune recette : { "titre": "", "ingredients": [], "instructions": [], "confidence": 0 }
- Attribue une categorie correspondante à la recette pour la clé categorie avec une des valeur suivantes
  "Petit-déjeuner",
  "Brunch",
  "Entrée",
  "Plat principal",
  "Viande",
  "Pates",
  "Riz",
  "Salade",
  "Soupe",
  "Dessert",
  "Collation",
  "Apéritif",
  "Déjeuner",
  "Dîner",
  "Boisson",
  "Autre",
  "Entrée"

Contenu de la page :
${text}`,
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

async function generateRecipeFromStock(products) {
  const pantryList = products.length > 0
    ? products.map(p => `- ${p.name} (${p.quantite} ${p.unit})`).join('\n')
    : 'Garde-manger vide';

  return callGemini({
    model: GEMINI_MODELS.flashLite,
    prompt: `Tu es un chef cuisinier expert. À partir du garde-manger ci-dessous, propose une vraie recette de cuisine reconnue et délicieuse qui utilise au maximum les ingrédients disponibles.

GARDE-MANGER DISPONIBLE :
${pantryList}

ÉTAPE 1 — VALIDATION :
Identifie uniquement les vrais aliments ou boissons comestibles dans la liste.
Ignore tout ce qui n'est pas un aliment réel (mots inventés, objets, non-sens...).
Si moins de 2 vrais aliments identifiés → retourne : { "erreur": "stock_invalide" }

ÉTAPE 2 — SÉLECTION DE LA RECETTE (seulement si stock valide) :
Choisis une vraie recette (plat traditionnel, classique, populaire) qui :
- utilise en priorité les ingrédients du garde-manger
- est savoureuse, équilibrée, réalisable par un amateur
Tu peux compléter avec des basiques courants (sel, poivre, huile, ail, beurre...).
Ne mélange pas des ingrédients incohérents.

JSON uniquement :

Format si stock valide :
{
  "titre": "Nom de la recette",
  "ingredients": [
    { "name": "Nom ingrédient", "quantity": "quantité", "unit": "unité" }
  ],
  "instructions": ["Étape 1...", "Étape 2..."],
  "temps_preparation": 30,
  "portion": 4,
  "confidence": 1
}

Format si stock invalide :
{ "erreur": "stock_invalide" }`,
    config: { temperature: 0.7 },
  });
}

module.exports = { extractRecipeFromImage, extractRecipeFromUrl, generateWeeklyPlan, generateRecipeFromStock };
