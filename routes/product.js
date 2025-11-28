var express = require('express');
var router = express.Router();
const Product = require('../models/product');
const User = require('../models/users');
// utilisation du model planning pour delete un produit en meme temps que dans le stock utilisateur
const Planning = require('../models/planning')
const fetch = require('node-fetch');
const { uploadToR2, deleteFromR2 } = require('../services/R2cloudflare');
const multer = require('multer');
const { checkPremiumStatus } = require('../middlewares/checkPremium');

// Multer pour lire le fichier en RAM (pas sur disque)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5 Mo max
});


// ---- UPLOAD ROUTE ----
router.post('/r2/upload', upload.single('photoproduct'), async (req, res) => {/*upload.single('file') est un middleware de multer.
Il sert à analyser la requête HTTP quand elle contient un fichier uploadé (de type multipart/form-data)
et à rendre ce fichier accessible dans req.file*/
  try {
    // ✅ Vérification Premium avec double-check
    const user = await User.findById(req.user._id);
    const isPremium = await checkPremiumStatus(user);

    if (!isPremium) {
      return res.status(403).json({ success: false, error: "Compte non premium — upload R2 désactivé." });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: "Aucun fichier envoyé" });
    }

    const { url, key } = await uploadToR2(req.file.buffer, req.file.originalname, 'products-users');
    console.log("Image uploadée sur R2:", key);

    res.json({ success: true, url, key });
  } catch (err) {
    console.error("Erreur upload R2:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// route pour supprimer une image de R2 via sa clé
router.delete('/r2/delete/:key', async (req, res) => {
  try {

    const { key } = req.params;
    await deleteFromR2(key);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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

    res.json({ result: true, product: productData });
  } catch (e) {
    console.error(e);
    res.status(500).json({ result: false, error: e.message });
  }
})


// Route pour ajouter un nouveau produit dans la collection products ou myproducts.
router.post('/addproduct', async (req, res) => {
  try {
    const userId = req.user._id;
    const { codebarre, name, categorie, prix, currency, unit, image, expiration, emplacement, quantite, calorie, magasin } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({
        result: false,
        message: 'Le nom du produit est requis.',
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        result: false,
        message: 'Utilisateur introuvable.',
      });
    }

    // ✅ Vérification Premium avec double-check
    const isPremium = await checkPremiumStatus(user);
    console.log('📊 Statut Premium:', isPremium);

    // Limite pour les utilisateurs non premium
    if (!isPremium && user.myproducts.length >= 30) {
      return res.status(403).json({
        result: false,
        message: 'fullStockMessage'
      });
    }

    // Cas sans code-barres
    if (!codebarre || codebarre.trim() === '') {
      // Vérifier le doublon basé sur le name
      const existProduct = user.myproducts.some((product) => product.name === name);
      if (existProduct) {
        return res.status(400).json({ result: false, message: 'productexist' });
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
  const { codebarre, prix, expiration, image, ...otherUpdates } = req.body;

  if (!userId) {
    return res.status(401).json({ result: false, error: "Token manquant" });
  }

  try {
    // 🔍 Récupérer l'utilisateur et le produit actuel
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ result: false, error: "Utilisateur introuvable" });
    }

    const currentProduct = user.myproducts.find(p => p._id.toString() === productId);
    if (!currentProduct) {
      return res.status(404).json({ result: false, error: "Produit introuvable" });
    }

    // 🗑️ Si nouvelle image fournie ET ancienne image R2 existe
    if (image && currentProduct.image && currentProduct.image.includes('r2.dev')) {
      console.log("🗑️ Suppression ancienne image backend:", currentProduct.image);

      try {
        const oldKey = currentProduct.image.split('/').slice(-2).join('/');
        await deleteFromR2(oldKey);
        console.log("✅ Ancienne image supprimée");
      } catch (delErr) {
        console.error("⚠️ Échec suppression ancienne image:", delErr);
        // On continue quand même la mise à jour
      }
    }

    // 📝 Construire les updates
    const updates = {
      "myproducts.$.codebarre": codebarre,
      "myproducts.$.prix": prix,
      "myproducts.$.image": image || currentProduct.image, // ✅ Garder ancienne si pas de nouvelle
      "myproducts.$.updatedAt": new Date(),
      ...Object.keys(otherUpdates).reduce((acc, key) => {
        acc[`myproducts.$.${key}`] = otherUpdates[key];
        return acc;
      }, {})
    };

    // Si l'expiration est modifiée → reset notifiedExpired
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
      return res.status(404).json({ result: false, error: "Mise à jour échouée" });
    }

    console.log("✅ Produit mis à jour avec succès");
    res.json({ result: true, user: updatedUser });

  } catch (err) {
    console.error("❌ Erreur mise à jour produit:", err);
    res.status(500).json({ result: false, error: err.message });
  }
});



// Route pour supprimer un produit dans le sous-document myproducts d'un utilisateur.

router.delete('/deleteProduct/:productId', upload.single('photoproduct'), async (req, res) => {
  try {
    const userId = req.user._id; // Récupérer l'ID de l'utilisateur à partir du token
    const { productId } = req.params; // ID du produit à supprimer
    const { imageKey } = req.body; // Clé de l'image à supprimer de R2 (si existante)

    if (!userId) {
      return res.status(401).json({ result: false, message: "Token manquant." });
    }
    // Supprimer l'image de R2 si une clé est fournie
    if (imageKey) {
      const decodedKey = imageKey.replace(`${process.env.R2_PUBLIC_BASE}/`, '');
      await deleteFromR2(decodedKey);
      console.log('image supprimée de R2:', decodedKey);
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

    // Supprimer le produit dans tous les plannings liés à cet utilisateur apres la suppression du meme produit de myproducts
    const planning = await Planning.findOne({ userId });

    if (planning) {
      planning.weeks.forEach(week => {
        // week.days est une Map → on itère dessus
        week.days.forEach((day, dayName) => {
          // On filtre stockItems pour enlever le produit
          day.stockItems = day.stockItems.filter(item => item._id.toString() !== productId);
        });
      });

      // Sauvegarder les modifications
      await planning.save();
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