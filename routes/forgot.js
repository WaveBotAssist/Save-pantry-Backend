const express = require('express');
const nodemailer = require('nodemailer');
const User = require('../models/users');
const bcrypt = require('bcrypt');

const router = express.Router();
const serveurIP = process.env.EXPO_PUBLIC_SERVEUR_IP;
const email = process.env.EMAIL_USER;
const password = process.env.EMAIL_PASS
// Route pour envoyer un email de réinitialisation
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ success: false, message: "Aucun compte associé à cet email." });
    }

    // Lien de réinitialisation (sans expiration)
    const resetLink = `http://${serveurIP}/reset-password?email=${email}`;

    // Configuration du transporteur d'email
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: 'savepantry@outlook.com',
        pass: 'Irgpt8048!',
      }
    });

    // Envoyer l'email
    await transporter.sendMail({
      from: 'savepantry@outlook.com',
      to: email,
      subject: "Réinitialisation de votre mot de passe",
      text: `Cliquez sur ce lien pour réinitialiser votre mot de passe : ${resetLink}`
    });

    res.json({ success: true, message: "Email envoyé avec succès." });

  } catch (error) {
    res.status(500).json({ success: false, message: "Erreur serveur.", error });
  }
});

//  Route pour réinitialiser le mot de passe
router.post('/reset-password', async (req, res) => {
    const { email, newPassword } = req.body;
  
    try {
      const user = await User.findOne({ email });
      if (!user) {
        return res.status(404).json({ success: false, message: "Utilisateur non trouvé." });
      }
  
      // Hachage du nouveau mot de passe
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      user.password = hashedPassword;
      await user.save();
  
      res.json({ success: true, message: "Mot de passe mis à jour avec succès." });
  
    } catch (error) {
      res.status(500).json({ success: false, message: "Erreur serveur.", error });
    }
  });
  
module.exports = router;