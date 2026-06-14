/**
 * videoRecipeImport.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Récupère le texte écrit par le créateur d'une vidéo de recette
 * (YouTube / Instagram / TikTok), pour qu'il soit ensuite envoyé à Gemini
 * (extractRecipeFromVideoText dans recipeAI.js).
 *
 * Aucune analyse de la vidéo elle-même (image/audio) — uniquement du texte,
 * le plus fiable et le moins coûteux :
 *
 *   - YouTube   : description de la vidéo + sous-titres (API timedtext,
 *                 gratuite, sans IA).
 *   - Instagram/TikTok : légende du post (balise og:description).
 *
 * Si aucun texte n'est trouvé → null. La route /recipe/import-url retourne
 * alors une erreur claire plutôt que de deviner depuis la vidéo.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const { BASE_HEADERS, decodeEntities, fetchFollowingRedirects } = require('./recipeUrlImport');

// ─── Détection de plateforme ──────────────────────────────────────────────────

/**
 * @returns {'youtube'|'instagram'|'tiktok'|null}
 */
function detectVideoPlatform(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }

  if (host.endsWith('youtube.com') || host === 'youtu.be') return 'youtube';
  if (host.endsWith('instagram.com')) return 'instagram';
  if (host.endsWith('tiktok.com')) return 'tiktok';
  return null;
}

// ─── YouTube ───────────────────────────────────────────────────────────────────

/** Extrait l'ID vidéo depuis les formats courants d'URL YouTube. */
function extractYoutubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2] || null;
    if (u.pathname.startsWith('/embed/'))  return u.pathname.split('/')[2] || null;
    return u.searchParams.get('v');
  } catch {
    return null;
  }
}

/**
 * Extrait l'objet JSON qui suit `marker` dans `html` (ex: "ytInitialPlayerResponse = {...}").
 * Équilibrage d'accolades — même technique que extractJsonLdBlocks (recipeUrlImport.js).
 */
function extractJsonAfterMarker(html, marker) {
  const idx = html.indexOf(marker);
  if (idx === -1) return null;

  let i = idx + marker.length;
  if (html[i] !== '{') return null;

  let depth = 0, inStr = false, esc = false;
  const start = i;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (esc)            { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"')     { inStr = !inStr; continue; }
    if (inStr)          continue;
    if (ch === '{')     depth++;
    else if (ch === '}' && --depth === 0) { i++; break; }
  }

  try { return JSON.parse(html.slice(start, i)); } catch { return null; }
}

/**
 * Récupère la transcription (sous-titres) de la meilleure piste disponible.
 * Préférence : français > anglais > première piste trouvée.
 * Retourne '' si la vidéo n'a pas de sous-titres.
 */
async function fetchYoutubeTranscript(playerResponse) {
  const tracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks?.length) return '';

  const track = tracks.find(t => t.languageCode === 'fr')
             ?? tracks.find(t => t.languageCode === 'en')
             ?? tracks[0];

  try {
    const res = await fetch(`${track.baseUrl}&fmt=json3`, { headers: BASE_HEADERS });
    if (!res.ok) return '';
    const data = await res.json();

    return (data.events ?? [])
      .flatMap(e => e.segs ?? [])
      .map(s => s.utf8 ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

/**
 * @returns {Promise<{ text: string, image: string } | null>}
 */
async function getYoutubeRecipeSource(url) {
  const videoId = extractYoutubeId(url);
  if (!videoId) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: BASE_HEADERS,
      signal:  controller.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();

    const player = extractJsonAfterMarker(html, 'ytInitialPlayerResponse = ');
    if (!player) return null;

    const description = (player.videoDetails?.shortDescription || '').trim();
    const transcript   = await fetchYoutubeTranscript(player);

    const text = [description, transcript].filter(Boolean).join('\n\n').trim();
    if (!text) return null;

    return { text, image: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Instagram / TikTok ──────────────────────────────────────────────────────

/**
 * TikTok n'expose pas og:description aux requêtes serveur, mais embarque les
 * données complètes de la vidéo dans un <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"
 * type="application/json">. C'est là que se trouve la légende écrite par le
 * créateur (souvent la recette complète) et l'image de couverture.
 */
function getTikTokDataSource($) {
  try {
    const raw = $('#__UNIVERSAL_DATA_FOR_REHYDRATION__').html();
    if (!raw) return null;

    const itemStruct = JSON.parse(raw)
      .__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;

    const text = (itemStruct?.desc || '').trim();
    if (!text) return null;

    const image = itemStruct?.video?.cover || itemStruct?.video?.originCover || null;
    return { text, image };
  } catch {
    return null;
  }
}

/**
 * Repli si TikTok bloque la page vidéo avec son challenge anti-bot (page
 * "Please wait..." Slardar/WAF, sans __UNIVERSAL_DATA_FOR_REHYDRATION__ ni
 * og:description) : l'API oEmbed officielle (utilisée pour les intégrations,
 * type WordPress/Twitter) reste accessible et renvoie la légende complète
 * dans `title`.
 */
async function getTikTokOembedSource(videoUrl) {
  try {
    const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(videoUrl)}`, {
      headers: BASE_HEADERS,
    });
    if (!res.ok) return null;

    const data = await res.json();
    const text = (data.title || '').trim();
    if (!text) return null;

    return { text, image: data.thumbnail_url || null };
  } catch {
    return null;
  }
}

/**
 * Isole le texte écrit par le créateur dans og:description (Instagram).
 * Format habituel : `1,2K likes, 34 comments - user on Instagram: "<légende>"`.
 * On garde le contenu entre le premier et le dernier guillemet.
 */
function cleanSocialCaption(text) {
  if (!text) return '';
  const match = text.match(/"([\s\S]*)"/);
  return (match ? match[1] : text).trim();
}

/**
 * @returns {Promise<{ text: string, image: string|null } | null>}
 */
async function getSocialCaptionSource(url, platform) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetchFollowingRedirects(url, controller.signal);
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);

    // TikTok : la légende complète vient des données embarquées, pas des meta og:.
    if (platform === 'tiktok') {
      const fromData = getTikTokDataSource($);
      if (fromData) return fromData;
    }

    const rawDescription =
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content') ||
      '';
    const image = $('meta[property="og:image"]').attr('content') || null;

    const caption = cleanSocialCaption(decodeEntities(rawDescription));
    if (caption) return { text: caption, image };

    // TikTok : ni données embarquées ni og:description → la page a probablement
    // renvoyé un challenge anti-bot. L'API oEmbed reste accessible.
    if (platform === 'tiktok') return getTikTokOembedSource(res.url);

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Export principal ─────────────────────────────────────────────────────────

/**
 * @param {string} url
 * @param {'youtube'|'instagram'|'tiktok'} platform
 * @returns {Promise<{ text: string, image: string|null } | null>}
 */
async function getVideoRecipeSource(url, platform) {
  if (platform === 'youtube') return getYoutubeRecipeSource(url);
  return getSocialCaptionSource(url, platform);
}

module.exports = { detectVideoPlatform, getVideoRecipeSource };
