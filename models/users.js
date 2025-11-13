const mongoose = require('mongoose')
const crypto = require('crypto');

const myproductsSchema = mongoose.Schema({
    id: String,
    codebarre: { type: String, immutable: true },
    image: String,
    name: { type: String, required: true },
    magasin: String,
    categorie: String,
    expiration: Date,
    notifiedExpired: { type: Boolean, default: false },// ajouter pour marquer comme expired
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
    password: { type: String, required: true, select: false },
    revenuecatId: { type: String, unique: true },// identifiant unique pour RevenueCat
    isPremium: { type: Boolean, default: false },// statut premium
    notificationsEnabled: Boolean,
    tokenpush: String,
    //ajout du choix de la langue de l utilisateur
    language: { type: String, enum: ['fr', 'en'], default: 'fr' },
    // role de l'utilisateur
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    myproducts: [myproductsSchema],
    notificationSettings: {
        expiry: {
            enabled: { type: Boolean, default: true },
            hour: { type: Number, default: 9 },
            timezone: { type: String, default: 'Europe/Brussels' } // ajouté pour l heure locale de l utilisateur
        },
        share: {
            enabled: { type: Boolean, default: true },
        },
    },
    // Ajout de la liste des recettes favorites
    favorites: [{ type: mongoose.Schema.Types.ObjectId, ref: 'recipes' }]

}, { timestamps: true }) // 👈 ajoute createdAt et updatedAt automatiquement


// 🪄 Hook : avant de sauvegarder, générer un revenuecatId si absent. 
// Utilise un hash SHA-256 de l'email.
userSchema.pre("save", function (next) {
    // Si revenuecatId déjà défini, ne rien faire
    if (this.revenuecatId) return next();

    // Ne rien faire si email absent
    if (!this.email) return next();

    // Génère le hash uniquement si email présent
    this.revenuecatId = crypto
        .createHash("sha256")
        .update(this.email)
        .digest("hex");

    next();
});

const User = mongoose.model('users', userSchema);

module.exports = User