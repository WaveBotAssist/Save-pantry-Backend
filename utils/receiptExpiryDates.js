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
  'Féculents':              365,  // Pâtes, riz, céréales, légumes secs (pain et viennoiseries → mot-clé)
  'Fruits et légumes':      5,    // Fruits et légumes frais
  'Matières grasses':       90,   // Huiles (beurre/margarine → mot-clé)
  'Produits sucrés':        90,   // Biscuits, confiseries, chocolat
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
  { keywords: ['salade', 'mesclun', 'roquette', 'mache'], days: 4 },
  { keywords: ['sandwich', 'wrap'], days: 2 },
  { keywords: ['sushi', 'sashimi'], days: 1 },
  { keywords: ['steak haché', 'haché'], days: 2 },
  { keywords: ['saumon fumé', 'truite fumée', 'hareng fumé'], days: 21 },
  { keywords: ['poisson frais', 'saumon frais', 'cabillaud'], days: 2 },
  { keywords: ['poulet', 'volaille'], days: 2 },
  { keywords: ['viande'], days: 3 },
  { keywords: ['jambon', 'lardons', 'bacon', 'charcuterie'], days: 14 },

  // ── PRODUITS LAITIERS ───────────────────────────────────────────────────
  // Règles spécifiques AVANT les règles génériques (ex: 'lait' matcherait 'riz au lait')
  { keywords: ['riz au lait', 'rice pudding', 'crème dessert', 'creme dessert', 'flanby', 'flan'], days: 14 },
  { keywords: ['lait uht', 'lait stérilisé'], days: 90 },
  { keywords: ['lait frais'], days: 5 },
  { keywords: ['lait'], days: 5 },
  { keywords: ['yaourt', 'yop'], days: 14 },
  { keywords: ['fromage blanc', 'faisselle'], days: 10 },
  { keywords: ['crème'], days: 14 },
  { keywords: ['ricotta', 'mascarpone'], days: 7 },
  { keywords: ['camembert', 'brie'], days: 14 },
  { keywords: ['fromage râpé'], days: 14 },
  { keywords: ['emmental', 'gruyere', 'comte', 'gouda'], days: 30 },
  { keywords: ['parmesan', 'pecorino'], days: 60 },
  { keywords: ['beurre'], days: 90 },

  // ── FÉCULENTS ───────────────────────────────────────────────────────────
  { keywords: ['pain de mie'], days: 7 },
  { keywords: ['pain'], days: 3 },
  { keywords: ['brioche', 'croissant'], days: 3 },
  { keywords: ['pâtes fraîches', 'gnocchi'], days: 3 },
  { keywords: ['pâtes', 'riz', 'couscous', 'quinoa', 'boulgour', 'semoule', 'polenta'], days: 365 },
  { keywords: ['céréales', 'muesli', 'granola', 'corn flakes', 'flocons'], days: 365 },
  { keywords: ['chips', 'crackers', 'biscuits apéritif', 'nachos'], days: 90 },
  { keywords: ['farine'], days: 180 },

  // ── BOISSONS ────────────────────────────────────────────────────────────
  { keywords: ['jus frais', 'jus pressé'], days: 3 },
  { keywords: ['smoothie'], days: 3 },
  { keywords: ['jus'], days: 60 },
  { keywords: ['eau'], days: 365 },
  { keywords: ['latte', 'macchiato', 'cappuccino', 'frappuccino'], days: 30 },
  { keywords: ['café', 'capsule café', 'dosette', 'café moulu', 'café soluble'], days: 365 },
  { keywords: ['thé', 'tisane', 'infusion'], days: 730 },
  { keywords: ['bière', 'cidre'], days: 180 },
  { keywords: ['vin'], days: 730 },
  { keywords: ['soda', 'cola'], days: 180 },
  { keywords: ['lait végétal'], days: 90 },

  // ── FRUITS & LÉGUMES ────────────────────────────────────────────────────
  { keywords: ['fraise', 'framboise'], days: 4 },
  { keywords: ['salade composée'], days: 2 },
  { keywords: ['tomate', 'concombre'], days: 6 },
  { keywords: ['courgette'], days: 5 },
  { keywords: ['brocoli'], days: 4 },
  { keywords: ['banane'], days: 4 },
  { keywords: ['pomme', 'orange', 'citron', 'poire', 'kiwi'], days: 14 },
  { keywords: ['raisin', 'cerise', 'pêche', 'nectarine', 'abricot', 'mangue'], days: 5 },
  { keywords: ['melon', 'pastèque'], days: 7 },
  { keywords: ['avocat'], days: 4 },
  { keywords: ['carotte', 'betterave', 'navet', 'céleri'], days: 14 },
  { keywords: ['oignon', 'échalote'], days: 60 },
  { keywords: ['ail'], days: 60 },
  { keywords: ['pomme de terre', 'patate'], days: 30 },
  { keywords: ['champignon'], days: 5 },
  { keywords: ['poivron', 'aubergine'], days: 7 },
  { keywords: ['épinard', 'blette'], days: 3 },
  { keywords: ['haricot vert'], days: 4 },
  { keywords: ['poireau'], days: 10 },

  // ── MATIÈRES GRASSES ────────────────────────────────────────────────────
  { keywords: ['huile'], days: 365 },
  { keywords: ['margarine'], days: 90 },

  // ── PRODUITS SUCRÉS ─────────────────────────────────────────────────────
  { keywords: ['chocolat'], days: 180 },
  { keywords: ['biscuit', 'cookie'], days: 90 },
  { keywords: ['confiture', 'miel'], days: 365 },
  { keywords: ['bonbon'], days: 365 },
  { keywords: ['glace'], days: 180 },

  // ── SAUCES ──────────────────────────────────────────────────────────────
  { keywords: ['ketchup', 'moutarde'], days: 365 },
  { keywords: ['mayonnaise'], days: 90 },
  { keywords: ['sauce soja'], days: 365 },
  { keywords: ['vinaigrette'], days: 180 },

  // ── ÉPICERIE SÈCHE ──────────────────────────────────────────────────────
  { keywords: ['épices', 'herbes de provence', 'curry', 'paprika', 'curcuma'], days: 730 },
  { keywords: ['sel', 'poivre'], days: 1825 }, // 5 ans
  { keywords: ['sucre', 'cassonade'], days: 730 },
  { keywords: ['vinaigre'], days: 1095 },
  { keywords: ['bouillon', 'soupe'], days: 365 },
  { keywords: ['moutarde'], days: 365 },

  // ── BONUS UTILES ────────────────────────────────────────────────────────
  { keywords: ['pizza'], days: 3 }, // fraîche uniquement
  { keywords: ['taboulé'], days: 2 },
  { keywords: ['houmous'], days: 10 },
  { keywords: ['fromage'], days: 14 }, // fallback fromages non listés
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
  // Hygiène et Entretien n'ont pas de date de péremption pertinente
  if (category === 'Hygiène' || category === 'Entretien') return null;

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
