const mongoose = require('mongoose');

// Schéma minimal — on ne stocke que le strict nécessaire :
// code      = identifiant court dans l'URL (ex: "aB3xZ9qR")
// sourceUrl = URL d'origine de la recette (ex: "https://marmiton.org/...")
// createdAt = date de création — le champ "expires" dit à MongoDB de supprimer
//             automatiquement le document 30 jours après createdAt (TTL index)
const sharedRecipeSchema = new mongoose.Schema({
  code:      { type: String, required: true, unique: true, index: true },
  sourceUrl: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 },
});

module.exports = mongoose.model('sharedrecipes', sharedRecipeSchema);
