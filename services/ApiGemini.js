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
 * Catégories reconnues (alimentaires + non alimentaires) :
 *   "Produits laitiers" | "Féculents" | "Fruits et légumes" | "Matières grasses"
 *   "Produits sucrés" | "Boissons" | "Viande, Poisson, oeuf" | "Sauces"
 *   "Hygiène" | "Entretien" | "Autre"
 * Les catégories alimentaires sont enrichies d'une date d'expiration via
 * utils/receiptExpiryDates.js (fallback 30 jours pour les autres).
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
  const prompt = `Supermarket receipt parser. Any language. JSON only.

INPUT
Lines: "[PRODUCT] | PRIX: price", "[PRODUCT]", or orphan price (assign to previous product ONLY IF that product has no price yet — if it already has one, assign to the NEXT named product instead).
Skip: address, phone, SIRET, website, ticket numbers, loyalty messages, gibberish (2+ consecutive non-words).
Orphan price + next line is numeric-code+name (e.g. "077aubergine"): price belongs to NEXT product, strip numeric prefix.

PRICES (always unit price)
- No price → 0. "." and "," both decimal separators, never convert to cents: "48.20"→48.20, "110,00"→110.00.
- Space between digits = thousands separator: "1 000"→1000. OCR space after decimal: "6, 58"→6.58.
- Ignore VAT suffix: "2,99 B"→2.99, "3,07 EUR A"→3.07.
- Negative = discount. If product has its own price → ignore discount line entirely. If no product price: original=|discount|/(X/100) from "REMISE X%" above; unknown %→0.
- Swapped columns (price left, name right): swap. "3,07 EUR A | PRIX: VOLVIC"→name=VOLVIC, price=3.07.
- Same product, one price deviates strongly → use consistent price. No similar line → 0.
- NEVER divide price unless qty is explicit in text. "GEL JAVEL 110,00" (no qty)→price=110.00, qty=1.

QUANTITY
- Integer before name (not "0+digits" article code) → qty, remove from name. "2 PRODUIT 4.00"→qty=2.
- "unit X qty total": verify unit×qty≈total (±0.02); if not → price=total/qty. "9,35 X 2 0,70"→price=0.35.
- "PRIX: qty unit total€": "PRIX: 2 65.07 130.14€"→qty=2, price=65.07.
- "PRIX: unit total€": qty=round(total/unit). "PRIX: 60.25 180.75€"→qty=3, price=60.25.
- "x N" in name or after price → qty=N, remove from name. "CAFE LATTE 0,99 x4"→qty=4, price=0.99.
- Next line "N x price": overrides product qty/price. "Mini-Steaks 6,58" + "2 x 3,29"→qty=2, price=3.29.
- "W kg x P EUR/kg" (or "W kg X P EURO/kg") after product = weight line. qty=1 ALWAYS — NEVER use the weight in kg as quantity.
  - Product has price on its own line → keep that price, ignore kg line entirely.
  - No product price → look for a TOTAL amount at the END of the kg line (after the EUR/kg rate):
    - If a total is present (e.g. "0.603 kg X 9.09 EUR/kg  5.48 EUR"): price = TOTAL (5.48), NOT the per-kg rate (9.09). qty=1.
    - If no total at end of line: price = EUR/kg rate, qty=1.
  - CRITICAL: "0.603 kg X 9.09 EUR/kg  5.48 EUR" → price=5.48, qty=1. NEVER price=9.09, qty=0.603.
  - Same product name + different weights = separate items. Strip trailing "kg" from name.
- "(x N)" in name = pack description, qty=1, never divide.
- "x N" outside parens: if price/N realistic AND N≤6 → true qty, divide. Else pack, qty=1.

OCR CORRECTION
ALWAYS try to identify and restore the real product name using your knowledge of real supermarket food products. If a word resembles a known food product even with multiple wrong characters, correct it — do not leave a garbled name as-is. Only keep as-is if truly unrecognizable after attempting correction.
- Known fixes: SANOWIOHES/SANDWIDHES→SANDWICHES, BOLKETTES/BOULIES/BOUTETYES→BOULETTES, LATIE→LATTE (anywhere in name), FRTAES→FRITES, RIZ AU LAIT VANTEL→RIZ AU LAIT VANILLE, GUDA/GOODA→GOUDA, DHIPOLATA→CHIPOLATA, BOUCHER IE→BOUCHERIE, WIT LOOF→CHICONS, HADHE/HADHE→HACHE, CROISSANI/CROTSSANT→CROISSANT, SIEAKHOUSE→STEAKHOUSE, COLQUE/COUQE/KOUKE→COUQUE (Belgian pastry), BOTSSON→BOISSON, EPAJLE/EPAJULE→EPAULE, JAMBJN→JAMBON, POJLET→POULET.
- General: 0→O, 8→B, 1→I, I↔T (very common OCR swap), rn→m; remove spurious spaces (GL ACEE→GLACEE); merge split articles (I A→LA, D U→DU, A U→AU). When multiple characters are wrong, use your food knowledge to infer the most likely real product name — a confident best guess is always better than leaving a garbled word.

GROUPING
After OCR fix: same name (≤3 char diff) + same price → merge, qty=count. Weight items: always separate.
OCR variant rule: if two product lines have the same price and their names differ only by typical OCR noise (one or two character swaps/substitutions like LATTE/LATIE, MACCH/MACCHI, POULET/POUIET) → they are the SAME product, merge them regardless of char diff count.

FILTER OUT
- Any line representing a discount, price reduction or promotion in any language (identified by a negative amount, a percentage reduction, or wording meaning "discount/promo/saving/reduction") → exclude. Product price = always the positive price on its own line, never modified by discounts. "SALADE GRECQUE 4,99" + "REMISE 50% -2,50"→price=4.99.
- Bilingual promo lines (translation of previous product + garbled text) → exclude.
- Any wording meaning "free"/"offered"/"gift" inside a product name = bundle promo → keep product with its price.
- Any line representing a subtotal, grand total, amount due, payment method, tax, change given, or loyalty balance in any language → exclude. Last product before total: keep.
- No recognizable product name → exclude.
- Hygiene or cleaning products → keep, assign Hygiène or Entretien.
- Truly non-trackable items (batteries, cookware, appliances, toys, clothing) → exclude.
- Any line representing a receipt stamp, validation seal, or non-food brand (e.g. cookware, appliances) → exclude. "CACHET [Brand]" (e.g. "CACHET TEFAL", "CACHET SEB") = validation stamp printed on receipt, NOT a product → exclude.

OUTPUT
category (exactly one, no other value allowed): Produits laitiers | Féculents | Fruits et légumes | Matières grasses | Produits sucrés | Boissons | Viande, Poisson, oeuf | Sauces | Hygiène | Entretien
Pick the closest category — every product must be assigned one of these 10 values:
Produits laitiers=dairy, eggs, frozen/chilled foods; Féculents=bread/pasta/rice/cereals/pastries/legumes/potatoes/fries/chips/snacks; Fruits et légumes=fresh fruits and vegetables (not frozen, not chips); Matières grasses=oils/butter/margarine; Produits sucrés=chocolate/jam/honey/candy/sugar; Boissons=any drink; Viande, Poisson, oeuf=meat/fish/seafood/deli including all processed meat products (boulettes, saucisses, nuggets); Sauces=condiments/sauces/vinegar/mustard; Hygiène=personal care/soap/cosmetics; Entretien=household cleaning/detergent.
store: look in the FIRST lines of the receipt (header, before any product line). Extract the real business or brand name using your own knowledge to correct OCR noise (e.g. "REyhaN"→"Reyhan", "LIDI"→"Lidl", "lntermarche"→"Intermarche"). Never use generic words like "Supermarché", "Supermarket", "Magasin" or "Shop" as the store name — those describe the type of store, not its name. If the name is truly unrecognizable → "".
date: YYYY-MM-DD. total: copy from TOTAL/A payer only, never calculate. currency: symbol from receipt, default "€".

{"store":"","date":"","currency":"€","items":[{"name":"","price":0.00,"quantity":1,"category":""}],"total":0.00}

OCR TEXT:
${ocrText}`;

  let response;
  try {
    response = await ai.models.generateContent({
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
  } catch (err) {
    throw new Error(`Gemini API error: ${err.message}`);
  }

  try {
    // response.text est déjà une string JSON grâce à responseMimeType
    return JSON.parse(response.text);
  } catch (err) {
    throw new Error(`Gemini returned invalid JSON: ${err.message}`);
  }
}

module.exports = ApiGemini;