const mongoose = require('mongoose')

const myproductsSchema = mongoose.Schema({
    id: String,
    codebarre: { type: String, immutable: true },
    image: String,
    name: { type: String, required: true },
    magasin: String,
    categorie: String,
    expiration: Date,
    emplacement: String,
    quantite: Number,
    prix: String,
    currency: String,
    unit: String,
    calorie: String,
    updatedAt: { type: Date, default: Date.now } // Date de la dernière mise à jour
})


const userSchema = mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },// ajout de lowercase et trim a true pour forcer l email en minuscule en bdd
    emailVerified: { type: Boolean, default: false }, // status de vérification
    password: String,
    notificationsEnabled: Boolean,
    tokenpush: String,
    //ajout du choix de la langue de l utilisateur
    language: {
        type: String,
        enum: ['fr', 'en'], // pour éviter les erreurs
        default: 'fr'
    },
    // role de l'utilisateur
    role: { type: String, enum: ['user', 'admin'], default: 'user' },

    myproducts: [myproductsSchema],
    notificationSettings: {
        expiry: {
            enabled: { type: Boolean, default: true },
            hour: { type: Number, default: 9 },
            timezone: { type: String, default: 'Europe/Brussels' } 
        },
        share: {
            enabled: { type: Boolean, default: true },
        },
    },
    // Ajout de la liste des recettes favorites
    favorites: [{ type: mongoose.Schema.Types.ObjectId, ref: 'recipes' }]
    
}, { timestamps: true }) // 👈 ajoute createdAt et updatedAt automatiquement


const User = mongoose.model('users', userSchema);

module.exports = User