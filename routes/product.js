var express = require('express');
var router = express.Router();
const Product = require('../models/product')
const User = require('../models/users')
const checkToken = require('../middlewares/checkToken');

// Route pour ajouter un nouveau produit dans la collection products ou myproducts.
router.post('/addproduct', checkToken, async (req, res) => {
  try {
    const userId = req.user._id; // Récupérer l'ID de l'utilisateur à partir du token
    const { codebarre, name, categorie, prix, unit, image, expiration, emplacement, quantite, calorie, magasin } = req.body;
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

router.put('/myproducts/:productId', checkToken, async (req, res) => {
  const userId = req.user._id; // Récupérer l'ID de l'utilisateur à partir du token grace a checkToken middleware
  const { productId } = req.params; // L'identifiant du produit
  const { codebarre, prix, ...otherUpdates } = req.body;
  console.log(otherUpdates)
  if (!userId) {
    return res.status(401).json({ result: false, error: "Token manquant" });
  }

  try {
    // Mettre à jour le produit dans le sous-document `myproducts`
    const updatedUser = await User.findOneAndUpdate(
      { _id: userId, "myproducts._id": productId }, // Recherche l'utilisateur et l'id du sous-document
      {
        $set: {
          "myproducts.$.codebarre": codebarre,
          "myproducts.$.prix": prix,
          "myproducts.$.updatedAt": new Date(), // Mettre à jour la date
          ...Object.keys(otherUpdates).reduce((acc, key) => {
            acc[`myproducts.$.${key}`] = otherUpdates[key];
            return acc;
          }, {})
        }
      },
      { new: true } // Retourne le document mis à jour
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

router.delete('/deleteProduct/:productId', checkToken, async (req, res) => {
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


// afficher tout les produits
router.get('/getproducts', (req, res) => {
  Product.find().then(dataProduct => {
    res.json({ result: true, ListProducts: dataProduct })
  })
})

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