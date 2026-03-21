const { GoogleGenAI } = require("@google/genai")

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

async function ApiGemini(scan) {
    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-lite",
        contents: scan || "",
        config: {
            temperature: 0.1,
            maxOutputTokens: 500,
            //responseMimeType: "application/json",
        }
    });
    return response.text
}

/*async function ApiGemini(scan) {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `
Voici un ticket de caisse :

${scan}

Analyse-le et extrait les informations sous forme JSON.

Format attendu :
{
  "store": "",
  "date": "",
  "items": [
    { "name": "", "price": 0 }
  ],
  "total": 0
}
              `,
            },
          ],
        },
      ],
      config: {
        temperature: 0.1,
        maxOutputTokens: 500,
      },
    });

    return response.text;

  } catch (error) {
    console.error("Erreur Gemini:", error);
    return null;
  }
}*/

module.exports = ApiGemini