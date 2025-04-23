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

admin.initializeApp();

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
      const docRef = snap.ref; // Reference to the document

      const packLink = data.link;
      const packName = getPackNameFromLink(packLink);

      if (!packName) {
        // Reformat long line
        functions.logger.warn(
            `Invalid sticker link format for doc ${context.params.docId}: ` +
            `${packLink}`,
        );
        return null; // Exit if link format is wrong
      }

      // Reformat long line
      functions.logger.info(
          `Processing pack: ${packName} for doc ${context.params.docId}`,
      );

      try {
        // 1. Get Sticker Set info
        const stickerSet = await bot.getStickerSet(packName);

        if (!stickerSet || !stickerSet.stickers || stickerSet.stickers.length === 0) {
          // Reformat long line
          functions.logger.warn(
              `No stickers found for pack: ${packName}`,
          );
          return null;
        }

        // 2. Get the thumbnail of the first sticker
        const firstSticker = stickerSet.stickers[0];
        // Replace optional chaining with standard check for compatibility
        const thumb = firstSticker.thumb;
        // Explicitly check for thumb and file_id
        let thumbFileId = null;
        // eslint-disable-next-line max-len
        if (thumb && thumb.file_id) {
          thumbFileId = thumb.file_id;
        }

        if (!thumbFileId) {
          // Reformat long line
          functions.logger.warn(
              "No thumbnail file_id found for first sticker in pack: " +
              `${packName}`,
          );
          return null;
        }

        // 3. Get the file path using the file_id
        const fileInfo = await bot.getFile(thumbFileId);
        const filePath = fileInfo.file_path;

        if (!filePath) {
          // Reformat long line
          functions.logger.error(
              `Could not get file path for file_id: ${thumbFileId}`,
          );
          return null;
        }

        // 4. Construct the image URL
        const imageUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
        functions.logger.info(
            `Generated image URL for ${packName}: ${imageUrl}`,
        );

        // Also get the pack title
        const packTitle = stickerSet.title;
        functions.logger.info(`Fetched pack title: ${packTitle}`);

        // 5. Update the Firestore document with the image URL and name(title)
        return docRef.update({
          imageUrl: imageUrl,
          name: packTitle, // Save Telegram's title as 'name'
        });
      } catch (error) {
        // Handle potential errors (e.g., pack not found, bot API errors)
        if (error.response && error.response.body) {
          const errorBody = JSON.parse(error.response.body);
          if (errorBody.description.includes("sticker set not found")) {
            // Corrected indentation and reformatted long line
            functions.logger.warn(
                `Sticker pack not found on Telegram: ${packName}`,
            );
          } else {
            // Corrected indentation and reformatted long line
            functions.logger.error(
                `Telegram API Error for pack ${packName}: ` +
                `${errorBody.description}`,
            );
          }
        } else {
          // Corrected indentation and reformatted long line
          functions.logger.error(
              `Error fetching sticker preview for ${packName}:`, error,
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
