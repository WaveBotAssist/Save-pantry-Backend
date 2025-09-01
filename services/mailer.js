// services/mailer.js
const mailjet = require('node-mailjet');

const mj = mailjet.apiConnect(process.env.MJ_API_KEY, process.env.MJ_API_SECRET);

//Fonction pour la confirmation de l inscription par email pour créé le message
async function sendEmailOtp({ toEmail, toName = '', code }) {
  const html = `
  <p>Hello${toName ? ' ' + toName : ''},</p>
<p>Here is your verification code:</p>
<p style="font-size:22px;"><b>${code}</b></p>
<p>Valid for 10 minutes. Do not share it.</p>
<p> If you closed the app, you can go back to the signup screen and tap <b>"Already have a code?"</b> to enter it directly.</p>
<p>— The SavePantry Team</p>
  `;
  const text = `Verification code: ${code}\nValid for 10 minutes.\n— SavePantry`;

  const payload = {
    Messages: [{
      From: { Email: process.env.MAIL_FROM_EMAIL, Name: process.env.MAIL_FROM_NAME || 'SavePantry' },
      To: [{ Email: toEmail, Name: toName }],
      Subject: 'Your verification code',
      TextPart: text,
      HTMLPart: html,
    }],
  };
  // Appel HTTPS à l’API Mailjet (v3.1)
  const res = await mj.post('send', { version: 'v3.1' }).request(payload);
  const msg = res.body?.Messages?.[0];
  if (!msg || msg.Status !== 'success') throw new Error('Mailjet send failed');
}


//fonction pour modifier son mot de passe perdu et créé le message de l email
function buildResetEmail({ toName, resetUrl }) {
  const html = `
    <p>Hello${toName ? ' ' + toName : ''},</p>
    <p>You requested to reset your password.</p>
    <p><a href="${resetUrl}">Click here to reset it</a> (valid for 30 minutes).</p>
    <p>If you did not make this request, please ignore this message.</p>
    <p>— The SavePantry Team</p>
  `;
  const text = [
    `Hello${toName ? ' ' + toName : ''},`,
    `You requested to reset your password.`,
    `Link: ${resetUrl}`,
    `The link expires in 30 minutes.`,
    `If you did not make this request, please ignore this message.`,
    `— The SavePantry Team`,
  ].join('\n');
  return { html, text };
}

async function sendPasswordResetEmail({ toEmail, toName = '', resetUrl }) {
  const { html, text } = buildResetEmail({ toName, resetUrl });

  const payload = {
    Messages: [{
      From: { Email: process.env.MAIL_FROM_EMAIL, Name: process.env.MAIL_FROM_NAME },
      To: [{ Email: toEmail, Name: toName }],
      Subject: 'Password Reset',
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

module.exports = { sendPasswordResetEmail, sendEmailOtp };
