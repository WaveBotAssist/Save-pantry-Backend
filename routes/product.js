var express = require('express');
var router = express.Router();
const Product = require('../models/product');
const User = require('../models/users');
const fetch = require('node-fetch');


// route pour récupérer les informations d'un produit via son code-barres depuis l'API OpenFoodFacts
router.get('/openfoodfacts/:codebarre', async (req, res) => {
  try {
    const { codebarre } = req.params;
    const fet = await fetch(`https://world.openfoodfacts.org/api/v2/product/${codebarre}?fields=product_name,nutriscore_data,image_url,categories,quantity,nutriments,ecoscore_grade`)
    const productData = await fet.json();

    // Vérifie que l'API renvoie bien un produit
    if (!productData || !productData.product) {
      return res.status(404).json({
        result: false,
        error: "Produit non trouvé dans OpenFoodFacts"
      });
    }

    res.json({ result: true, product : productData });
  } catch (e) {
    console.error(e);
    res.status(500).json({ result: false, error: e.message });
  }
})


// Route pour ajouter un nouveau produit dans la collection products ou myproducts.
router.post('/addproduct', async (req, res) => {
  try {
    const userId = req.user._id; // Récupérer l'ID de l'utilisateur à partir du token
    const { codebarre, name, categorie, prix, currency, unit, image, expiration, emplacement, quantite, calorie, magasin } = req.body;
    if (!name || name.trim() === '') {
      return res.status(400).json({
        result: false,
        message: 'Le nom du produit est requis.',
      });
    }

    // Vérifier que l'utilisateur existe
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        result: false,
        message: 'Utilisateur introuvable.',
      });
    }

    // Cas sans code-barres
    if (!codebarre || codebarre.trim() === '') {
      // Vérifier le doublon basé sur le name
      const existProduct = user.myproducts.some((product) => product.name === name);
      if (existProduct) {
        return res.status(400).json({ result: false, message: 'Produit déjà présent.' });
      }

      user.myproducts.push({
        codebarre: null,
        image,
        name,
        magasin,
        categorie,
        expiration,
        emplacement,
        quantite,
        prix,
        currency,
        calorie,
        unit,
      });

      const data = await user.save();
      return res.json({
        result: true,
        message: "Produit ajouté dans l'inventaire de l'utilisateur (sans code-barres).",
        data: data
      });
    }

    // Cas avec code-barres

    // Vérifier si le produit existe déjà dans Products
    let existingProduct = await Product.findOne({ codebarre });
    if (!existingProduct) {
      existingProduct = new Product({
        name,
        magasin,
        categorie,
        prix,
        currency,
        unit,
        codebarre,
        image,
        calorie,
      });
      await existingProduct.save();
    }

    // Vérifier si le produit est déjà dans myproducts de l'utilisateur
    const productExistsInMyProducts = user.myproducts.some(product => product.codebarre === codebarre);
    if (productExistsInMyProducts) {
      return res.status(400).json({
        result: false,
        message: 'Ce produit existe déjà dans votre inventaire.',
      });
    }

    // Ajouter le produit au sous-document "myproducts"
    user.myproducts.push({
      codebarre,
      image,
      name,
      magasin,
      categorie,
      expiration,
      emplacement,
      quantite,
      prix,
      currency,
      unit,
      calorie,
    });

    const data = await user.save();
    return res.json({
      result: true,
      message: "Produit ajouté avec succès dans l'inventaire de l'utilisateur.",
      data: data,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      result: false,
      message: "Une erreur est survenue lors de l'ajout du produit. Pas de nom de produit?",
    });
  }
});



// Route pour mettre à jour les données dans le sous-document myproducts

router.put('/myproducts/:productId', async (req, res) => {
  const userId = req.user._id;
  const { productId } = req.params;
  const { codebarre, prix, expiration, ...otherUpdates } = req.body;

  if (!userId) {
    return res.status(401).json({ result: false, error: "Token manquant" });
  }

  try {
    // Construire les updates
    const updates = {
      "myproducts.$.codebarre": codebarre,
      "myproducts.$.prix": prix,
      "myproducts.$.updatedAt": new Date(),
      ...Object.keys(otherUpdates).reduce((acc, key) => {
        acc[`myproducts.$.${key}`] = otherUpdates[key];
        return acc;
      }, {})
    };

    // Si l'expiration est modifiée -> reset notifiedExpired
    if (expiration !== undefined) {
      updates["myproducts.$.expiration"] = expiration;
      updates["myproducts.$.notifiedExpired"] = false;
    }

    const updatedUser = await User.findOneAndUpdate(
      { _id: userId, "myproducts._id": productId },
      { $set: updates },
      { new: true }
    );

    if (!updatedUser) {
      return res.status(404).json({ result: false, error: "Produit ou utilisateur introuvable" });
    }

    res.json({ result: true, user: updatedUser });

  } catch (err) {
    res.status(500).json({ result: false, error: err.message });
  }
});



// Route pour supprimer un produit dans le sous-document myproducts d'un utilisateur.

router.delete('/deleteProduct/:productId', async (req, res) => {
  try {
    const userId = req.user._id; // Récupérer l'ID de l'utilisateur à partir du token
    const { productId } = req.params; // ID du produit à supprimer

    if (!userId) {
      return res.status(401).json({ result: false, message: "Token manquant." });
    }

    // Trouver l'utilisateur et supprimer le produit de `myproducts`
    const updatedUser = await User.findOneAndUpdate(
      { _id: userId },
      { $pull: { myproducts: { _id: productId } } }, // Retirer le produit par son `_id`
      { new: true } // Retourner l'utilisateur mis à jour
    );

    if (!updatedUser) {
      return res.status(404).json({ result: false, message: "Utilisateur introuvable ou produit non existant." });
    }

    res.json({ result: true, message: "Produit supprimé avec succès.", user: updatedUser });

  } catch (error) {
    console.error("Erreur lors de la suppression du produit :", error);
    res.status(500).json({ result: false, message: "Erreur interne du serveur." });
  }
});


// afficher tous les produits (utilisée dans stockScreen pour mise a jour)
router.get('/getproducts', async (req, res) => {
  try {
    const userId = req.user._id;

    if (!userId) {
      return res.status(401).json({ result: false, message: "Non autorisé" });
    }

    const user = await User.findById(userId).select('myproducts');

    if (!user) {
      return res.status(404).json({ result: false, message: "Utilisateur non trouvé" });
    }

    return res.json({ result: true, ListProducts: user.myproducts });
  } catch (error) {
    console.error("❌ Erreur getproducts:", error);
    return res.status(500).json({ result: false, message: "Erreur serveur" });
  }
});


//recherche d'un produit par nom
router.get('/getproducts/:name', (req, res) => {
  Product.findOne({ name: req.params.name }).then(dataProduct => {
    res.json({ result: true, products: dataProduct })
  })
    .then(() => {
      res.status(404).json({ result: false, message: 'This product not existing' })
    }).catch(err => {
      res.status(500).json({ result: false, error: err.message });
    });
})

//recherche d'un produit par son code barre
router.get('/getproducts/code/:codebarre', (req, res) => {
  Product.findOne({ codebarre: req.params.codebarre }).then(dataProduct => {
    res.status(200).json({ result: true, products: dataProduct })
  })
    .catch(err => {
      res.status(500).json({ result: false, error: err.message });
    });
})




module.exports = router;