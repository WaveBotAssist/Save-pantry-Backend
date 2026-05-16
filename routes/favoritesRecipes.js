const express = require('express');
const router = express.Router();
const User = require('../models/users');
const { calculerCompatibilite } = require('../services/compatibilityService');

// ✅ Ajouter une recette aux favoris
router.post('/add', async (req, res) => {
  const { recipeId } = req.body;
  if (!recipeId) return res.status(400).json({ success: false, message: 'ID de recette manquant' });

  try {
    await User.findByIdAndUpdate(req.user._id, {
      $addToSet: { favorites: recipeId }
    });
    res.json({ success: true, message: 'Recette ajoutée aux favoris' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ Supprimer une recette des favoris
router.delete('/remove/:recipeId', async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, {
      $pull: { favorites: req.params.recipeId }
    });
    res.json({ success: true, message: 'Recette retirée des favoris' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ Obtenir la liste des recettes favorites avec leur compatibilité garde-manger
router.get('/list', async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .populate('favorites')
      .select('favorites myproducts');

    // Enrichit chaque favori avec son score de compatibilité
    const favorites = (user.favorites ?? []).map(recette => {
      const { ingredientsManquants, pourcentageCompatibilite, score } =
        calculerCompatibilite(recette, user.myproducts ?? []);

      return {
        ...recette.toObject(),
        ingredientsManquants,
        pourcentageCompatibilite,
        score,
      };
    });

    res.json({ success: true, favorites });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
