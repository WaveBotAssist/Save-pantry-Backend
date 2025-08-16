const express = require('express')
const router = express.Router()
const checkToken = require('../middlewares/checkToken');
const checkRole = require('../middlewares/checkRole');
const User = require('../models/users');
const Recipes = require('../models/recipe');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');

// Setup S3 client (compatible R2)
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// Multer pour lire le fichier en RAM (pas sur disque)
const upload = multer({ storage: multer.memoryStorage() });

//ci-dessous les deux routes pour upload ou remove une image de R2 cloudflare
// ---- UPLOAD ROUTE ----
router.post('/r2/upload', checkToken, upload.single('file'), async (req, res) => {
  try {
    const key = `images/${Date.now()}_${req.file.originalname}`;
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    });
    await s3.send(command);
    const imageUrl = `${process.env.R2_PUBLIC_BASE}/${key}`;
    res.json({ success: true, url: imageUrl, key });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- DELETE ROUTE ----
router.delete('/r2/delete/:key', checkToken, async (req, res) => {
  try {
    const command = new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: decodeURIComponent(req.params.key),
    });
    await s3.send(command);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


//route pour recuperer les alliments de l'user et retourner des recettes qui corresponde a leur produits
router.post('/myrecipes', checkToken, async (req, res) => {
  try {
    const owner = req.user._id;
    const { manquantMax, categorie, tempsMax, search } = req.body;
    // choisir la langue des recettes dans la requête, sinon par défaut en français
    const lang = req.query.lang || 'fr'; // par défaut, français
    //pagination par 20 recettes
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const skip = (page - 1) * limit;

    if (!owner)
      return res.status(400).json({ result: false, error: "Token manquant" });

    const user = await User.findOne({ _id: owner }, { myproducts: 1 });
    if (!user)
      return res.status(404).json({ result: false, error: "Utilisateur introuvable" });

    // 🔧 Utilitaires
    const motsAExclure = new Set([
      "un", "une", "des", "le", "la", "les", "du", "de", "d", "à", "avec", "et",
      "au", "en", "quelques", "peu", "pour", "par", "sur", "dans", "g", "kg",
      "ml", "l", "cl", "cuillère", "cuillere", "soupe", "cafe", "pincee",
      "tranche", "verre", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
    ]);

    const singulariser = mot => {
      if (mot.length <= 3) return mot;
      return mot.endsWith("s") || mot.endsWith("x")
        ? mot.slice(0, -1)
        : mot;
    };

    // 🔍 Extraction du stock utilisateur
    const ingredientsDispo = user.myproducts.flatMap(p => {
      // a) Normaliser + retirer accents, œ, mettre en minuscules
      const normalize = str =>
        str
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/œ/g, "oe")
          .toLowerCase();

      // b) Extrait tous les mots utiles sans chiffres, sans ponctuation
      const extraireMotsUtiles = texte =>
        normalize(texte)
          .split(/\s+/)
          .filter(mot =>
            mot.length > 2 &&
            !motsAExclure.has(mot) &&
            !/\d/.test(mot)             // retire tout token contenant un chiffre
          )
          .map(singulariser);            // passe au singulier

      return extraireMotsUtiles(p.name);
    });


    // 1. Construire dynamiquement le filtre Mongo
    let filter = { langue: lang };

    // 2. Si recherche utilisateur, on ajoute le filtre "titre"
    if (req.body.search && req.body.search.length > 0) {
      filter.titre = { $regex: search, $options: 'i' }; // insensible à la casse
    }

    // 3) Exclure les status 'pending' et 'rejected', tout en gardant les docs sans status
    filter.$or = [
      { status: { $exists: false } },
      { status: { $nin: ['pending', 'rejected'] } } // $nin = "pas dans cette liste"
    ];

    const recettes = await Recipes.find(filter, {
      _id: 1,
      titre: 1,
      tags: 1,
      langue: 1,
      ingredients: 1,
      instructions: 1,
      image: 1,
      categorie: 1,
      temps_preparation: 1,
      portion: 1,
      difficulte: 1,
      status: 1,
    })

    const maxManquants = parseInt(manquantMax) || 0;
    const maxTemps = parseInt(tempsMax) || null;


    const recettesCompatibles = recettes.map(recette => {
      // 1) On découpe chaque ingrédient de la recette sur la virgule
      const sousIngredients = recette.ingredients.map(ing => ing.trim()).filter(Boolean);

      // 2) Pour chacun des sous-ingrédients, on extrait les mots utiles
      //    (sans chiffres, sans ponctuation), on singularise, et, si un mot manque,
      //    alors on marque le sous-ingrédient comme manquant.
      const ingredientsManquants = sousIngredients.filter(sousIng => {
        // a) Nettoyage complet de la chaîne (accents, ponctuation)
        const nettoye = sousIng
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/œ/g, "oe")
          .toLowerCase()
          .replace(/[^a-z0-9\s]+/g, " "); // retire virgules, points, etc.

        // b) Extraction des mots utiles
        const motsUtiles = nettoye
          .split(/\s+/)
          .filter(mot =>
            mot.length > 2 &&
            !motsAExclure.has(mot) &&
            !/\d/.test(mot)
          )
          .map(singulariser);

        // c) Si AU MOINS un mot utile n'est pas en stock ⇒ sous-ingrédient manquant
        return motsUtiles.every(mot => !ingredientsDispo.includes(mot))
      });

      const totalIngredients = sousIngredients.length;
      const nbManquants = ingredientsManquants.length;
      const score = totalIngredients - nbManquants;
      const pourcentageCompatibilite = totalIngredients > 0
        ? Math.round((score / totalIngredients) * 100)
        : 0;

      return {
        ...recette.toObject(),
        id: recette._id.toString(), //  ici on garantit une clé unique
        ingredientsManquants,
        score,
        pourcentageCompatibilite
      };
    })
      // 3) On filtre par nombre max d'ingrédients manquants
      .filter(r => r.ingredientsManquants.length <= maxManquants)
      // 4) Filtre par catégorie (facultatif)
      .filter(r => !categorie || r.categorie.toLowerCase() === categorie.toLowerCase())
      // 5) Filtre par temps de préparation (facultatif)
      .filter(r => !maxTemps || r.temps_preparation === maxTemps)
      // 6) Tri par pourcentage décroissant
      .sort((a, b) => b.pourcentageCompatibilite - a.pourcentageCompatibilite)


    // On slice le tableau pour la pagination
    const total = recettesCompatibles.length;
    const pages = Math.ceil(total / limit);
    const sliceEnd = limit === 0 ? undefined : skip + limit;
    const paginated = recettesCompatibles.slice(skip, sliceEnd);

    return res.json({
      result: true,
      page,
      pages,
      total,
      recettes: paginated
    });

  } catch (err) {
    return res.status(500).json({ result: false, error: err.message });
  }
});

// Route pour soumettre une recette communautaire
router.post('/submit', checkToken, async (req, res) => {
  try {
    const {
      titre, categorie, langue, source, url, image,
      tags, ingredients, instructions, temps_preparation, portion, difficulte
    } = req.body;
    //ajout de l id de l utilisateur en bdd
    const userId = req.user._id;
    // Validation de base
    if (!image || !titre || !titre.trim() || !categorie || !Array.isArray(ingredients) || !ingredients.length ||
      !Array.isArray(instructions) || !instructions.length) {
      return res.status(400).json({ result: false, error: "Tous les champs marqués d'un astérisque (*) sont obligatoires." });
    }

    // Par défaut, on met en attente de validation
    const newRecipe = new Recipes({
      titre,
      categorie,
      langue,
      source: source || "user",
      url: url || "",
      image: image || "",
      tags: tags || [],
      ingredients,
      instructions,
      temps_preparation: temps_preparation || null,
      portion: portion || null,
      difficulte: difficulte || "facile",
      auteur: userId,
      status: "pending"  // Ajoute ce champ au schéma pour la modération !
    });

    await newRecipe.save();

    return res.json({ result: true, message: "Recette soumise avec succès ! Elle sera visible après validation." });

  } catch (err) {
    return res.status(500).json({ result: false, error: err.message });
  }
});


// route pour retrouver toutes les recettes que l utilisateur a proposé (utiliser dans MySharedRecipesScreen.js)
router.get('/my-recipes', checkToken, async (req, res) => {
  try {
    const userId = req.user._id;
    const myRecipes = await Recipes.find({ auteur: userId }).sort({ createdAt: -1 });
    res.json({ result: true, recipes: myRecipes });
  } catch (e) {
    res.status(500).json({ result: false, error: e.message });
  }
});


// petite route utilisée dans PlanningScreen.js pour afficher toutes les recettes et les planifier
router.get('/recipesList', async (req, res) => {
  const allRecipes = await Recipes.find()
  res.json({ result: allRecipes })
})


// Lister les pending
router.get('/mod/pending', checkToken, checkRole('admin'), async (req, res) => {
  const { page = 1, limit = 30 } = req.query;
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    Recipes.find({ status: 'pending' })
      .select('_id titre image categorie langue tags ingredients instructions auteur createdAt')
      .sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
    Recipes.countDocuments({ status: 'pending' }),
  ]);
  res.json({ result: true, page: +page, pages: Math.ceil(total / limit), total, items });
});

// Approuver
router.post('/mod/:id/approve', checkToken, checkRole('admin'), async (req, res) => {
  const r = await Recipes.findByIdAndUpdate(req.params.id, {
    $set: { status: 'approved', reviewedBy: req.user._id, reviewedAt: new Date(), rejectionReason: null }
  }, { new: true });
  if (!r) return res.status(404).json({ result: false, error: 'Not found' });
  res.json({ result: true, recipe: r });
});

// Refuser
router.post('/mod/:id/reject', checkToken, checkRole('admin'), async (req, res) => {
  const { reason } = req.body;
  const r = await Recipes.findByIdAndUpdate(req.params.id, {
    $set: { status: 'rejected', reviewedBy: req.user._id, reviewedAt: new Date(), rejectionReason: reason || '' }
  }, { new: true });
  if (!r) return res.status(404).json({ result: false, error: 'Not found' });
  res.json({ result: true, recipe: r });
});



module.exports = router