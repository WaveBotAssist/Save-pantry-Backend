// models/Planning.js
const mongoose = require('mongoose');

const daySchema = new mongoose.Schema({
  recipe: { type: Object, default: null }, // recette planifiée (id + titre + image + ingrédients…)
  stockItems: { type: Array, default: [] }, // produits planifiés
  consumed: { type: Boolean, default: false } // ✅ état de consommation de la journée
});

const weekSchema = new mongoose.Schema({
  weekStart: String, // ex: "2025-09-15"
  days: { type: Map, of: daySchema }
});

const planningSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  weeks: [weekSchema]
}, 
{ timestamps: true, 
  optimisticConcurrency: false   // 🚀 désactive la vérif de version __v
});

module.exports = mongoose.model("Planning", planningSchema);