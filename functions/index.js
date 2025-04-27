/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

// Remove unused imports
// const {onRequest} = require("firebase-functions/v2/https");
// const logger = require("firebase-functions/logger");
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios"); // Import axios for HTTP requests
const path = require("path");
const os = require("os");
const fs = require("fs");

admin.initializeApp();
// Remove unused db variable
// const db = admin.firestore();
const storage = admin.storage(); // Initialize storage

// Get Telegram Bot Token from Firebase environment configuration
// Run this command in your terminal BEFORE deploying:
// firebase functions:config:set telegram.token="YOUR_BOT_TOKEN"
let botToken;
try {
  botToken = functions.config().telegram.token;
} catch (error) {
  // Reformat long line
  console.error(
      "Telegram token not set in Firebase config. Run: " +
      "firebase functions:config:set telegram.token=\"YOUR_BOT_TOKEN\"",
  );
}

// Only initialize bot if token is available
let bot;
if (botToken) {
  bot = new TelegramBot(botToken);
} else {
  console.error("Cannot initialize Telegram Bot: Token missing.");
}

/**
 * Extracts the sticker pack name from a Telegram sticker link.
 * @param {string} link The Telegram sticker link.
 * @return {string|null} The pack name or null if invalid.
 */
function getPackNameFromLink(link) {
  if (!link) return null;
  const match = link.match(/t\.me\/addstickers\/([a-zA-Z0-9_]+)/);
  return match ? match[1] : null;
}

// Cloud Function that triggers when a new sticker pack is added to Firestore
exports.fetchStickerPreview = functions.firestore
    .document("stickerPacks/{docId}")
    .onCreate(async (snap, context) => {
      if (!bot) {
        console.error(
            "Telegram bot not initialized. Skipping preview fetch.",
        );
        return null;
      }

      const data = snap.data();
      const docRef = snap.ref;
      const docId = context.params.docId;

      const packLink = data.link;
      const packName = getPackNameFromLink(packLink);

      if (!packName) {
        functions.logger.warn(
            `Invalid sticker link format for doc ${docId}: ${packLink}`,
        );
        // Update Firestore document to indicate failure?
        // await docRef.update({ name: "Invalid Link", imageUrl: null });
        return null;
      }

      functions.logger.info(`Processing pack: ${packName} for doc ${docId}`);

      try {
        // 1. Get Sticker Set info
        const stickerSet = await bot.getStickerSet(packName);
        const packTitle = stickerSet.title;
        functions.logger.info(`Fetched pack title: ${packTitle}`);

        if (!stickerSet || !stickerSet.stickers || stickerSet.stickers.length === 0) {
          functions.logger.warn(`No stickers found for pack: ${packName}`);
          return docRef.update({name: packTitle || "Empty Pack", imageUrl: null});
        }

        // 2. Get the thumbnail file_id
        const firstSticker = stickerSet.stickers[0];
        const thumb = firstSticker.thumb;
        const thumbFileId = thumb && thumb.file_id ? thumb.file_id : null;

        if (!thumbFileId) {
          functions.logger.warn(
              `No thumbnail file_id found for pack: ${packName}`,
          );
          return docRef.update({name: packTitle, imageUrl: null});
        }

        // 3. Get the temporary Telegram file path
        const fileInfo = await bot.getFile(thumbFileId);
        const telegramFilePath = fileInfo.file_path;

        if (!telegramFilePath) {
          functions.logger.error(`Could not get file path for file_id: ${thumbFileId}`);
          return docRef.update({name: packTitle, imageUrl: null});
        }

        // 4. Construct the temporary download URL
        const tempDownloadUrl = `https://api.telegram.org/file/bot${botToken}/${telegramFilePath}`;

        // 5. Download the image using axios
        const response = await axios({url: tempDownloadUrl, responseType: "arraybuffer"});
        const imageData = Buffer.from(response.data, "binary");
        const fileExtension = path.extname(telegramFilePath) || ".webp"; // Assume .webp if unknown
        const tempFileName = `${docId}${fileExtension}`;
        const tempFilePath = path.join(os.tmpdir(), tempFileName); // Save to Cloud Function's temp dir

        // Ensure the directory exists (should be handled by OS)
        // Write the image buffer to the temp file
        await fs.promises.writeFile(tempFilePath, imageData);
        functions.logger.info(`Downloaded image to temp file: ${tempFilePath}`);

        // 6. Upload the image to Firebase Storage
        const bucket = storage.bucket(); // Default bucket
        const destinationPath = `sticker_previews/${tempFileName}`;
        await bucket.upload(tempFilePath, {
          destination: destinationPath,
          metadata: {
            contentType: response.headers["content-type"] || "image/webp", // Use actual content type or default
            cacheControl: "public, max-age=31536000", // Cache for 1 year
          },
        });
        functions.logger.info(`Uploaded image to Storage: ${destinationPath}`);

        // 7. Clean up the temporary file
        await fs.promises.unlink(tempFilePath);

        // 8. Get the public URL for the uploaded file
        const file = bucket.file(destinationPath);
        await file.makePublic();
        const publicStorageUrl = file.publicUrl();
        functions.logger.info(`Generated public Storage URL: ${publicStorageUrl}`);

        // 9. Update the Firestore document with the *Storage* URL and name
        return docRef.update({imageUrl: publicStorageUrl, name: packTitle});
      } catch (error) {
        functions.logger.error(`Error processing pack ${packName} (doc ${docId}):`, error);
        // Update with name if available, but indicate image error
        try {
          const stickerSet = await bot.getStickerSet(packName).catch(() => null);
          const packTitle = stickerSet && stickerSet.title ? stickerSet.title : "Error Processing";
          await docRef.update({name: packTitle,
            imageUrl: null,
            error: error.message || "Preview fetch failed"});
        } catch (updateError) {
          functions.logger.error(
              `Failed to update doc ${docId} with error state:`, updateError,
          );
        }
        return null;
      }
    });

// Remove commented out example function
// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });
