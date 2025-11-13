// 🔹 Import des modules nécessaires
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
// Librairie sharp pour l’optimisation d’images
const sharp = require('sharp');

// 🔹 Configuration du client S3 pour Cloudflare R2
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// 🔹 Fonction d’upload d’image optimisée vers Cloudflare R2
async function uploadToR2(fileBuffer, originalName, folder = 'images') {
  if (!fileBuffer) throw new Error('Aucun fichier à uploader');

  // 1️⃣ Nom unique (key) pour l’image
  const key = `${folder}/${Date.now()}_${originalName.replace(/\s+/g, '_')}`;

  // 2️⃣ Optimisation avec sharp
  const optimizedImage = await sharp(fileBuffer)
    .rotate()
    .resize({ width: 600 })
    .jpeg({ quality: 75 })
    .toBuffer();

  // 3️⃣ Envoi vers R2
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: optimizedImage,
    ContentType: 'image/jpeg',
  });
  await s3.send(command);

  // 4️⃣ URL publique
  const url = `${process.env.R2_PUBLIC_BASE}/${key}`;

  return { url, key };
}

// 🔹 Fonction de suppression d’image
async function deleteFromR2(key) {
  if (!key) throw new Error('Clé d’image manquante');
  const command = new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: decodeURIComponent(key),
  });
  await s3.send(command);
  return true;
}

module.exports = { uploadToR2, deleteFromR2 };