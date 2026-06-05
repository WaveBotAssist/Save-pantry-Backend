/**
 * recipeUrlImport.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Extraction de recettes depuis une URL — deux stratégies en cascade :
 *
 *   1. JSON-LD (Schema.org/Recipe) — fiable, 0 crédit.
 *      Compatible : Marmiton, BBC Good Food, Cuisine AZ, et tout site Schema.org.
 *      Utilise un parseur par accolades (robuste face au bug </script> dans JSON).
 *
 *   2. Heuristique HTML — fallback quand JSON-LD est absent.
 *      Cherche le titre (<h1>), les ingrédients (<li> dans la section "Ingrédients")
 *      et les étapes (<ol>) selon les patterns courants des sites de recettes.
 *      Résultat moins fiable (confidence 0.7) — l'utilisateur peut corriger avant sauvegarde.
 *
 * Aucun appel à Gemini — aucun crédit consommé.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const cheerio  = require('cheerio');
const fetch    = require('node-fetch');

// ─── Décodage des entités HTML ────────────────────────────────────────────────

const HTML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  '&#039;': "'", '&nbsp;': ' ', '&thinsp;': ' ', '&ensp;': ' ', '&emsp;': ' ',
  '&mdash;': '—', '&ndash;': '–', '&hellip;': '…', '&bull;': '•',
  '&laquo;': '«', '&raquo;': '»',
  '&lsquo;': '‘', '&rsquo;': '’',
  '&ldquo;': '“', '&rdquo;': '”',
  '&times;': '×', '&divide;': '÷', '&deg;': '°', '&frac12;': '½',
  '&frac14;': '¼', '&frac34;': '¾',
  '&agrave;': 'à', '&aacute;': 'á', '&acirc;': 'â', '&atilde;': 'ã', '&auml;': 'ä', '&aring;': 'å',
  '&egrave;': 'è', '&eacute;': 'é', '&ecirc;': 'ê', '&euml;': 'ë',
  '&igrave;': 'ì', '&iacute;': 'í', '&icirc;': 'î', '&iuml;': 'ï',
  '&ograve;': 'ò', '&oacute;': 'ó', '&ocirc;': 'ô', '&otilde;': 'õ', '&ouml;': 'ö',
  '&ugrave;': 'ù', '&uacute;': 'ú', '&ucirc;': 'û', '&uuml;': 'ü',
  '&ccedil;': 'ç', '&ntilde;': 'ñ', '&szlig;': 'ß',
  '&oelig;': 'œ', '&aelig;': 'æ',
  '&Agrave;': 'À', '&Aacute;': 'Á', '&Acirc;': 'Â', '&Atilde;': 'Ã', '&Auml;': 'Ä', '&Aring;': 'Å',
  '&Egrave;': 'È', '&Eacute;': 'É', '&Ecirc;': 'Ê', '&Euml;': 'Ë',
  '&Igrave;': 'Ì', '&Iacute;': 'Í', '&Icirc;': 'Î', '&Iuml;': 'Ï',
  '&Ograve;': 'Ò', '&Oacute;': 'Ó', '&Ocirc;': 'Ô', '&Otilde;': 'Õ', '&Ouml;': 'Ö',
  '&Ugrave;': 'Ù', '&Uacute;': 'Ú', '&Ucirc;': 'Û', '&Uuml;': 'Ü',
  '&Ccedil;': 'Ç', '&Ntilde;': 'Ñ', '&OElig;': 'Œ', '&AElig;': 'Æ',
};

/**
 * Décode toutes les entités HTML (nommées + numériques).
 * Boucle jusqu'à stabilité pour gérer le double-encodage (&amp;eacute; → &eacute; → é).
 */
function decodeEntities(str) {
  if (!str || typeof str !== 'string') return str;
  let prev;
  do {
    prev = str;
    str = str
      .replace(/&[a-zA-Z]+;/g,          m => HTML_ENTITIES[m] ?? m)
      .replace(/&#(\d+);/g,             (_, c) => String.fromCharCode(parseInt(c)))
      .replace(/&#x([0-9a-fA-F]+);/g,  (_, c) => String.fromCharCode(parseInt(c, 16)));
  } while (str !== prev);
  return str.trim();
}

// ─── Helpers JSON-LD ─────────────────────────────────────────────────────────

function findRecipe(data) {
  if (!data) return null;
  const type = data['@type'];
  if (type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))) return data;
  if (Array.isArray(data['@graph'])) {
    for (const item of data['@graph']) { const r = findRecipe(item); if (r) return r; }
  }
  if (Array.isArray(data)) {
    for (const item of data) { const r = findRecipe(item); if (r) return r; }
  }
  return null;
}

function parseIsoDuration(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m) return null;
  const mins = parseInt(m[1] || '0') * 60 + parseInt(m[2] || '0');
  return mins || null;
}

function parseRecipeYield(val) {
  if (!val) return null;
  if (Array.isArray(val)) val = val[0];
  if (typeof val === 'number') return val;
  const m = String(val).match(/\d+/);
  return m ? parseInt(m[0]) : null;
}

function parseRecipeImage(img) {
  if (!img) return null;
  if (typeof img === 'string') return img;
  if (Array.isArray(img)) return parseRecipeImage(img[0]);
  return img.url ?? null;
}

function parseRecipeSteps(instructions) {
  if (!instructions) return [];
  if (!Array.isArray(instructions)) instructions = [instructions];
  const steps = [];
  for (const s of instructions) {
    if (typeof s === 'string') { steps.push(s.trim()); continue; }
    if (s['@type'] === 'HowToStep') {
      const t = (s.text || s.name || '').trim();
      if (t) steps.push(t);
      continue;
    }
    if (s['@type'] === 'HowToSection') {
      for (const sub of (s.itemListElement ?? [])) {
        const t = (sub.text || sub.name || '').trim();
        if (t) steps.push(t);
      }
    }
  }
  return steps.filter(Boolean);
}

/**
 * Extrait les blocs JSON-LD depuis le HTML brut sans passer par le parseur HTML.
 * Cherio coupe les <script> au premier </script> trouvé — si le JSON contient
 * </script> dans une string, le JSON est tronqué et invalide.
 * On lit directement les accolades pour trouver la fin du JSON.
 */
function extractJsonLdBlocks(rawHtml) {
  const blocks = [];
  const tagRe  = /<script[^>]*type=["']application\/ld\+json["'][^>]*>/gi;
  let m;

  while ((m = tagRe.exec(rawHtml)) !== null) {
    let i = m.index + m[0].length;
    while (i < rawHtml.length && /\s/.test(rawHtml[i])) i++;
    const opener = rawHtml[i];
    if (opener !== '{' && opener !== '[') continue;
    const closer = opener === '{' ? '}' : ']';

    let depth = 0, inStr = false, esc = false, start = i;
    for (; i < rawHtml.length; i++) {
      const ch = rawHtml[i];
      if (esc)            { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true;  continue; }
      if (ch === '"')     { inStr = !inStr; continue; }
      if (inStr)          continue;
      if (ch === opener)  depth++;
      else if (ch === closer && --depth === 0) { i++; break; }
    }

    try { blocks.push(JSON.parse(rawHtml.slice(start, i))); } catch {}
  }
  return blocks;
}

// Catégories trop génériques — ne donnent pas d'info sur le type de plat
const GENERIC_CATEGORIES = ['dinner','lunch','supper','meal','dish','recipe','food',
  'main course','main dish','entree','plat','repas','cuisine'];

// Mots-clés dans le titre/ingrédients → catégorie canonique
// Ordre important : du plus spécifique au plus général
const KEYWORD_RULES = [
  // Plats identifiables par leur contenu
  { cat: 'Soupe',          re: /soupe|potage|veloute|bouillon|bisque|soup|ramen|pho|gaspacho|gazpacho|minestrone|chowder|bouillabaisse|goulash|veloute/ },
  { cat: 'Salade',         re: /\bsalade\b|\bsalad\b/ },
  { cat: 'Pates',          re: /\bpates?\b|pasta|spaghetti|tagliatelle|gnocchi|ravioli|lasagne|penne|rigatoni|fettuccine|linguine|nouille|noodle|macaroni|carbonara|bolognese/ },
  { cat: 'Riz',            re: /risotto|paella|\briz\b|\brice\b|pilaf|fried\s*rice/ },
  { cat: 'Dessert',        re: /gateau|cake|dessert|brownie|cookie|biscuit|muffin|cupcake|tiramisu|cheesecake|mousse|pudding|glace|sorbet|macaron|eclair|crepe\s*sucre|tarte\s*(sucre|tatin|aux|pomme|citron|fraise|framboise|chocolat)|fondant|clafoutis|flan|creme\s*brulee|financier|moelleux|profiterole|choux|meringue|bavarois|panna\s*cotta|crumble|cobbler|torte|strudel|pie\s*(aux|sucr|\bapple|\bcherry|\blemon)|apple\s*pie|lemon\s*pie|trifle|halva|baklava|compote/ },
  { cat: 'Boisson',        re: /smoothie|cocktail|limonade|lemonade|milkshake|sirop|infusion|\bjus\s+de\b|jus\s+d'|juice|sangria|punch|mocktail/ },
  // Moment de la journée ou occasion
  { cat: 'Petit-déjeuner', re: /petit[\s-]dejeuner|breakfast|pancake|waffle|granola|oatmeal|porridge|pain\s*perdu|french\s*toast|muesli|scone|tartine|croissant|brioche|pain\s*au\s*chocolat|kouign|bostock/ },
  { cat: 'Brunch',         re: /brunch|eggs?\s*benedict|avocado\s*toast|shakshuka/ },
  { cat: 'Apéritif',       re: /aperitif|apero|tapas|amuse[\s-]?bouche|canapé|canape|finger\s*food|dip\b|tzatziki|guacamole|houmous|hummus/ },
  { cat: 'Collation',      re: /collation|gouter|energy\s*ball|protein\s*bar|barre\s*cereal|muesli\s*bar/ },
  { cat: 'Déjeuner',       re: /\bdejeuner\b|\blunch\b/ },
  { cat: 'Dîner',          re: /\bdiner\b|\bdinner\b|\bsupper\b/ },
  // Type de plat
  { cat: 'Entrée',         re: /\bentree\b|bruschetta|carpaccio|tartare|verrines|terrine|rillettes|foie\s*gras|escargot|ceviche|blinis/ },
  { cat: 'Viande',         re: /\bsteak\b|boeuf\s*bourguignon|coq\s*au\s*vin|poulet\s*roti|roti\s*de|pot[\s-]au[\s-]feu|blanquette|gigot|carre\s*d.agneau|grille|grill|bbq|barbeque|barbecue|escalope|magret|canard\s*roti|lapin\s*a|veau|agneau\s*roti|tenderloin|roast\b|brisket|\bribs\b|pork\s*chop|chicken\s*breast|osso\s*buco|saltimbocca|dinde\s*roti|turkey\s*roast|côte\s*de|cotoletta/ },
  { cat: 'Plat principal',  re: /gratin|quiche|tarte\s*sal|pizza|burger|tourte|clafoutis\s*sale|casserole|tajine|tagine|curry|wok|poele|fricassee|daube|ragoût|ragout|stew|ratatouille|cassoulet|omelette|frittata|croque[\s-]|hachis\s*parmentier|shepherd.s\s*pie|moussaka|lasagne|enchilada|burrito|wrap\b|pad\s*thai|chili\b|fish\s*and\s*chips|fried\s*chicken|stir[\s-]fry|pot\s*pie|farci|farcie|stuffed/ },
];

/**
 * Détermine la catégorie canonique à partir de :
 *   1. La catégorie JSON-LD (si spécifique et non générique)
 *   2. Le titre de la recette (le plus fiable)
 *   3. Les 3 premiers ingrédients (fallback)
 */
function inferCategory(rawCategory, titre, ingredients) {
  const norm = (str) => (str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  // Étape 1 : catégorie JSON-LD — utilisée seulement si non générique
  if (rawCategory) {
    const rawLow = norm(rawCategory).replace(/s$/, '');
    const isGeneric = GENERIC_CATEGORIES.some(g => rawLow.includes(g));
    if (!isGeneric) {
      for (const { cat, re } of KEYWORD_RULES) {
        if (re.test(rawLow)) return cat;
      }
    }
  }

  // Étape 2 : mots-clés dans le titre (le signal le plus fort)
  if (titre) {
    const t = norm(titre);
    for (const { cat, re } of KEYWORD_RULES) {
      if (re.test(t)) return cat;
    }
  }

  // Étape 3 : mots-clés dans les 3 premiers ingrédients
  if (ingredients && ingredients.length > 0) {
    const ing = norm(ingredients.slice(0, 3).join(' '));
    for (const { cat, re } of KEYWORD_RULES) {
      if (re.test(ing)) return cat;
    }
  }

  return 'Autre';
}

function extractFromJsonLd($, ogImage, rawHtml) {
  // Essaie le parseur par accolades (gère </script> dans les strings JSON)
  // ET le parseur cheerio (plus fiable sur les JSON bien formés).
  // On garde la liste qui contient le plus de blocs valides.
  const rawBlocks     = rawHtml ? extractJsonLdBlocks(rawHtml) : [];
  const cheerioBlocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try { cheerioBlocks.push(JSON.parse($(el).html())); } catch {}
  });
  const blocks = rawBlocks.length >= cheerioBlocks.length ? rawBlocks : cheerioBlocks;

  for (const data of blocks) {
    const recipe = findRecipe(data);
    if (!recipe) continue;

    const titre = decodeEntities(recipe.name || '');
    const ingredients = (Array.isArray(recipe.recipeIngredient) ? recipe.recipeIngredient : [])
      .map(i => decodeEntities(String(i))).filter(Boolean);

    if (!titre || ingredients.length === 0) continue;

    return {
      titre,
      ingredients,
      instructions:      parseRecipeSteps(recipe.recipeInstructions).map(decodeEntities),
      temps_preparation: parseIsoDuration(recipe.prepTime) || parseIsoDuration(recipe.totalTime),
      portion:           parseRecipeYield(recipe.recipeYield),
      image:             parseRecipeImage(recipe.image) || ogImage || '',
      categorie:         inferCategory(
        decodeEntities(Array.isArray(recipe.recipeCategory) ? recipe.recipeCategory[0] : (recipe.recipeCategory || '')),
        titre,
        ingredients
      ),
      confidence:        1,
    };
  }
  return null;
}

// ─── Parseur heuristique — fallback quand JSON-LD est absent ─────────────────
// Cherche les patterns courants dans le HTML :
//   - Titre     : premier <h1>
//   - Ingrédients : <li> qui contiennent une quantité (g, ml, cuillère…)
//   - Étapes    : <ol><li> de taille raisonnable, ou éléments avec classe "step/etape/instruction"
//   - Temps     : pattern texte "X min" ou "X h Y min"
//   - Portions  : pattern texte "X personnes/parts"
// Résultat moins fiable que JSON-LD (confidence: 0.7 vs 1).

// Unité précédée d'un espace — évite de matcher "750g" (nom de site) sans espace
const UNIT_RE   = /\b\d[\d,.]*\s+(g|kg|ml|cl|dl|gr|litre?|gramme?|cube|sachet|pincée|noix|botte|brin|tranche|gousse|cuillère|càs|càc|c\.à|tasse|verre|oz|lb)\b/i;
// Ingrédient sans unité : commence par un chiffre ou fraction suivi d'un mot
const NUM_START = /^(\d[\d,.]*|½|¼|¾|⅓|⅔)\s+[a-zA-ZÀ-ÿ]/;

function extractFromHeuristics($, ogImage) {
  const titre = decodeEntities($('h1').first().text().trim());
  if (!titre) return null;

  // ── Ingrédients — stratégie 1 : liste entre le titre "Ingrédients" et le suivant
  const ingredients = [];

  const ingrHeading = $('h1,h2,h3,h4,h5').filter((_, el) =>
    /ingr[ée]dients?/i.test($(el).text())
  ).first();

  if (ingrHeading.length) {
    // S'arrête uniquement au titre de même niveau ou supérieur — les sous-titres
    // comme "La pâte", "La ganache" (h3 sous un h2) sont traversés normalement.
    const tag   = ingrHeading[0].tagName.toLowerCase(); // ex: "h2"
    const level = parseInt(tag[1]);                     // ex: 2
    const stopSel = Array.from({ length: level }, (_, i) => `h${i + 1}`).join(','); // "h1,h2"

    ingrHeading.nextUntil(stopSel).find('li').each((_, el) => {
      const text = decodeEntities($(el).clone().children('ul,ol').remove().end().text().trim());
      if (text && text.length > 2 && text.length < 250) ingredients.push(text);
    });
  }

  // ── Ingrédients — stratégie 2 : <li> avec unité (espace obligatoire) ──────
  if (ingredients.length === 0) {
    $('li').each((_, el) => {
      const text = decodeEntities($(el).clone().children('ul,ol').remove().end().text().trim());
      if (text && text.length < 250 && (UNIT_RE.test(text) || NUM_START.test(text))) {
        ingredients.push(text);
      }
    });
  }

  if (ingredients.length === 0) return null;

  // ── Étapes ─────────────────────────────────────────────────────────────────
  // 1. <ol><li> de taille suffisante (pas des menus)
  const instructions = [];
  $('ol').each((_, list) => {
    const items = [];
    $(list).find('> li').each((_, li) => {
      const text = decodeEntities($(li).text().trim());
      if (text.length > 25 && text.length < 1500) items.push(text);
    });
    if (items.length >= 2 && items.length > instructions.length) {
      instructions.length = 0;
      instructions.push(...items);
    }
  });
  // 2. Fallback : éléments dont la classe contient step/etape/instruction/direction
  if (instructions.length === 0) {
    $('[class*="step"],[class*="etape"],[class*="instruction"],[class*="direction"],[class*="preparation"]').each((_, el) => {
      const text = decodeEntities($(el).text().trim());
      if (text.length > 25 && text.length < 1500) instructions.push(text);
    });
  }

  // ── Temps de préparation ───────────────────────────────────────────────────
  let temps_preparation = null;
  const bodyText = $('body').text();
  const hm = bodyText.match(/(\d+)\s*h(?:eure)?s?\s*(\d+)?\s*min?/i);
  const mm = bodyText.match(/(\d+)\s*min(?:utes?)?/i);
  if (hm) {
    temps_preparation = parseInt(hm[1]) * 60 + (hm[2] ? parseInt(hm[2]) : 0);
  } else if (mm) {
    temps_preparation = parseInt(mm[1]);
  }

  // ── Portions ───────────────────────────────────────────────────────────────
  let portion = null;
  const pm = bodyText.match(/(\d+)\s*(?:personnes?|parts?|portions?)/i);
  if (pm) portion = parseInt(pm[1]);

  return {
    titre,
    ingredients,
    instructions,
    temps_preparation,
    portion,
    image: ogImage || '',
    categorie: 'Autre',
    confidence: 0.7,
  };
}

// ─── Fetch avec redirections ──────────────────────────────────────────────────

const BASE_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate',
};

// Suit les redirections manuellement pour accumuler les cookies (sites avec middleware de tracking)
async function fetchFollowingRedirects(startUrl, signal) {
  const cookies = {};
  let currentUrl = startUrl;

  for (let i = 0; i < 10; i++) {
    const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(currentUrl, {
      redirect: 'manual',
      signal,
      headers: { ...BASE_HEADERS, ...(cookieHeader ? { 'Cookie': cookieHeader } : {}) },
    });

    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      for (const part of setCookie.split(',')) {
        const [nameVal] = part.split(';');
        const eqIdx = nameVal.indexOf('=');
        if (eqIdx > 0) {
          const k = nameVal.slice(0, eqIdx).trim();
          const v = nameVal.slice(eqIdx + 1).trim();
          if (k) cookies[k] = v;
        }
      }
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) break;
      currentUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
    } else {
      return res;
    }
  }
  throw new Error('Maximum de redirections atteint.');
}

// ─── Export principal ─────────────────────────────────────────────────────────

function _extractImage($) {
  return (
    $('meta[property="og:image"]').attr('content')     ||
    $('meta[property="og:image:url"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content')    ||
    $('meta[name="twitter:image:src"]').attr('content')||
    $('meta[name="og:image"]').attr('content')         ||
    $('meta[itemprop="image"]').attr('content')        ||
    $('link[rel="image_src"]').attr('href')            ||
    $('article img, .recipe img').first().attr('src')  ||
    null
  );
}

/**
 * Extraction en cascade : JSON-LD → heuristique.
 * JSON-LD : fiable, confidence 1. Heuristique : approximatif, confidence 0.7.
 */
function extractRecipeFromHtml(html) {
  const $ = cheerio.load(html);
  const image = _extractImage($);
  return extractFromJsonLd($, image, html) || extractFromHeuristics($, image);
}

/**
 * Fetch + extraction — utilisé en fallback si le frontend n'envoie pas le HTML.
 */
async function extractRecipeFromUrl(url) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 10_000);

  let html;
  try {
    const res = await fetchFollowingRedirects(url, controller.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status} — impossible d'accéder à la page.`);
    html = await res.text();
  } finally {
    clearTimeout(timeout);
  }

  return extractRecipeFromHtml(html);
}

module.exports = { extractRecipeFromUrl, extractRecipeFromHtml };
