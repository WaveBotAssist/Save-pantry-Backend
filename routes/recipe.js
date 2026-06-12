const express = require('express')
const router = express.Router()
const checkToken = require('../middlewares/checkToken');
const checkRole = require('../middlewares/checkRole');
const User = require('../models/users');
const Recipes = require('../models/recipe');
const UserRecipe = require('../models/userRecipe');
const { uploadToR2, deleteFromR2 } = require('../services/R2cloudflare');
const { calculerCompatibilite } = require('../services/compatibilityService');
const multer = require('multer');
const { checkPremiumStatus } = require('../middlewares/checkPremium');
const aiCredits = require('../middlewares/aiCredits');


// Multer pour lire le fichier en RAM (pas sur disque)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5 Mo max
});


//ci-dessous les deux routes pour upload ou remove une image de R2 cloudflare
// ---- UPLOAD ROUTE ----
router.post('/r2/upload', checkToken, upload.single('file'), async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const isPremium = await checkPremiumStatus(user);
    if (!isPremium) {
      return res.status(403).json({ success: false, error: 'Compte non premium - upload R2 desactive.' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Aucun fichier envoye' });
    }
    const { url, key } = await uploadToR2(req.file.buffer, req.file.originalname, 'recipes-users');
    res.json({ success: true, url, key });
  } catch (err) {
    console.error('Erreur upload R2 recette:', err);
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


/**
 * Mélange Fisher-Yates — utilisé pour varier la sélection des recettes
 * "Découvrir" qui n'ont aucun ingrédient du garde-manger, à chaque chargement.
 */
function melanger(tableau) {
  const copie = [...tableau];
  for (let i = copie.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copie[i], copie[j]] = [copie[j], copie[i]];
  }
  return copie;
}

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

    // 🔍 Produits du garde-manger — vide en mode anonyme (req.user = null)
    let myproducts = [];

    if (req.user) {
      const user = await User.findOne({ _id: req.user._id }, { myproducts: 1 });
      if (!user)
        return res.status(404).json({ result: false, error: "Utilisateur introuvable" });

      myproducts = user.myproducts;
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


    const recettesFiltrees = recettes.map(recette => {
      const { ingredientsManquants, pourcentageCompatibilite, score } =
        calculerCompatibilite(recette, myproducts);
      return {
        ...recette.toObject(),
        id: recette._id.toString(),
        ingredientsManquants,
        score,
        pourcentageCompatibilite,
      };
    })
      // 3) On filtre par nombre max d'ingrédients manquants
      .filter(r => r.ingredientsManquants.length <= maxManquants)
      // 4) Filtre par catégorie (facultatif)
      .filter(r => !categorie || r.categorie.toLowerCase() === categorie.toLowerCase())
      // 5) Filtre par temps de préparation (facultatif)
      .filter(r => !maxTemps || r.temps_preparation === maxTemps)

    // 6) Tri : les recettes ayant au moins un ingrédient du garde-manger passent
    // toujours en premier (triées par compatibilité décroissante). Les recettes
    // sans aucune correspondance sont mélangées aléatoirement, pour varier la
    // sélection proposée dans "Découvrir" à chaque chargement (utile en mode
    // anonyme / garde-manger vide, où la plupart des recettes sont à 0%).
    const recettesAvecStock = recettesFiltrees
      .filter(r => r.pourcentageCompatibilite > 0)
      .sort((a, b) => b.pourcentageCompatibilite - a.pourcentageCompatibilite);
    const recettesSansStock = melanger(recettesFiltrees.filter(r => r.pourcentageCompatibilite === 0));

    const recettesCompatibles = [...recettesAvecStock, ...recettesSansStock];


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
    if (!titre || !titre.trim() || !categorie || !Array.isArray(ingredients) || !ingredients.length ||
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

    const imageUrl = image || '';

    // Création de la recette
    const newRecipe = new Recipes({
      titre,
      categorie,
      langue,
      source: source || "user",
      url: url || "",
      image: imageUrl,
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

    const imageUrl = image || '';
    
    const recipe = new UserRecipe({
      userId: req.user._id,
      titre: titre.trim(),
      ingredients: ingredients || [],
      instructions: instructions || [],
      image: imageUrl,
      categorie: categorie || 'autre',
      langue: langue || 'fr',
      temps_preparation: temps_preparation || null,
      portion: portion || null,
      source: source || 'manual',
      sourceUrl: sourceUrl || '',
    });
    await recipe.save();
    const io = req.app.get('io');
    io.to(`user-${req.user._id}`).emit('recipes-updated');
    res.json({ result: true, message: 'Recette sauvegardée.', recipe });
  } catch (err) {
    res.status(500).json({ result: false, error: err.message });
  }
});

// PATCH /recipe/personal/:id/category — met à jour uniquement la catégorie d'une recette personnelle
router.patch('/personal/:id/category', async (req, res) => {
  try {
    const { categorie } = req.body;
    if (!categorie) return res.status(400).json({ result: false, message: 'Catégorie manquante.' });
    const recipe = await UserRecipe.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: { categorie } },
      { new: true }
    );
    if (!recipe) return res.status(404).json({ result: false, message: 'Recette introuvable.' });
    const io = req.app.get('io');
    io.to(`user-${req.user._id}`).emit('recipes-updated');
    res.json({ result: true, recipe });
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

    // { new: false } retourne l'ancienne version pour pouvoir supprimer l'ancienne image R2
    const oldRecipe = await UserRecipe.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: { image } },
      { new: false }
    );
    if (!oldRecipe) return res.status(404).json({ result: false, message: 'Recette introuvable.' });

    // Supprime l'ancienne image R2 si elle est différente de la nouvelle
    if (
      oldRecipe.image &&
      process.env.R2_PUBLIC_BASE &&
      oldRecipe.image.includes(process.env.R2_PUBLIC_BASE) &&
      oldRecipe.image !== image
    ) {
      try {
        const oldKey = oldRecipe.image.replace(`${process.env.R2_PUBLIC_BASE}/`, '');
        await deleteFromR2(oldKey);
      } catch (e) {
        console.error('⚠️ Échec suppression ancienne image R2 recette:', e.message);
      }
    }

    const io = req.app.get('io');
    io.to(`user-${req.user._id}`).emit('recipes-updated');
    res.json({ result: true, recipe: { ...oldRecipe.toObject(), image } });
  } catch (err) {
    res.status(500).json({ result: false, error: err.message });
  }
});

/**
 * POST /recipe/personal/import
 * ─────────────────────────────────────────────────────────────────────────────
 * Import groupé de recettes — utilisé exclusivement par migrateLocalData()
 * lors de la transition anonyme → compte connecté.
 *
 * Utilise UserRecipe.insertMany() avec { ordered: false } pour insérer toutes
 * les recettes en une seule opération MongoDB, sans bloquer sur les doublons.
 * Les recettes dont le titre existe déjà sont filtrées avant l'insert.
 *
 * Body :
 *   recipes  {Array}  Liste de recettes à importer (format LocalRecipe sans _id)
 * ─────────────────────────────────────────────────────────────────────────────
 */
router.post('/personal/import', async (req, res) => {
  try {
    const { recipes } = req.body;
    if (!Array.isArray(recipes) || recipes.length === 0) {
      return res.status(400).json({ result: false, message: 'Tableau de recettes requis.' });
    }

    const existing = await UserRecipe.find({ userId: req.user._id }).select('titre');
    const existingTitles = new Set(existing.map(r => r.titre.trim().toLowerCase()));

    const toInsert = recipes
      .filter(r => r.titre && r.titre.trim() && !existingTitles.has(r.titre.trim().toLowerCase()))
      .map(({ titre, ingredients, instructions, image, categorie, langue, temps_preparation, portion, source, sourceUrl }) => ({
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
      }));

    if (toInsert.length > 0) {
      await UserRecipe.insertMany(toInsert, { ordered: false });
      const io = req.app.get('io');
      io.to(`user-${req.user._id}`).emit('recipes-updated');
    }

    return res.json({ result: true, added: toInsert.length });
  } catch (err) {
    console.error('❌ Erreur personal/bulk:', err);
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

    const io = req.app.get('io');
    io.to(`user-${req.user._id}`).emit('recipes-updated');
    res.json({ result: true, message: 'Recette supprimée.' });
  } catch (err) {
    res.status(500).json({ result: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /recipe/generate — Génération IA d'une recette depuis le stock utilisateur
   Gemini invente une recette originale — aucune copie de source externe.
───────────────────────────────────────────────────────────────────────────── */
router.post('/generate', aiCredits, async (req, res) => {
    try {
      let products;

      if (req.user) {
        // Utilisateur connecté → on lit son garde-manger depuis la BDD
        const user = await User.findById(req.user._id).select('myproducts');
        if (!user) return res.status(404).json({result: false, error: 'Utilisateur introuvable.' });
        products = user.myproducts;
      } else {
        // Utilisateur anonyme → les produits sont envoyés dans le body
        products = req.body.products ?? [];
      }

      if (!products.length) {
        return res.status(400).json({
          result: false,
          error: 'Votre garde-manger est vide. Ajoutez des produits pour générer une recette.',
        });
      }

       const lang = (req.headers['accept-language'] ?? 'fr').slice(0, 2);
      const recipe = await generateRecipeFromStock(products, lang);

      // Le client peut avoir fermé la connexion pendant l'appel Gemini (timeout mobile)
      if (res.headersSent || req.socket?.destroyed) return;

      if (recipe.erreur === 'stock_invalide') {
        return res.status(400).json({
          result: false,
          error: 'Votre garde-manger ne contient pas assez d\'aliments reconnus.',
        });
      }

      await req.consumeCredit?.();
      res.json({ result: true, recipe, creditConsumed: true });
    } catch (err) {
      console.error('❌ [POST/recipe/generate]', err.message);
      if (!res.headersSent) {
        res.status(500).json({ result: false, error: "Erreur lors de la génération de la recette." });
      }
    }
  });

/* ─────────────────────────────────────────────────────────────────────────────
   POST /recipe/scan  — Extraction IA d'une recette depuis une photo (Gemini Vision)
   body: { image: string (base64), mimeType: string }
   Accessible aux utilisateurs connectés uniquement.
───────────────────────────────────────────────────────────────────────────── */
const { extractRecipeFromImage, generateRecipeFromStock } = require('../services/recipeAI');

router.post('/scan', aiCredits, async (req, res) => {
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

    await req.consumeCredit?.();
    res.json({ result: true, recipe, creditConsumed: true });
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
const { extractRecipeFromUrl, extractRecipeFromHtml } = require('../services/recipeUrlImport');

router.post('/import-url', async (req, res) => {
  try {
    const { url, html } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ result: false, error: 'URL manquante.' });
    }

    try {
      new URL(url);
    } catch {
      return res.status(400).json({ result: false, error: 'URL invalide.' });
    }

    // html fourni par le frontend (fetch depuis l'appareil) → pas de fetch serveur
    // url seul → le backend fetch lui-même (fallback)
    const recipe = html
      ? extractRecipeFromHtml(html)
      : await extractRecipeFromUrl(url);
   
    if (!recipe) {
      return res.status(422).json({
        result: false,
        error: "Aucune recette structurée détectée sur cette page. Le site doit utiliser le format Schema.org/Recipe.",
      });
    }

    // Extraction JSON-LD uniquement — aucun crédit consommé
    res.json({ result: true, recipe, creditConsumed: false });
  } catch (err) {
    console.error('❌ [POST /recipe/import-url]', err.message);

    // Timeout du fetch (AbortController déclenché après 10s)
    if (err.name === 'AbortError') {
      return res.status(422).json({
        result: false,
        error: "La page a mis trop de temps à répondre. Essaie avec une autre URL.",
      });
    }

    // Site inaccessible (HTTP 4xx/5xx, DNS, SSL...)
    if (
      err.message?.includes('HTTP') ||
      err.message?.includes('ENOTFOUND') ||
      err.message?.includes('ECONNREFUSED') ||
      err.message?.includes('certificate') ||
      err.code === 'ENOTFOUND' ||
      err.code === 'ECONNREFUSED'
    ) {
      return res.status(422).json({
        result: false,
        error: "Impossible d'accéder à cette page. Vérifie l'URL ou essaie avec une autre.",
      });
    }

    res.status(500).json({ result: false, error: "Erreur lors de l'import. Réessaie dans quelques secondes." });
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


// ─── Partage de recette ───────────────────────────────────────────────────────

// POST /recipe/share
// Reçoit { sourceUrl } — crée un lien court et le retourne.
// Pas de checkToken : optionalAuth sur la route parente suffit (anonymes inclus).
const rateLimit = require('express-rate-limit');
const shareLimiter = rateLimit({
  windowMs: 60 * 1000, // fenetre de 1 minute
  max: 10,             // max 10 liens par minute par IP
  message: { result: false, message: 'Trop de demandes, réessayez dans une minute.' },
});
router.post('/share', shareLimiter, async (req, res) => {
  try {
    const { sourceUrl } = req.body;

    // Étape 1 — vérifier que sourceUrl est fourni
    if (!sourceUrl) {
      return res.status(400).json({ result: false, message: 'sourceUrl requis.' });
    }

    // Étape 2 — vérifier que c'est bien une URL https valide
    // On refuse tout ce qui n'est pas https:// pour bloquer les URLs javascript:,
    // data:, ou les adresses de réseau interne (http://192.168.x.x...)
    try {
      const parsed = new URL(sourceUrl);
      if (parsed.protocol !== 'https:') throw new Error();
    } catch {
      return res.status(400).json({ result: false, message: 'URL invalide.' });
    }

    // Étape 3 — réutiliser le lien existant si cette URL a déjà été partagée
    const uid2 = require('uid2');
    const SharedRecipe = require('../models/sharedRecipe');
    let entry = await SharedRecipe.findOne({ sourceUrl });
    if (!entry) {
      entry = await SharedRecipe.create({ code: uid2(8), sourceUrl });
    }

    // Étape 4 — retourner l'URL de partage complète
    // NODE_ENV = "production" est défini automatiquement par l'hébergeur (Railway, Render...)
    const base = process.env.NODE_ENV === 'production'
      ? 'https://savepantry.org'
      : 'http://192.168.1.56:3000';
    res.json({ result: true, shareUrl: `${base}/s/${entry.code}` });

  } catch (err) {
    res.status(500).json({ result: false, error: err.message });
  }
});

module.exports = router