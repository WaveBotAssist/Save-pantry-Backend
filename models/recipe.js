const mongoose = require('mongoose');

const recipesSchema = mongoose.Schema({
    id: Number,
    titre: String,
    categorie: String,
    langue: String,
    source: String,
    url: String,
    image: String,
    tags: [String],
    ingredients: [String],
    instructions: [String],
    temps_preparation: Number,
    portion: Number,
    difficulte: String,
    auteur: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
    status: { type: String, default: "pending" },
})

const Recipes = mongoose.model('recipes',recipesSchema);

module.exports = Recipes;