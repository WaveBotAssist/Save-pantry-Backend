// middlewares/optionalAuth.js
const checkToken = require('./checkToken');

/**
 * optionalAuth : middleware d'authentification optionnel.
 * - Si un header Authorization est présent → on valide le token via checkToken.
 * - Si aucun token → on laisse passer sans authentification (req.user = null).
 *
 * Utilisé pour les routes accessibles en mode anonyme (ex: lecture des recettes).
 */
module.exports = async function optionalAuth(req, res, next) {
  const auth = req.headers.authorization;

  // Pas de token → mode anonyme, on continue sans utilisateur
  if (!auth || !auth.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  // Token présent → on délègue à checkToken qui gère la validation complète
  return checkToken(req, res, next);
};
