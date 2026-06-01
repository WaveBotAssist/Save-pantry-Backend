const express = require('express');
const router = express.Router();
const SharedRecipe = require('../models/sharedRecipe');
// Echappe les caracteres HTML speciaux pour prevenir les injections XSS
function escapeHtml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#x27;');
}


// GET /s/:code
// Route publique — aucun token requis.
// Sert une page HTML qui tente d'ouvrir l'app via deep link,
// puis redirige vers la recette originale si l'app n'est pas installée.
router.get('/:code', async (req, res) => {
  try {
    const entry = await SharedRecipe.findOne({ code: req.params.code });

    // Code inconnu ou expiré → on renvoie vers le site
    if (!entry) return res.redirect('https://savepantry.org');

    // On encode l'URL pour pouvoir la passer en query param sans casser l'URL
    /* encodeURIComponent — transforme https://marmiton.org/recette?id=1 en https%3A%2F%2F.... C'est
   obligatoire car on met l'URL dans un autre URL. Sans ça, les ? et & de l'URL originale
   casseraient le deep link.*/
    const encodedUrl  = encodeURIComponent(entry.sourceUrl);
    const appDeepLink = `savepantry://importRecipe?url=${encodedUrl}`;
    const safeSourceUrl = escapeHtml(entry.sourceUrl);
    const safeAppLink   = escapeHtml(appDeepLink);


    res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Recette partagée — Save Pantry</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f8fafc; display: flex; align-items: center;
      justify-content: center; min-height: 100vh; padding: 20px;
    }
    .card {
      background: #fff; border-radius: 20px; padding: 40px 28px;
      max-width: 380px; width: 100%; text-align: center;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    }
    .logo { width: 72px; height: 72px; border-radius: 18px; margin: 0 auto 16px; display: block; }
    h1 { font-size: 22px; font-weight: 700; color: #0f172a; margin-bottom: 8px; }
    p { font-size: 15px; color: #64748b; line-height: 1.5; margin-bottom: 28px; }
    .btn {
      display: block; padding: 16px; background: #16a34a; color: #fff;
      border-radius: 14px; text-decoration: none; font-weight: 700;
      font-size: 16px; margin-bottom: 12px;
    }
    .btn-secondary {
      display: block; padding: 14px; background: #f1f5f9; color: #475569;
      border-radius: 14px; text-decoration: none; font-weight: 600; font-size: 14px;
      margin-bottom: 12px;
    }
    .btn-download {
      display: block; padding: 14px; background: #f1f5f9; color: #16a34a;
      border-radius: 14px; text-decoration: none; font-weight: 600; font-size: 14px;
      margin-bottom: 12px;
    }
    .divider {
      font-size: 12px; color: #cbd5e1; margin: 4px 0 16px;
    }
  </style>
</head>
<body>
  <div class="card">
    <img class="logo" src="/icon-savepantry.png" alt="SavePantry">
    <h1>Recette partagée</h1>
    <p>Ouvrez cette recette dans SavePantry pour l'importer en un clic.</p>
    <a class="btn" href="${safeAppLink}">Ouvrir dans SavePantry</a>
    <p class="divider">Pas encore l'app ?</p>
    <a class="btn-download" href="https://play.google.com/store/apps/details?id=com.lionel455.Frontend">Télécharger SavePantry</a>
    <a class="btn-secondary" href="${safeSourceUrl}">Voir la recette originale</a>
  </div>
  <script>
    // Chrome Android bloque window.location vers un custom scheme sans geste utilisateur.
    // Le bouton "Ouvrir dans SavePantry" déclenche le deep link via un vrai tap utilisateur.
  </script>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Erreur serveur.');
  }
});

module.exports = router;


