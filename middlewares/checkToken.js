const bcrypt = require('bcrypt');
const crypto = require('crypto');
const Session = require('../models/session');
const User = require('../models/users');
const NodeCache = require('node-cache'); // Cache léger en RAM pour éviter surcharge MongoDB

// Fonction utilitaire : crée un hash SHA256 pour fingerprint du token
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// 🗄️ Cache en mémoire : conserve la valeur premium pendant 10 minutes
// stdTTL = durée du cache ; checkperiod = fréquence d'expiration
const premiumCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

module.exports = async function checkToken(req, res, next) {
  try {
    // ---------------------------------------------------------
    // 1️⃣ RÉCUPÉRATION DU TOKEN
    // ---------------------------------------------------------
    const auth = req.headers.authorization || '';
    const raw = auth.startsWith('Bearer ') ? auth.slice(7) : null;

    if (!raw) {
      return res.status(401).json({ error: 'No token' });
    }

    // ---------------------------------------------------------
    // 2️⃣ RECHERCHE DE LA SESSION LIÉE AU TOKEN
    // On ne stocke JAMAIS le token "en clair" → on compare son fingerprint
    // ---------------------------------------------------------
    const session = await Session.findOne({
      tokenFingerprint: sha256(raw),              // empreinte du token
      expiresAt: { $gt: new Date() },             // session non expirée
      $or: [{ revokedAt: { $exists: false } }, { revokedAt: null }] // non révoquée
    }).select('userId tokenHash expiresAt');

    // Aucun résultat = session inexistante / supprimée / révoquée
    if (!session) {
      return res.status(401).json({
        result: false,
        code: 'SESSION_REVOKED',
        message: 'Session révoquée.',
      });
    }

    // ---------------------------------------------------------
    // 3️⃣ GESTION DE LA SESSION EXPIREE (natural expiration)
    // ---------------------------------------------------------
    if (session.expiresAt < new Date()) {
      await Session.deleteOne({ _id: session._id }); // Nettoyage automatique
      return res.status(401).json({
        result: false,
        code: 'SESSION_EXPIRED',
        message: 'Session expirée.',
      });
    }

    // ---------------------------------------------------------
    // 4️⃣ VERIFICATION DU TOKEN VIA COMPARAISON BCRYPT
    // On compare le token BRUT envoyé → au hash stocké en base
    // ---------------------------------------------------------
    const ok = await bcrypt.compare(raw, session.tokenHash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // ---------------------------------------------------------
    // 5️⃣ RÉCUPÉRATION DES DONNÉES UTILISATEUR
    // On charge seulement les champs nécessaires → sécurité
    // ---------------------------------------------------------
    const user = await User.findById(session.userId)
      .select('_id role isPremium revenuecatId');

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // ---------------------------------------------------------
    // 6️⃣ OPTIMISATION BDD : CACHE PREMIUM
    // Objectif : éviter un accès BDD à chaque requête
    //
    // Si la valeur premium est en cache → on l'utilise
    // Sinon → on la stocke dans le cache pour 10 minutes
    // ---------------------------------------------------------
    const cachedPremium = premiumCache.get(user._id.toString());

    if (cachedPremium !== undefined) {
      // On utilise la valeur premium du cache
      user.isPremium = cachedPremium;
    } else {
      // On stocke la valeur dans le cache
      premiumCache.set(user._id.toString(), user.isPremium);
    }

    // ---------------------------------------------------------
    // 7️⃣ RENOUVELLEMENT AUTO DE LA SESSION (sliding expiration)
    // Ce mécanisme garde l'utilisateur connecté tant qu'il utilise l'app
    // (comme Google, Facebook, Spotify…)
    // ---------------------------------------------------------
    session.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // +7 jours
    await session.save();

    // ---------------------------------------------------------
    // 8️⃣ GESTION DES SESSIONS MULTIPLES POUR NON-PREMIUM
    // Premium = connexions multi-appareils autorisées
    // Non premium = 1 seul appareil à la fois
    // ---------------------------------------------------------
    if (!user.isPremium) {
      const activeSessions = await Session.find({
        userId: user._id,
        revokedAt: null,
        expiresAt: { $gt: new Date() }
      });

      // Si plus d’une session active → on supprime toutes les autres
      if (activeSessions.length > 1) {
        await Session.deleteMany({
          userId: user._id,
          _id: { $ne: session._id }, // on garde UNIQUEMENT la session actuelle
        });

        console.log(`🧹 Sessions multiples supprimées pour user ${user._id}`);
      }
    }

    // ---------------------------------------------------------
    // 9️⃣ INJECTION DES INFOS POUR LES ROUTES PROTEGÉES
    // ---------------------------------------------------------
    req.user = user;         // les routes savent qui est connecté
    req.sessionId = session._id; // permet logout, revoke, etc.

    // On passe au middleware suivant ou à la route
    next();

  } catch (error) {
    // ---------------------------------------------------------
    // 🔟 GESTION DES ERREURS GLOBALES
    // ---------------------------------------------------------
    console.error('❌ Erreur checkToken:', error);
    res.status(401).json({ error: 'Auth error' });
  }
};
