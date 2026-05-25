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


/** Email de réinitialisation mot de passe par code OTP */
async function sendPasswordResetOtp({ toEmail, toName = '', code }) {
  const html = `
    <p>Hello${toName ? ' ' + toName : ''},</p>
    <p>You requested to reset your SavePantry password.</p>
    <p>Your reset code:</p>
    <p style="font-size:28px; font-weight:bold; letter-spacing:6px;">${code}</p>
    <p>Valid for 15 minutes. Do not share it.</p>
    <p>If you did not make this request, please ignore this message.</p>
    <p>— The SavePantry Team</p>
  `;
  const text = `Password reset code: ${code}\nValid for 15 minutes.\n— SavePantry`;

  const payload = {
    Messages: [{
      From: { Email: process.env.MAIL_FROM_EMAIL, Name: process.env.MAIL_FROM_NAME || 'SavePantry' },
      To: [{ Email: toEmail, Name: toName }],
      Subject: 'Your password reset code',
      TextPart: text,
      HTMLPart: html,
    }],
  };
  const res = await mj.post('send', { version: 'v3.1' }).request(payload);
  const msg = res.body?.Messages?.[0];
  if (!msg || msg.Status !== 'success') throw new Error('Mailjet send failed');
}

module.exports = { sendEmailOtp, sendPasswordResetOtp };
