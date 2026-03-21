const mongoose = require('mongoose');

const productSchema = mongoose.Schema({
    id: String,
    name: {type: String, required: true},
    magasin: String,
    categorie: String,
    prix: String,
    unit: String,
    image: String,
    calorie: String,
    codebarre: String,
    nutriments: { type: Object, default: null }, // Données nutritionnelles OpenFoodFacts (pour 100g)
  },{timeStamps: true});

const Product = mongoose.model('Product', productSchema);
module.exports = Product;
