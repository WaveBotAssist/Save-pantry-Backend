const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

// flash     : vision + texte, tâches complexes (scan photo de recette)
// flashLite : texte uniquement, rapide et économique (planning, tickets, génération)
const GEMINI_MODELS = {
  flash:     'gemini-2.5-flash',
  flashLite: 'gemini-2.5-flash-lite',
};

// Config commune à tous les appels : JSON forcé, thinking désactivé
const BASE_CONFIG = {
  responseMimeType: 'application/json',
  thinkingConfig:   { thinkingBudget: 0 },
  maxOutputTokens:  2048,
};

/**
 * Appel Gemini unifié.
 *
 * @param {object} options
 * @param {string}  options.model      - Identifiant du modèle (GEMINI_MODELS.flash | flashLite)
 * @param {string}  options.prompt     - Prompt texte
 * @param {object}  [options.image]    - { data: base64string, mimeType: string } pour la vision
 * @param {object}  [options.config]   - Surcharge de BASE_CONFIG (ex: { temperature: 0.7 })
 * @returns {Promise<any>}             - Réponse parsée depuis le JSON retourné par Gemini
 */
/**
 * Appel Gemini unifié avec retry automatique sur les erreurs 503 (surcharge temporaire).
 * Tente jusqu'à 3 fois avec 2 secondes d'attente entre chaque essai.
 */
// Timeout par tentative : 20s. Évite que le client mobile ferme la connexion
// avant que le serveur réponde (provoque un "- - ms - -" dans les logs Morgan).
const GEMINI_TIMEOUT_MS = 20_000;

async function callGemini({ model, prompt, image, config = {} }, attempt = 1) {
  const parts = [];
  if (image) parts.push({ inlineData: { data: image.data, mimeType: image.mimeType } });
  parts.push({ text: prompt });

  try {
    const apiCall = ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
      config:   { ...BASE_CONFIG, ...config },
    });
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Gemini timeout (attempt ${attempt})`)), GEMINI_TIMEOUT_MS)
    );
    const response = await Promise.race([apiCall, timeout]);
    // response.text est undefined avec gemini-2.5-flash quand la réponse contient
    // des parties "thinking" — on filtre ces parties et on prend le texte restant
    const text =
      response.text ??
      response.candidates?.[0]?.content?.parts
        ?.filter((p) => !p.thought && p.text)
        ?.map((p) => p.text)
        ?.join('');

    if (!text) throw new Error(`Réponse Gemini vide (model: ${model})`);
    return JSON.parse(text);
  } catch (err) {
    // Retry sur surcharge (503) ou erreur réseau temporaire — max 3 tentatives
    const is503 = err?.code === 503 || err?.status === 'UNAVAILABLE' || err?.message?.includes('503');
    if (is503 && attempt < 3) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      return callGemini({ model, prompt, image, config }, attempt + 1);
    }
    throw err;
  }
}

module.exports = { GEMINI_MODELS, callGemini };
