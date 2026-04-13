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
You are a supermarket receipt parser. Receipt may be in any language. Apply rules below to the OCR text at the end.

INPUT: each line is "[PRODUCT] | PRIX: price", "[PRODUCT]" (no price), or "price" (orphan → assign to previous product). Skip non-product lines: address, phone, SIRET, website, register/ticket numbers, loyalty messages.
- SKIP any line where the text contains 2+ consecutive words that are not real words in any language after OCR correction (pure gibberish like "iplsi gral is", "loof iplsi gral") → promotional/noise line, not a product, even if it has a price.
- Orphan price line followed by article-code+name: if a line contains ONLY prices (no recognizable product name) AND the NEXT line starts with a numeric code glued to a name (e.g. "077aubergine", "003LAIT"), the prices belong to the FOLLOWING product, not the previous one. Strip the numeric prefix from the name. "1,49  1,15" + "077aubergine" → name=aubergine, price=1.49.

PRICES
- No assignable price → price: 0.
- Negative price = discount amount, not product price. Find "REMISE X%" line above → original = |discount| / (X/100). Ex: -2.72 with 50% above → price=5.44. Unknown % → price: 0.
- "." and "," are both decimal separators. NEVER convert to cents. "48.20"→48.20 (not 0.48). "60.25"→60.25 (not 0.60). "110,00"→110.00 (not 1.10). "1 000,00"→1000.00 (not 10.00).
- Space between digits = thousands separator. "1 000"→1000, "7 443"→7443. Never split on space inside a number.
- OCR space after decimal separator: "6, 58"→6.58, "1, 19"→1.19, "0, 72"→0.72. Remove the spurious space before parsing.
- Ignore VAT suffix after price: "2,99 B"→2.99, "3,07 EUR A"→3.07.
- Swapped columns: left side looks like a price + right side looks like a name → swap. "3,07 EUR A | PRIX: VOLVIC"→name=VOLVIC, price=3.07.
- Outlier: same product, one price deviates strongly → OCR error, use consistent price. "Volvic 9.07 + 3.07"→both 3.07. No similar line → price: 0.
- price = UNIT price always. ONLY divide when qty N is explicitly present in the text (digit before name, "x N", "X N", subtotal). NEVER divide because a price "seems too high" — the receipt may use a non-euro currency. "8 BEURRE | PRIX: 27.20"→price=3.40, qty=8. "CAFE LATTE 0,99 x6"→price=0.99, qty=6. "GEL JAVEL | PRIX: 110,00" (no qty) → price=110.00, qty=1.

OCR CORRECTION
1. Use your supermarket product knowledge to fix OCR-distorted names — apply broadly, not just to examples:
   SANOWIOHES BEURRE→SANDWICHES BEURRE, BOLKETTES/BOULIES/BOULEJTES→BOULETTES, HADHE PREPARE→HACHE PREPARE,
   BOISSON CAFE LATIE/LATE→BOISSON CAFE LATTE, PLAI AU FOUR ITALEN→PLAT AU FOUR ITALIEN,
   NARS BARRE GL ACEE→MARS BARRE GLACEE, FRTAES/FRI KES STEAKHOUSE→FRITES STEAKHOUSE,
   RIZ AU LAIT VANTEL→RIZ AU LAIT VANILLE, CHAUSSEE AUX MNES/DHAUSSEE AUX MUINES→CHAUSSEE AUX MOINES,
   BOUCHER IE/BOUCHER IE TRAD→BOUCHERIE TRAD, WIT LOOF→CHICONS (endive/chicory → Fruits et légumes).
2. If product not recognized: fix obvious chars (0→O, 8→B, 1→I, N→M, rn→m), remove spurious spaces (GL ACEE→GLACEE), merge split articles (I A→LA, D U→DU, D E→DE, A U→AU — this merging IS allowed even though it changes the text, because it restores a word the OCR split, not invents one). JANBON→JAMBON, PATURAGES I A BtRI→PATURAGES LA BRIE. Otherwise never change meaning. Doubt → keep as-is.

QUANTITY
- Integer before name (space-separated, not "0+digits" article code) → qty. "2 PRODUIT | PRIX: 4.00"→qty=2. Remove digit from name.
- "unit X qty total": "1,39 X 4 5,56"→qty=4, price=1.39.
- "qty unit total€" in price field: "PRIX: 2 65.07 130.14€"→qty=2, price=65.07.
- "unit total€" in price field: "PRIX: 60.25 180.75€"→qty=round(180.75/60.25)=3, price=60.25.
- "x N" in name or after unit: SALADES x2→qty=2; CAFE LATTE 0,99 x6→qty=6, price=0.99. Remove "x N" from name.
- "price X" + visible subtotal: RIZ 0,35 X + subtotal 0,70→qty=2.
- Following line "N x unit_price": next line after a product is "N x price" or "N X price" WHERE N is an INTEGER ≥ 1 → qty=N, price=unit_price (overrides the subtotal shown on product line). "Hahnchen Mini-Steaks  6,58 A" + "2 x 3,29"→qty=2, price=3.29. "CRÈME DESSERT  1,30 A" + "2 x 0,65"→qty=2, price=0.65.
- Weight format "W x P" or "W kg x P EUR/kg": the line after a product containing "kg x" or "kg X" is always a weight detail line, NOT a quantity. qty=1 always. NEVER add weights together across multiple lines.
  - PRIORITY RULE: if the product line already has a price → that price is always correct, ignore EUR/kg entirely. "Erdbeeren kg  2,28 A" + "8,458 kg x 4,98 EUR/kg"→price=2.28. "Bananen  0,72 A" + "8,730 kg x 0,99 EUR/kg"→price=0.72. Even if W×P/kg does not match the product line price (OCR error on W), the product line price wins.
  - If the weight line ends with a total AND no price on product line: use that total. "0,620 kg X 7,49EURO/kg  4,64 EUR"→price=4.64.
  - If no total anywhere → price=EUR/kg value, qty=1.
  - "+" at end of product name means weight detail follows on next line: "AILES DE POULET X8 +" + "0,620 kg X 7,49EURO/kg  4,64 EUR"→name="AILES DE POULET X8", qty=1, price=4.64.
  - Two lines with same product name + different weights = two SEPARATE items, never merge. "AILES DE POULET X8" at 4,64 + "AILES DE POULET X8" at 4,44 → two items, qty=1 each.
  - Strip "kg" from product name if it appears at the end: "Erdbeeren kg"→name="Erdbeeren".
- Pack ≠ qty: "x N" or "(x N)" in product name:
  - Inside parentheses "(x N)" → ALWAYS pack description, qty=1, price as shown. "Yaourts nature (x 12)  1,75€"→qty=1, price=1.75. Never divide.
  - Outside parentheses "x N" → price/N realistic AND N ≤ 6 → true qty, divide. "Salades x2  2,20€"→qty=2, price=1.10. price/N unrealistic OR N > 6 → pack description, qty=1.
  - (Skip if price precedes "x N" — already unit.)

GROUPING
Correct OCR first, then: same corrected name (≤2 char diff) + same numeric price → merge into one item, qty=count. "VOLVIC"+"V0LVIC" at 3.07→qty=2. Weight items → keep separate. "IPR CAFE LATTE MACCH" + "1PR CAFE LATIE MACCH" at 0.99→qty=2, name="CAFE LATTE MACCHIATO".

FILTER OUT
- Non-food: perfume, cosmetics, soap, clothing, DVD, cookware, etc.
- Department/counter labels with a price ARE valid products (e.g. "Boucherie Trad 8,83 EUR" = a meat purchase at the butcher counter → category "Viande, Poisson, oeuf"). Only exclude department names that have NO price.
- Discount lines (REMISE, PROMO, ECO, negative amounts) → remove line, keep product at pre-discount price.
- Bilingual promo lines (Lidl Belgium etc.): a line showing a translation of the previous product + garbled promo text + price (e.g. "wit loof iplsi gral is  1,69" after "CHICONS  1,89 x 2  3,78") → NOT a product, exclude.
- "offert", "gratuit", "3e offert", "offert" in a PRODUCT NAME (not a standalone line) means a bundle promotion — keep the product with its price as shown. "Café Espresso 100% arabica 3e offert  5,50€"→name="Café Espresso 100% arabica", price=5.50, qty=1. Only exclude if the entire line is a discount/credit with no product name.
- Amount lines: TOTAL, subtotal, VAT, "A payer", "MONTANT DÛ", "Zu zahlen", "ZU ZAHLEN". IMPORTANT: the product line immediately before these total lines is still a valid product — never skip it.
- No valid food category → exclude.

OUTPUT
category (exactly one): Produits laitiers | Féculents | Fruits et légumes | Matières grasses | Produits sucrés | Boissons | Viande, Poisson, oeuf | Sauces
store (exactly one if known): Lidl | Intermarche | Cora | Carrefour | Spar | Colruyt | Okay | Aldi | Auchan | Leader Price | Leclerc — else first-letter-uppercase (ex: "Casino"). Doubt or unreadable → "". Never use city/address as store name.
date: YYYY-MM-DD. total: copy from "TOTAL"/"A payer" line only, never calculate.

Respond ONLY with JSON (no markdown, no backticks):
{"store":"","date":"","items":[{"name":"","price":0.00,"quantity":1,"category":""}],"total":0.00}

OCR TEXT:
${ocrText}
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