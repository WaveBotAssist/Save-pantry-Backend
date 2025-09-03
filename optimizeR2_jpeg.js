require("dotenv").config();
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
const sharp = require("sharp");

// ⚙️ Config Cloudflare R2
const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET;
const PREFIX = ""; // dossier si besoin
const BACKUP_PREFIX = "backup/"; // sauvegarde des originaux

// Convertir un stream en buffer (nécessaire avec v3)
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function listImages() {
  const { Contents } = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX })
  );
  return Contents.map((obj) => obj.Key);
}

async function optimizeAndOverwrite(key) {
  try {
    // 1. Télécharger l'image originale
    const { Body, ContentType } = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key })
    );
    const buffer = await streamToBuffer(Body);

    // 2. Sauvegarde dans backup/
    const backupKey = BACKUP_PREFIX + key;
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: backupKey,
        Body: buffer,
        ContentType: ContentType || "image/jpeg",
      })
    );
    console.log(`📦 Backup créé : ${backupKey}`);

    // 3. Optimiser avec Sharp
    const optimized = await sharp(buffer)
      .resize({ width: 800 }) // largeur max 800px
      .jpeg({ quality: 75 }) // compression JPEG
      .toBuffer();

    // 4. Ré-uploader (écrasement)
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: optimized,
        ContentType: "image/jpeg",
      })
    );

    console.log(`✅ Optimisé et remplacé : ${key}`);
  } catch (err) {
    console.error(`❌ Erreur sur ${key}:`, err.message);
  }
}

(async () => {
  const images = await listImages();
  console.log(`Trouvé ${images.length} images à optimiser...`);

  for (const key of images) {
    await optimizeAndOverwrite(key);
  }

  console.log("🎉 Optimisation terminée avec backup !");
})();
