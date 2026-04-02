/**
 * ApiGemini.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Service d'analyse de ticket de caisse via l'API Gemini (Google GenAI).
 *
 * Reçoit le texte OCR d'un ticket de caisse (extrait côté frontend via
 * @react-native-ml-kit/text-recognition) et retourne une liste structurée
 * de produits alimentaires au format JSON.
 *
 * Modèle utilisé : gemini-2.5-flash-lite
 *   → Rapide, peu coûteux, suffisant pour l'extraction de données textuelles.
 *
 * Catégories reconnues (doivent rester synchronisées avec EXPIRY_DAYS_BY_CATEGORY
 * dans utils/receiptExpiryDates.js et avec categorieList dans reducers/user.js) :
 *   "Produits laitiers" | "Féculents" | "Fruits et légumes" | "Matières grasses"
 *   "Produits sucrés" | "Boissons" | "Viande, Poisson, oeuf" | "Sauces"
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { GoogleGenAI } = require('@google/genai');

// Initialisation du client Gemini avec la clé API depuis les variables d'environnement
const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

/**
 * Analyse le texte OCR d'un ticket de caisse et extrait les produits alimentaires.
 *
 * @param {string} ocrText - Texte brut extrait par OCR depuis la photo du ticket
 * @returns {Promise<{
 *   store: string,
 *   date: string,
 *   items: Array<{ name: string, price: number, category: string }>,
 *   total: number
 * }>} Objet JSON structuré avec les produits du ticket
 *
 * @throws {Error} Si l'API Gemini échoue ou retourne un JSON invalide
 */
async function ApiGemini(ocrText) {
  // ─────────────────────────────────────────────────────────────────────────
  // PROMPT : on demande à Gemini d'extraire uniquement les produits alimentaires
  // et de les classer par catégorie.
  // La catégorie est importante car elle sert à calculer la date d'expiration
  // approximative dans receiptExpiryDates.js.
  // ─────────────────────────────────────────────────────────────────────────
  const prompt = `
Tu es un expert en tickets de caisse de supermarchés.

Le texte OCR ci-dessous liste les lignes du ticket. Chaque ligne peut être :
- Un produit seul : "PAIN"
- Un produit avec son prix associé : "PAIN | PRIX: 1,80"
- Un prix seul (ligne de prix orpheline) : "1,80"

${ocrText}

ASSOCIATION : si le prix est sur la même ligne après "| PRIX:", utilise-le directement. Si le prix est sur la ligne suivante sans produit, associe-le au produit précédent.
Si le prix est aberrant pour ce produit → price: 0.
Si un produit n'a pas de prix associable → price: 0.

OCR BRUIT : l'OCR fait des erreurs de caractères. Deux niveaux de correction :
1. Si tu reconnais le produit avec certitude (produit courant de supermarché français) → corrige le nom complet. Ex: "SANOWIOHES BEURRE" → "SANDWICHES BEURRE", "BOLKETTES" → "BOULETTES", "HADHE PREPARE" → "HACHE PREPARE", "BOISSON CAFE LATIE" → "BOISSON CAFE LATTE".
2. Si tu n'es pas sûr → corrige uniquement les substitutions de caractères évidentes (0→O, 8→B, N→M, etc.) sans reformuler. Ex: "JANBON" → "JAMBON".
Règle absolue : ne réinterprète jamais un nom vers un mot qui change le sens (ex: "BEURRE" ne devient jamais "BELLE"). En cas de doute, garde le nom tel quel.
Corrige aussi les prix aberrants dans un groupe de lignes similaires (ex: deux Volvic à 9,07 et 3,07 → le 9,07 est une erreur OCR du 3,07 → price: 3.07).

REGROUPEMENT : si plusieurs lignes ont des noms identiques ou très proches (variantes OCR) et le même prix corrigé → c'est le même produit acheté plusieurs fois. Retourne UN SEUL item avec quantity = nombre de lignes. Ex: "VOLVIC" 2 fois à 3,07 → quantity=2.
Exception : produits vendus au poids (cas 4). Deux packs du même produit au même prix/kg = deux achats séparés car le poids est différent → retourne UN item par ligne avec quantity=1 chacun (le backend les comptera). Ex: "AILES DE POULET" à 7,49€/kg apparaît 2 fois → deux items séparés quantity=1, pas un seul quantity=2.

QUANTITÉ (cas 0) — nombre EN DÉBUT de ligne avant le nom : si la ligne commence par un entier isolé (séparé du reste par un espace) suivi d'un nom de produit, cet entier est la quantité.
  Ex: "2 Biscuit tango | PRIX: 2,00" → quantity=2, name="Biscuit tango", price=2.00
  Ex: "8 Bnina | PRIX: 216,00" → quantity=8, name="Bnina", price=216.00
  Ex: "12 Flan caramel soumam" (prix sur ligne suivante) → quantity=12, name="Flan caramel soumam"
  Exceptions — ne pas extraire la quantité si :
    • L'entier est 0 (ex: "0 22Gouda BARRE" → c'est un code référence "022", pas une quantité → quantity=1, name="Gouda BARRE")
    • L'entier est collé à la suite d'un autre chiffre sans espace (ex: "022FROMAGE" → code article)
  Retire toujours le chiffre de quantité du name final.
QUANTITÉ (cas 1) — "x N" dans une colonne séparée : "1,39 X 4  5,56" → quantity=4, price=1.39, name sans le "x N".
QUANTITÉ (cas 2) — "x N" à la fin du nom ou dans le nom : "SALADES x2" → quantity=2, name="SALADES". "CAFE LATE 0,99 x 6" → quantity=6, price=0.99, name="CAFE LATE". Applique cette règle même si le PRIX est illisible. Retire toujours le "x N" du name final.
QUANTITÉ (cas 3) — "prix X" sans quantité visible : déduis depuis le total si disponible. Ex: "RIZ AU LAIT 0,35 X" total=0,70 → quantity=2, price=0.35.
QUANTITÉ (cas 4) — vendu au poids UNIQUEMENT : "0,620 kg X 7,49EURO/kg" → quantity=1, price=7.49. Cette règle ne s'applique QUE si le format "kg X prix/kg" est présent.
Règle absolue : price = toujours le prix UNITAIRE.

ATTENTION — pack ≠ quantité :
- Si diviser le prix par N donne un prix irréaliste → c'est la description du contenu du pack → quantity=1, garde le "x N" dans le nom. Ex: "Yaourts x 12" à 1,75€ → 0,14€/yaourt, irréaliste → quantity=1, name="Yaourts x 12".
- Si diviser le prix par N donne un prix réaliste → c'est une vraie quantité → extrait le N, retire le "x N" du nom. Ex: "Salades x2" à 2,20€ → 1,10€/salade, réaliste → quantity=2, name="Salades".


Exclus totalement de items[] :
- Tout produit non alimentaire : parfum, démaquillant, cosmétique, savon, vêtements, chaussettes, DVD, MP4, cadre photo, tasses, cartouches d'encre, ustensiles de cuisine, couvercles, poêles, casseroles.
- Toutes les lignes de remise/réduction/promotion (ex: "-1,00", "REMISE", "PROMO", "ECO").
- Toutes les lignes qui sont des montants isolés (totaux, sous-totaux, TVA, acomptes).
- Règle absolue : si un produit ne peut pas recevoir une des 8 catégories alimentaires listées ci-dessous → il ne doit PAS apparaître dans items[]. Un item sans catégorie valide = produit non alimentaire = à exclure.
Pour un produit avec remise : garde le prix original avant réduction.

CATÉGORIE (utilise EXACTEMENT une de ces valeurs) :
  Produits laitiers | Féculents | Fruits et légumes | Matières grasses | Produits sucrés | Boissons | Viande, Poisson, oeuf | Sauces

Magasin : si tu reconnais l'enseigne, utilise EXACTEMENT une de ces valeurs (copie mot pour mot, sans modifier la casse) :
  Lidl | Intermarcher | Cora | Carrefour | Spar | Colruyt | Okay | Aldi | Auchan | Leader Price | Leclerc
Si l'enseigne n'est pas dans cette liste, écris son nom avec la première lettre en majuscule et le reste en minuscule (ex: "Casino", "Delhaize"). Ne devine jamais — si le nom est illisible, déformé, ou si tu as le moindre doute, laisse la valeur vide. Ne confonds pas une ville ou une adresse avec un magasin.
Date    : YYYY-MM-DD
Total   : valeur sur la ligne "TOTAL" ou "A payer" uniquement, jamais calculé

Réponds UNIQUEMENT avec ce JSON (sans markdown, sans backticks) :
{"store":"","date":"","items":[{"name":"","price":0.00,"quantity":1,"category":""}],"total":0.00}
`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-lite',
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
    config: {
      temperature: 0.1,       // Faible température = réponses déterministes et précises
      maxOutputTokens: 2000,  // Suffisant pour un ticket avec ~50 produits
      responseMimeType: 'application/json', // Force Gemini à retourner du JSON pur
      thinkingConfig: {
        thinkingBudget: 0,  // Désactive le thinking — inutile pour extraction structurée
      },
    },
  });

  // response.text est déjà une string JSON grâce à responseMimeType
  return JSON.parse(response.text);
}

module.exports = ApiGemini;
