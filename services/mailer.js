// services/mailer.js

const mailjet = require('node-mailjet');

const mj = mailjet.apiConnect(process.env.MJ_API_KEY, process.env.MJ_API_SECRET);

function buildResetEmail({ toName, resetUrl }) {
  const html = `
    <p>Bonjour${toName ? ' ' + toName : ''},</p>
    <p>Tu as demandé à réinitialiser ton mot de passe.</p>
    <p><a href="${resetUrl}">Clique ici pour le réinitialiser</a> (valable 30 minutes).</p>
    <p>Si tu n'es pas à l'origine de cette demande, ignore ce message.</p>
    <p>— L’équipe SavePantry</p>
  `;
  const text = [
    `Bonjour${toName ? ' ' + toName : ''},`,
    `Tu as demandé à réinitialiser ton mot de passe.`,
    `Lien : ${resetUrl}`,
    `Le lien expire dans 30 minutes.`,
    `Si tu n'es pas à l'origine de cette demande, ignore ce message.`,
    `— L’équipe SavePantry`,
  ].join('\n');
  return { html, text };
}

async function sendPasswordResetEmail({ toEmail, toName = '', resetUrl }) {
  const { html, text } = buildResetEmail({ toName, resetUrl });

  const payload = {
    Messages: [{
      From: { Email: process.env.MAIL_FROM_EMAIL, Name: process.env.MAIL_FROM_NAME },
      To: [{ Email: toEmail, Name: toName }],
      Subject: 'Réinitialisation de mot de passe',
      TextPart: text,
      HTMLPart: html,
      // Headers optionnels :
      // Headers: { 'Reply-To': 'support@tondomaine.com' },
    }],
  };

  // Appel HTTPS à l’API Mailjet (v3.1)
  const res = await mj.post('send', { version: 'v3.1' }).request(payload);
  const msg = res.body?.Messages?.[0];
  if (!msg || msg.Status !== 'success') {
    throw new Error('Mailjet API: send failed');
  }
  return msg;
}

module.exports = { sendPasswordResetEmail };
