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

// Supprime une image R2 via sa clé — réservé aux utilisateurs premium connectés
router.delete('/r2/delete/:key', async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const isPremium = await checkPremiumStatus(user);
    if (!isPremium) {
      return res.status(403).json({ success: false, error: 'Reserve aux comptes premium.' });
    }
    await deleteFromR2(decodeURIComponent(req.params.key));
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


/**
 * POST /product/import
 * ─────────────────────────────────────────────────────────────────────────────
 * Import groupé de produits — utilisé exclusivement par migrateLocalData()
 * lors de la transition anonyme → compte connecté.
 *
 * Avantage par rapport à N appels /addproduct successifs :
 *   - 1 seule requête HTTP  →  1 seul user.save()  →  1 seul événement socket
 *   - Les produits apparaissent tous en même temps dans le garde-manger
 *     au lieu de s'afficher un par un de façon visible et lente.
 *
 * Body :
 *   products     {Array}   Liste de produits à importer (format LocalProduct sans _id)
 *   isMigration  {boolean} Si true → la limite 50 produits non-premium est ignorée
 *
 * Comportement :
 *   - Les produits sans nom sont ignorés silencieusement.
 *   - Les doublons (même name déjà dans myproducts) sont ignorés silencieusement.
 *   - Si aucun produit valide → réponse 200 sans écriture en base.
 * ─────────────────────────────────────────────────────────────────────────────
 */
router.post('/import', async (req, res) => {
  try {
    const userId = req.user._id;
    const { products, isMigration } = req.body;

    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ result: false, message: 'Tableau de produits requis.' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ result: false, message: 'Utilisateur introuvable.' });

    const isPremium = await checkPremiumStatus(user);
    const existingNames = new Set(user.myproducts.map(p => p.name));

    let added = 0;
    for (const product of products) {
      const { name, codebarre, image, categorie, prix, currency, unit, expiration, emplacement, quantite, calorie, magasin, nutriments } = product;
      if (!name || name.trim() === '') continue;
      if (existingNames.has(name)) continue;
      if (!isMigration && !isPremium && user.myproducts.length + added >= 50) break;

      user.myproducts.push({
        codebarre: codebarre || null,
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
        nutriments: nutriments || null,
      });
      existingNames.add(name);
      added++;
    }

    if (added > 0) {
      await user.save();
      const io = req.app.get('io');
      io.to(`user-${userId}`).emit('products-updated');
    }

    return res.json({ result: true, added });
  } catch (error) {
    console.error('❌ Erreur addproducts-bulk:', error);
    return res.status(500).json({ result: false, message: "Erreur lors de l'import groupé." });
  }
});

// Route pour ajouter un nouveau produit dans la collection products ou myproducts.
router.post('/addproduct', async (req, res) => {
  try {
    const userId = req.user._id;
    const { codebarre, name, categorie, prix, currency, unit, image, expiration, emplacement, quantite, calorie, magasin, nutriments, isMigration } = req.body;

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

    // Limite pour les utilisateurs non premium (ignorée lors de la migration anonyme)
    if (!isMigration && !isPremium && user.myproducts.length >= 50) {
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
        nutriments: nutriments || null,
      });

      const data = await user.save();

      const io = req.app.get('io'); //écupère l'instance socket
      io.to(`user-${userId}`).emit('products-updated');//cible la room de cet utilisateur spécifiquement


      const approachingLimit = !isMigration && !isPremium && data.myproducts.length === 40;
      return res.json({
        result: true,
        message: approachingLimit ? 'approachingLimit' : "Produit ajouté dans l'inventaire de l'utilisateur (sans code-barres).",
        warning: approachingLimit ? 'approachingLimit' : null,
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
      nutriments: nutriments || null,
    });

    const data = await user.save();
    const approachingLimit = !isMigration && !isPremium && data.myproducts.length === 40;
    return res.json({
      result: true,
      message: approachingLimit ? 'approachingLimit' : "Produit ajouté avec succès dans l'inventaire de l'utilisateur.",
      warning: approachingLimit ? 'approachingLimit' : null,
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

    // Supprime l'ancienne image R2 si on en envoie une nouvelle et que l'ancienne est sur R2
    if (
      image &&
      currentProduct.image &&
      process.env.R2_PUBLIC_BASE &&
      currentProduct.image.includes(process.env.R2_PUBLIC_BASE) &&
      currentProduct.image !== image
    ) {
      try {
        const oldKey = currentProduct.image.replace(`${process.env.R2_PUBLIC_BASE}/`, '');
        await deleteFromR2(oldKey);
      } catch (delErr) {
        console.error('⚠️ Échec suppression ancienne image R2 produit:', delErr.message);
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
   
    const io = req.app.get('io'); //écupère l'instance socket
    io.to(`user-${userId}`).emit('products-updated');//cible la room de cet utilisateur spécifiquement

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
    // Supprime l'image R2 uniquement si c'est une URL R2 (pas une base64)
    if (imageKey && process.env.R2_PUBLIC_BASE && imageKey.includes(process.env.R2_PUBLIC_BASE)) {
      try {
        const decodedKey = imageKey.replace(`${process.env.R2_PUBLIC_BASE}/`, '');
        await deleteFromR2(decodedKey);
      } catch (e) {
        console.error('⚠️ Échec suppression image R2 produit:', e.message);
      }
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

    const io = req.app.get('io'); //Récupère l'instance socket
    io.to(`user-${userId}`).emit('products-updated');//cible la room de cet utilisateur spécifiquement


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
router.get('/getproducts/:name', async (req, res) => {
  try {
    const dataProduct = await Product.findOne({ name: req.params.name });
    if (!dataProduct) {
      return res.status(404).json({ result: false, message: 'This product not existing' });
    }
    res.json({ result: true, products: dataProduct });
  } catch (err) {
    res.status(500).json({ result: false, error: err.message });
  }
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