const mongoose = require('mongoose');

/**
 * Collection dédiée aux recettes personnelles des utilisateurs.
 * Séparée du catalogue communautaire (collection "recipes") pour éviter
 * tout mélange entre contenu extrait/scanné et recettes originales validées.
 */
const userRecipeSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'users',
      required: true,
      index: true,
    },
    titre:              { type: String, required: true, trim: true },
    ingredients:        [{ type: String }],
    instructions:       [{ type: String }],
    image:              { type: String, default: '' },
    categorie:          { type: String, default: 'autre' },
    langue:             { type: String, default: 'fr' },
    temps_preparation:  { type: Number, default: null },
    portion:            { type: Number, default: null },
    // D'où vient la recette : 'scan' (photo IA), 'url' (import URL), 'manual' (saisie manuelle)
    source:             { type: String, enum: ['scan', 'url', 'manual', 'generated'], default: 'manual' },
    sourceUrl:          { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('userRecipe', userRecipeSchema);
