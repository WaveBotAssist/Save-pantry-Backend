/**
 * receiptExpiryDates.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Calcule une date d'expiration approximative pour un produit alimentaire
 * issu d'un ticket de caisse.
 *
 * Logique en deux niveaux :
 *   1. Mots-clés sur le nom du produit  → durée spécifique au produit
 *   2. Fallback sur la catégorie        → durée générique par famille
 *
 * Ces valeurs correspondent à un produit EMBALLÉ et NON OUVERT.
 * L'utilisateur peut ajuster la date manuellement dans l'écran de validation.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Durées de conservation par catégorie (fallback si aucun mot-clé ne correspond).
 * @type {Record<string, number>}
 */
const EXPIRY_DAYS_BY_CATEGORY = {
  'Produits laitiers':      7,    // Lait frais, yaourt, fromage frais
  'Féculents':              30,   // Pâtes, riz, pain, viennoiseries
  'Fruits et légumes':      5,    // Fruits et légumes frais
  'Matières grasses':       90,   // Beurre, margarine (huile → mot-clé)
  'Produits sucrés':        60,   // Biscuits, confiseries, chocolat
  'Boissons':               180,  // Jus, sodas, eau (boissons réfrigérées → mot-clé)
  'Viande, Poisson, oeuf':  3,    // Viandes et poissons frais, œufs
  'Sauces':                 90,   // Ketchup, moutarde, mayonnaise
};

/**
 * Règles par mots-clés sur le nom du produit (insensible à la casse).
 * Chaque entrée : { keywords: string[], days: number }
 * La première règle qui correspond est utilisée.
 * @type {Array<{ keywords: string[], days: number }>}
 */
const KEYWORD_RULES = [

  // ── SURGELÉS (priorité haute) ────────────────────────────────────────────
  { keywords: ['surgelé', 'surgele', 'congelé', 'congele'], days: 180 },
  { keywords: ['pizza surgelée', 'pizza surgelee'], days: 90 },
  { keywords: ['poisson pané', 'nuggets', 'cordons bleus'], days: 120 },
  { keywords: ['légumes surgelés', 'epinards surgeles', 'haricots surgeles'], days: 180 },

  // ── CONSERVES (priorité haute) ───────────────────────────────────────────
  { keywords: ['conserve', 'boîte de', 'boite de'], days: 1095 },
  { keywords: ['thon boite', 'thon en boite'], days: 1095 },
  { keywords: ['sardines', 'maquereau'], days: 1095 },
  { keywords: ['petits pois', 'haricots verts', 'mais'], days: 730 },
  { keywords: ['tomates pelées', 'coulis', 'passata'], days: 730 },

  // ── ŒUFS ────────────────────────────────────────────────────────────────
  { keywords: ['oeuf', 'œuf'], days: 21 },

  // ── PLATS PRÉPARÉS FRAIS ────────────────────────────────────────────────
  { keywords: ['lasagne', 'hachis', 'gratin'], days: 3 },
  { keywords: ['quiche', 'tarte salée'], days: 3 },
  { keywords: ['plat cuisiné', 'plat preparé'], days: 3 },
  { keywords: ['soupe fraîche', 'velouté'], days: 4 },

  // ── PRODUITS TRÈS PÉRISSABLES ────────────────────────────────────────────
  { keywords: ['salade', 'mesclun', 'roquette', 'mache'], days: 2 },
  { keywords: ['sandwich', 'wrap'], days: 2 },
  { keywords: ['sushi', 'sashimi'], days: 1 },
  { keywords: ['steak haché', 'haché'], days: 2 },
  { keywords: ['poisson frais', 'saumon frais', 'cabillaud'], days: 2 },
  { keywords: ['poulet', 'volaille'], days: 2 },
  { keywords: ['viande'], days: 3 },
  { keywords: ['jambon', 'lardons', 'bacon', 'charcuterie'], days: 5 },

  // ── PRODUITS LAITIERS ───────────────────────────────────────────────────
  { keywords: ['lait uht', 'lait stérilisé'], days: 60 },
  { keywords: ['lait frais'], days: 5 },
  { keywords: ['lait'], days: 5 },
  { keywords: ['yaourt', 'yop'], days: 10 },
  { keywords: ['fromage blanc', 'faisselle'], days: 7 },
  { keywords: ['crème'], days: 7 },
  { keywords: ['ricotta', 'mascarpone'], days: 5 },
  { keywords: ['camembert', 'brie'], days: 10 },
  { keywords: ['fromage râpé'], days: 14 },
  { keywords: ['emmental', 'gruyere', 'comte', 'gouda'], days: 20 },
  { keywords: ['parmesan', 'pecorino'], days: 60 },
  { keywords: ['beurre'], days: 30 },

  // ── FÉCULENTS ───────────────────────────────────────────────────────────
  { keywords: ['pain de mie'], days: 7 },
  { keywords: ['pain'], days: 3 },
  { keywords: ['brioche', 'croissant'], days: 3 },
  { keywords: ['pâtes fraîches', 'gnocchi'], days: 3 },
  { keywords: ['pâtes', 'riz'], days: 365 },
  { keywords: ['farine'], days: 180 },

  // ── BOISSONS ────────────────────────────────────────────────────────────
  { keywords: ['jus frais', 'jus pressé'], days: 3 },
  { keywords: ['smoothie'], days: 3 },
  { keywords: ['jus'], days: 30 },
  { keywords: ['eau'], days: 365 },
  { keywords: ['soda', 'cola'], days: 180 },
  { keywords: ['lait végétal'], days: 30 },

  // ── FRUITS & LÉGUMES ────────────────────────────────────────────────────
  { keywords: ['fraise', 'framboise'], days: 2 },
  { keywords: ['salade composée'], days: 2 },
  { keywords: ['tomate', 'concombre'], days: 4 },
  { keywords: ['courgette'], days: 5 },
  { keywords: ['brocoli'], days: 4 },
  { keywords: ['banane'], days: 4 },
  { keywords: ['pomme', 'orange'], days: 10 },
  { keywords: ['carotte'], days: 10 },

  // ── MATIÈRES GRASSES ────────────────────────────────────────────────────
  { keywords: ['huile'], days: 365 },
  { keywords: ['margarine'], days: 60 },

  // ── PRODUITS SUCRÉS ─────────────────────────────────────────────────────
  { keywords: ['chocolat'], days: 180 },
  { keywords: ['biscuit', 'cookie'], days: 60 },
  { keywords: ['confiture', 'miel'], days: 365 },
  { keywords: ['bonbon'], days: 365 },
  { keywords: ['glace'], days: 60 },

  // ── SAUCES ──────────────────────────────────────────────────────────────
  { keywords: ['ketchup', 'moutarde'], days: 180 },
  { keywords: ['mayonnaise'], days: 60 },
  { keywords: ['sauce soja'], days: 365 },
  { keywords: ['vinaigrette'], days: 90 },

  // ── BONUS UTILES ────────────────────────────────────────────────────────
  { keywords: ['pizza'], days: 3 }, // fraîche uniquement
  { keywords: ['taboulé'], days: 2 },
  { keywords: ['houmous'], days: 5 },
  { keywords: ['fromage'], days: 10 }, // fallback
];

/**
 * Supprime les accents d'une chaîne et la met en minuscules.
 * Permet de comparer "haché" avec "hache", "écrémé" avec "ecreme", etc.
 *
 * @param {string} str
 * @returns {string}
 */
function normalize(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Calcule une date d'expiration approximative pour un produit.
 * Cherche d'abord un mot-clé dans le nom (sans tenir compte des accents),
 * puis retombe sur la catégorie.
 *
 * @param {string} category  - Catégorie retournée par Gemini
 * @param {string} [name]    - Nom du produit (pour affiner via mots-clés)
 * @param {Date}   [from]    - Date de référence (défaut : aujourd'hui)
 * @returns {Date}             Date d'expiration estimée
 *
 * @example
 * getExpiryDate('Produits laitiers', 'LAIT UHT DEMI ECREME') // → dans 90 jours
 * getExpiryDate('Produits laitiers', 'YAOURT NATURE')         // → dans 14 jours
 * getExpiryDate('Viande, Poisson, oeuf', 'JAMBON EPAULE')    // → dans 10 jours
 */
function getExpiryDate(category, name = '', from = new Date()) {
  const normalizedName = normalize(name);

  // Cherche la première règle dont un mot-clé correspond au nom du produit.
  // La comparaison ignore les accents des deux côtés pour absorber les erreurs OCR.
  for (const rule of KEYWORD_RULES) {
    if (rule.keywords.some(kw => normalizedName.includes(normalize(kw)))) {
      const d = new Date(from);
      d.setDate(d.getDate() + rule.days);
      return d;
    }
  }

  // Aucun mot-clé → fallback sur la catégorie (30 jours si catégorie inconnue)
  const days = EXPIRY_DAYS_BY_CATEGORY[category] ?? 30;
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d;
}

// Conservé pour compatibilité avec l'ancien appel sans nom de produit
const getExpiryDateForCategory = (category, from) => getExpiryDate(category, '', from);

module.exports = { getExpiryDate, getExpiryDateForCategory, EXPIRY_DAYS_BY_CATEGORY };
