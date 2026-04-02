/**
 * scannerQuota.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Modèle Mongoose pour tracker le quota de scans de ticket de caisse.
 *
 * Ce modèle fonctionne pour TOUS les utilisateurs (anonymes et inscrits)
 * via un identifiant d'appareil unique (deviceId) généré côté frontend
 * et stocké dans expo-secure-store (survit au clear du cache).
 *
 * Logique :
 *   - 1 document par appareil
 *   - scanCount est incrémenté après chaque scan réussi
 *   - Les utilisateurs premium bypassen entièrement cette vérification
 *   - FREE_SCAN_LIMIT (défini dans la route) = nombre de scans gratuits autorisés
 * ─────────────────────────────────────────────────────────────────────────────
 */

const mongoose = require('mongoose');

const scannerQuotaSchema = new mongoose.Schema(
  {
    /**
     * Identifiant unique de l'appareil (UUID v4).
     * Utilisé comme clé de quota pour les utilisateurs anonymes.
     * Optionnel pour les utilisateurs connectés (le quota est alors lié au compte).
     */
    deviceId: {
      type: String,
      default: null,
      sparse: true, // index sparse : plusieurs documents peuvent avoir deviceId=null
      index: true,
    },

    /**
     * Identifiant du compte utilisateur (ObjectId MongoDB sous forme de string).
     * Utilisé comme clé de quota pour les utilisateurs connectés.
     * Null pour les utilisateurs anonymes.
     */
    userId: {
      type: String,
      default: null,
      sparse: true, // index sparse : plusieurs documents peuvent avoir userId=null
      index: true,
    },

    /**
     * Nombre de scans de ticket de caisse effectués.
     * Incrémenté par la route POST /scanner/scan-receipt après chaque scan réussi.
     */
    scanCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    /**
     * timestamps: true ajoute automatiquement createdAt et updatedAt.
     * updatedAt permet de purger les anciens documents via un cron job si besoin.
     */
    timestamps: true,
  }
);

const ScannerQuota = mongoose.model('ScannerQuota', scannerQuotaSchema);

module.exports = ScannerQuota;
