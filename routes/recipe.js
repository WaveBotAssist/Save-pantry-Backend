const express = require('express')
const router = express.Router()
const checkRole = require('../middlewares/checkRole');
const User = require('../models/users');
const Recipes = require('../models/recipe');
const UserRecipe = require('../models/userRecipe');
const { uploadToR2, deleteFromR2 } = require('../services/R2cloudflare');
const multer = require('multer');
const { checkPremiumStatus } = require('../middlewares/checkPremium');


// Multer pour lire le fichier en RAM (pas sur disque)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5 Mo max
});


//ci-dessous les deux routes pour upload ou remove une image de R2 cloudflare
// ---- UPLOAD ROUTE ----
router.post('/r2/upload', upload.single('file'), async (req, res) => {/*upload.single('file') est un middleware de multer.
Il sert à analyser la requête HTTP quand elle contient un fichier uploadé (de type multipart/form-data)
et à rendre ce fichier accessible dans req.file*/
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "Aucun fichier envoyé" });
    }
    const { url, key } = await uploadToR2(req.file.buffer, req.file.originalname, 'recipes-users');

    const imageUrl = url; // URL publique de l’image

    res.json({ success: true, url: imageUrl, key });
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


//route pour recuperer les alliments de l'user et retourner des recettes qui corresponde a leur produits
// Accessible en mode anonyme (req.user = null) : retourne toutes les recettes sans filtrage par stock
router.post('/myrecipes', async (req, res) => {
  try {
    const { manquantMax, categorie, tempsMax, search } = req.body;
    // choisir la langue des recettes dans la requête, sinon par défaut en français
    const lang = req.query.lang || 'fr'; // par défaut, français
    //pagination par 20 recettes
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const skip = (page - 1) * limit;

    // 🔧 Utilitaires (utilisés avec ou sans compte)
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

    // 🔍 Extraction du stock utilisateur — vide en mode anonyme (req.user = null)
    let ingredientsDispo = [];

    if (req.user) {
      const user = await User.findOne({ _id: req.user._id }, { myproducts: 1 });
      if (!user)
        return res.status(404).json({ result: false, error: "Utilisateur introuvable" });

      const normalize = str =>
        str
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/œ/g, "oe")
          .toLowerCase();

      const extraireMotsUtiles = texte =>
        normalize(texte)
          .split(/\s+/)
          .filter(mot =>
            mot.length > 2 &&
            !motsAExclure.has(mot) &&
            !/\d/.test(mot)
          )
          .map(singulariser);

      ingredientsDispo = user.myproducts.flatMap(p => extraireMotsUtiles(p.name));
    }


    // 1. Construire dynamiquement le filtre Mongo
    let filter = { langue: lang };

    // 2. Si recherche utilisateur, on ajoute le filtre "titre"
    if (search && search.length > 0) {
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

    // En mode anonyme, on ignore le filtre d'ingrédients manquants → toutes les recettes sont visibles
    const maxManquants = req.user ? (parseInt(manquantMax) || 0) : Infinity;
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
      // 6) Tri par pourcentage décroissant — mélange aléatoire si tous les scores sont à 0
      // (garde-manger vide ou mode anonyme) pour varier l'ordre à chaque chargement
      .sort((a, b) => {
        if (a.pourcentageCompatibilite !== b.pourcentageCompatibilite)
          return b.pourcentageCompatibilite - a.pourcentageCompatibilite;
        return Math.random() - 0.5;
      })


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
router.post('/submit', async (req, res) => {
  try {
    const {
      titre, categorie, langue, source, url, image,
      tags, ingredients, instructions, temps_preparation, portion, difficulte
    } = req.body;

    const userId = req.user._id;

    // Validation de base
    if (!image || !titre || !titre.trim() || !categorie || !Array.isArray(ingredients) || !ingredients.length ||
      !Array.isArray(instructions) || !instructions.length) {
      return res.status(400).json({
        result: false,
        error: "Tous les champs marqués d'un astérisque (*) sont obligatoires."
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ result: false, error: "Utilisateur introuvable." });
    }

    // Compter les recettes
    const recipeCount = await Recipes.countDocuments({ auteur: userId });

    // ✅ Vérification Premium avec double-check
    const isPremium = await checkPremiumStatus(user);
    console.log('📊 Statut Premium:', isPremium);

    // Limite pour les utilisateurs non premium
    if (!isPremium && recipeCount >= 10) {
      return res.status(403).json({
        result: false,
        message: "Limite atteinte (10 recettes). Passez à la version Premium pour en ajouter davantage.",
        canUpgrade: true,
      });
    }

    // Création de la recette
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
      status: "pending"
    });

    await newRecipe.save();

    return res.json({
      result: true,
      message: "Recette soumise avec succès ! Elle sera visible après validation."
    });

  } catch (err) {
    console.error("Erreur route /submit:", err);
    return res.status(500).json({ result: false, error: err.message });
  }
});


// route pour retrouver toutes les recettes que l utilisateur a proposé 
router.get('/my-recipes', async (req, res) => {
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
  try {
    const allRecipes = await Recipes.find();
    res.json({ result: allRecipes });
  } catch (err) {
    console.error('Erreur /recipesList:', err);
    res.status(500).json({ result: false, error: err.message });
  }
});


// Lister les recettes qui sont en attentes de validation ('pending' en dataBase)
router.get('/mod/pending', checkRole('admin'), async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      Recipes.find({ status: 'pending' })
        .select('_id titre image categorie langue tags ingredients instructions auteur createdAt')
        .sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
      Recipes.countDocuments({ status: 'pending' }),
    ]);
    res.json({ result: true, page: +page, pages: Math.ceil(total / limit), total, items });
  } catch (err) {
    console.error('Erreur /mod/pending:', err);
    res.status(500).json({ result: false, error: err.message });
  }
});

// Approuver
router.post('/mod/:id/approve', checkRole('admin'), async (req, res) => {
  try {
    const r = await Recipes.findByIdAndUpdate(req.params.id, {
      $set: { status: 'approved', reviewedBy: req.user._id, reviewedAt: new Date(), rejectionReason: null }
    }, { new: true });
    if (!r) return res.status(404).json({ result: false, error: 'Not found' });
    res.json({ result: true, recipe: r });
  } catch (err) {
    console.error('Erreur /mod/approve:', err);
    res.status(500).json({ result: false, error: err.message });
  }
});

// Refuser
router.post('/mod/:id/reject', checkRole('admin'), async (req, res) => {
  try {
    const { reason } = req.body;
    const r = await Recipes.findByIdAndUpdate(req.params.id, {
      $set: { status: 'rejected', reviewedBy: req.user._id, reviewedAt: new Date(), rejectionReason: reason || '' }
    }, { new: true });
    if (!r) return res.status(404).json({ result: false, error: 'Not found' });
    res.json({ result: true, recipe: r });
  } catch (err) {
    console.error('Erreur /mod/reject:', err);
    res.status(500).json({ result: false, error: err.message });
  }
});

//route pour supprimer une recette selectionnée par son _id
router.delete('/delete/:idRecipe', checkRole('admin'), async (req, res) => {
  try {
    const recipe = await Recipes.findByIdAndDelete(req.params.idRecipe);

    if (!recipe) {
      return res.status(404).json({ result: false, message: 'Recipe not found' });
    }

    res.json({ result: true, message: 'Recipe deleted' });
  } catch (error) {
    res.status(500).json({ result: false, error: error.message });
  }
});


/* ─────────────────────────────────────────────────────────────────────────────
   RECETTES PERSONNELLES — collection "userrecipes" (séparée du catalogue)
   Stocke les recettes scannées, importées ou saisies manuellement par l'utilisateur.
───────────────────────────────────────────────────────────────────────────── */

// GET /recipe/personal — récupère toutes les recettes personnelles de l'utilisateur
router.get('/personal', async (req, res) => {
  try {
    const recipes = await UserRecipe.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json({ result: true, recipes });
  } catch (err) {
    res.status(500).json({ result: false, error: err.message });
  }
});

// POST /recipe/personal — sauvegarde une recette personnelle (scan, import URL, manuelle)
router.post('/personal', async (req, res) => {
  try {
    const { titre, ingredients, instructions, image, categorie, langue, temps_preparation, portion, source, sourceUrl } = req.body;

    if (!titre || !titre.trim()) {
      return res.status(400).json({ result: false, message: 'Le titre est requis.' });
    }

    const recipe = new UserRecipe({
      userId: req.user._id,
      titre: titre.trim(),
      ingredients: ingredients || [],
      instructions: instructions || [],
      image: image || '',
      categorie: categorie || 'autre',
      langue: langue || 'fr',
      temps_preparation: temps_preparation || null,
      portion: portion || null,
      source: source || 'manual',
      sourceUrl: sourceUrl || '',
    });

    await recipe.save();
    res.json({ result: true, message: 'Recette sauvegardée.', recipe });
  } catch (err) {
    res.status(500).json({ result: false, error: err.message });
  }
});

// PATCH /recipe/personal/:id/image — met à jour uniquement l'image d'une recette personnelle
// PATCH = modification partielle (contrairement à PUT qui remplace tout le document)
// On n'envoie que le champ "image", le reste de la recette est inchangé
router.patch('/personal/:id/image', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ result: false, message: 'URL image manquante.' });

    const recipe = await UserRecipe.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: { image } },
      { new: true }
    );
    if (!recipe) return res.status(404).json({ result: false, message: 'Recette introuvable.' });
    res.json({ result: true, recipe });
  } catch (err) {
    res.status(500).json({ result: false, error: err.message });
  }
});

// DELETE /recipe/personal/:id — supprime une recette personnelle
// Si la recette a une image stockée sur R2 (premium), elle est aussi supprimée de Cloudflare
router.delete('/personal/:id', async (req, res) => {
  try {
    const recipe = await UserRecipe.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!recipe) return res.status(404).json({ result: false, message: 'Recette introuvable.' });

    // Supprime l'image R2 si elle existe (URL contient le domaine R2 public)
    if (recipe.image && process.env.R2_PUBLIC_BASE && recipe.image.includes(process.env.R2_PUBLIC_BASE)) {
      try {
        const key = recipe.image.replace(`${process.env.R2_PUBLIC_BASE}/`, '');
        await deleteFromR2(key);
      } catch (e) {
        console.error('⚠️ Échec suppression image R2 recette:', e.message);
        // On ne bloque pas la suppression de la recette si R2 échoue
      }
    }

    res.json({ result: true, message: 'Recette supprimée.' });
  } catch (err) {
    res.status(500).json({ result: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /recipe/generate — Génération IA d'une recette depuis le stock utilisateur
   Gemini invente une recette originale — aucune copie de source externe.
───────────────────────────────────────────────────────────────────────────── */
router.post('/generate', async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('myproducts');
    if (!user) return res.status(404).json({ result: false, error: 'Utilisateur introuvable.' });

    if (!user.myproducts.length) {
      return res.status(400).json({
        result: false,
        error: 'Votre garde-manger est vide. Ajoutez des produits pour générer une recette.',
      });
    }

    const recipe = await generateRecipeFromStock(user.myproducts);

    // Gemini signale que le stock ne contient pas assez d'aliments valides
    if (recipe.erreur === 'stock_invalide') {
      return res.status(400).json({
        result: false,
        error: 'Votre garde-manger ne contient pas assez d\'aliments reconnus. Ajoutez de vrais produits alimentaires pour générer une recette.',
      });
    }

    res.json({ result: true, recipe });
  } catch (err) {
    console.error('❌ [POST /recipe/generate]', err.message);
    res.status(500).json({ result: false, error: "Erreur lors de la génération de la recette." });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /recipe/scan  — Extraction IA d'une recette depuis une photo (Gemini Vision)
   body: { image: string (base64), mimeType: string }
   Accessible aux utilisateurs connectés uniquement.
───────────────────────────────────────────────────────────────────────────── */
const { extractRecipeFromImage, generateRecipeFromStock } = require('../services/recipeAI');

router.post('/scan', async (req, res) => {
  try {
    const { image, mimeType } = req.body;

    if (!image) {
      return res.status(400).json({ result: false, error: 'Image base64 manquante.' });
    }

    const recipe = await extractRecipeFromImage(image, mimeType || 'image/jpeg');

    // Si Gemini ne reconnaît pas de recette dans l'image
    if (!recipe.titre && recipe.confidence === 0) {
      return res.status(422).json({
        result: false,
        error: "Aucune recette détectée. Essaie avec une image plus nette.",
      });
    }

    res.json({ result: true, recipe });
  } catch (err) {
    console.error('❌ [POST /recipe/scan]', err.message);
    res.status(500).json({ result: false, error: "Erreur lors de l'extraction de la recette." });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /recipe/import-url  — Import d'une recette depuis une URL (Marmiton, 750g…)
   body: { url: string }
   Accessible à tous (optionalAuth).
───────────────────────────────────────────────────────────────────────────── */
const { extractRecipeFromUrl } = require('../services/recipeAI');

router.post('/import-url', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ result: false, error: 'URL manquante.' });
    }

    // Validation basique de l'URL
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ result: false, error: 'URL invalide.' });
    }

    const recipe = await extractRecipeFromUrl(url);

    // Si Gemini ne détecte aucune recette dans la page
    if (!recipe.titre && recipe.confidence === 0) {
      return res.status(422).json({
        result: false,
        error: "Aucune recette détectée sur cette page. Vérifie que l'URL pointe vers une recette.",
      });
    }

    res.json({ result: true, recipe });
  } catch (err) {
    console.error('❌ [POST /recipe/import-url]', err.message);

    // Erreurs réseau (URL inaccessible, timeout…)
    if (err.name === 'AbortError' || err.message?.includes('HTTP')) {
      return res.status(422).json({
        result: false,
        error: "Impossible d'accéder à cette page. Vérifie l'URL ou essaie avec une autre.",
      });
    }

    res.status(500).json({ result: false, error: "Erreur lors de l'import de la recette." });
  }
});

// Récupère une recette du catalogue par son ID.
// Fallback utilisé par la fiche détail quand la recette n'est dans aucun cache
// (favoris retirés, deep link, réinstall de l'app).
router.get('/:id', async (req, res) => {
  try {
    const recipe = await Recipes.findById(req.params.id);
    if (!recipe) return res.status(404).json({ result: false, error: 'Recette introuvable.' });
    res.json(recipe);
  } catch (err) {
    res.status(500).json({ result: false, error: err.message });
  }
});

module.exports = router