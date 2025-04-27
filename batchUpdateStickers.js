/* eslint-disable max-len */
// One-time script to update existing sticker packs with permanent image URLs

const admin = require("firebase-admin");
const axios = require("axios");
const path = require("path");
const os = require("os");
const fs = require("fs").promises; // Use promise-based fs

// --- Configuration ---
// IMPORTANT: Make sure serviceAccountKey.json is in the same directory
// and listed in your .gitignore file!
const serviceAccount = require("./serviceAccountKey.json");

// IMPORTANT: Set your Telegram Bot Token as an environment variable
// before running this script. Example (Bash/Zsh):
// export TELEGRAM_BOT_TOKEN='YOUR_BOT_TOKEN'
// Example (Windows CMD):
// set TELEGRAM_BOT_TOKEN=YOUR_BOT_TOKEN
// Example (Windows PowerShell):
// $env:TELEGRAM_BOT_TOKEN='YOUR_BOT_TOKEN'
const botToken = process.env.TELEGRAM_BOT_TOKEN;

if (!botToken) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN environment variable not set.");
  process.exit(1);
}

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  // Add your storageBucket URL here if deploying requires it, usually auto-detected
  // storageBucket: "YOUR_PROJECT_ID.appspot.com" // e.g., weirdstickerpacks.appspot.com
});

const db = admin.firestore();
const storage = admin.storage();
const bucket = storage.bucket(); // Default bucket
const stickerCollection = db.collection("stickerPacks");

// --- Helper Functions ---

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

/**
 * Calls the Telegram Bot API method.
 * @param {string} methodName The API method name (e.g., 'getStickerSet').
 * @param {object} params The parameters for the API method.
 * @return {Promise<object>} The result from the Telegram API.
 */
async function callTelegramApi(methodName, params = {}) {
  const apiUrl = `https://api.telegram.org/bot${botToken}/${methodName}`;
  try {
    const response = await axios.post(apiUrl, params, {
      headers: { "Content-Type": "application/json" },
    });
    if (response.data && response.data.ok) {
      return response.data.result;
    } else {
      throw new Error(
          `Telegram API Error (${methodName}): ${response.data?.description || "Unknown error"}`,
      );
    }
  } catch (error) {
    if (error.response && error.response.data) {
      // Rethrow with specific Telegram description
      throw new Error(
          `Telegram API Error (${methodName}): ${error.response.data.description || "Request failed"}`,
      );
    }
    throw error; // Rethrow original error if not a Telegram API error
  }
}

// --- Main Processing Logic ---

async function updateStickerPack(docSnap) {
  const docId = docSnap.id;
  const data = docSnap.data();
  const docRef = docSnap.ref;

  console.log(`Processing Doc ID: ${docId}...`);

  // Check if update is needed
  if (data.imageUrl && data.imageUrl.startsWith("https://storage.googleapis.com")) {
    console.log(`  Skipping - Already has permanent Storage URL.`);
    return { status: "skipped" };
  }

  const packLink = data.link;
  const packName = getPackNameFromLink(packLink);

  if (!packName) {
    console.warn(`  WARNING: Invalid link format: ${packLink}. Cannot update.`);
    // Optionally update Firestore to mark as invalid
    // await docRef.update({ name: "Invalid Link Format", imageUrl: null, needs_fix: false });
    return { status: "invalid_link" };
  }

  console.log(`  Pack Name: ${packName}`);

  try {
    // 1. Get Sticker Set info
    const stickerSet = await callTelegramApi("getStickerSet", { name: packName });
    const packTitle = stickerSet.title;
    console.log(`  Fetched Title: ${packTitle}`);

    if (!stickerSet.stickers || stickerSet.stickers.length === 0) {
      console.warn(`  WARNING: No stickers found in pack.`);
      await docRef.update({ name: packTitle || "Empty Pack", imageUrl: null });
      return { status: "empty_pack" };
    }

    // 2. Get thumbnail file_id
    const firstSticker = stickerSet.stickers[0];
    const thumbFileId = firstSticker.thumb?.file_id; // Optional chaining ok in Node.js

    if (!thumbFileId) {
      console.warn(`  WARNING: No thumbnail file_id found.`);
      await docRef.update({ name: packTitle, imageUrl: null });
      return { status: "no_thumb" };
    }

    // 3. Get temporary Telegram file path
    const fileInfo = await callTelegramApi("getFile", { file_id: thumbFileId });
    const telegramFilePath = fileInfo.file_path;

    if (!telegramFilePath) {
      throw new Error("Could not get file path from Telegram API");
    }

    // 4. Download image
    const tempDownloadUrl = `https://api.telegram.org/file/bot${botToken}/${telegramFilePath}`;
    const response = await axios({ url: tempDownloadUrl, responseType: "arraybuffer" });
    const imageData = Buffer.from(response.data, "binary");
    const fileExtension = path.extname(telegramFilePath) || ".webp";
    const tempFileName = `${docId}${fileExtension}`;
    const tempFilePath = path.join(os.tmpdir(), tempFileName);

    await fs.writeFile(tempFilePath, imageData);
    console.log(`  Downloaded image temporarily to ${tempFilePath}`);

    // 5. Upload to Firebase Storage
    const destinationPath = `sticker_previews/${tempFileName}`;
    await bucket.upload(tempFilePath, {
      destination: destinationPath,
      metadata: {
        contentType: response.headers["content-type"] || "image/webp",
        cacheControl: "public, max-age=31536000",
      },
    });
    console.log(`  Uploaded image to Storage at ${destinationPath}`);

    // 6. Clean up temp file
    await fs.unlink(tempFilePath);

    // 7. Get public URL
    const file = bucket.file(destinationPath);
    await file.makePublic(); // Make it public
    const publicStorageUrl = file.publicUrl();
    console.log(`  Generated public Storage URL: ${publicStorageUrl}`);

    // 8. Update Firestore
    await docRef.update({
      imageUrl: publicStorageUrl,
      name: packTitle,
    });
    console.log(`  SUCCESS: Firestore document updated.`);
    return { status: "success" };

  } catch (error) {
    console.error(`  ERROR processing ${packName} (doc ${docId}):`, error.message || error);
    // Attempt to update with error state (optional)
    try {
      const stickerSet = await callTelegramApi("getStickerSet", { name: packName }).catch(() => null);
      await docRef.update({
        name: stickerSet?.title || data.name || "Error Processing", // Keep old name if possible
        imageUrl: null,
        error: `Batch update failed: ${error.message || "Unknown error"}`,
      });
    } catch (updateError) {
        console.error(`  Failed to update doc ${docId} with error state:`, updateError);
    }
    return { status: "error", message: error.message };
  }
}

async function runBatchUpdate() {
  console.log("Starting batch update for sticker packs...");
  let processedCount = 0;
  let successCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  try {
    const snapshot = await stickerCollection.get();
    console.log(`Found ${snapshot.size} documents in collection.`);

    // Process sequentially to avoid overwhelming APIs or hitting rate limits
    for (const doc of snapshot.docs) {
      processedCount++;
      const result = await updateStickerPack(doc);
      if (result.status === "success") successCount++;
      else if (result.status === "skipped") skippedCount++;
      else errorCount++;
      // Optional: Add a small delay between processing each document
      await new Promise(resolve => setTimeout(resolve, 200)); // 200ms delay
    }

  } catch (error) {
    console.error("FATAL ERROR during batch processing:", error);
    errorCount++; // Count the overall batch failure as an error
  }

  console.log("\n--- Batch Update Summary ---");
  console.log(`Total Documents Found: ${processedCount}`);
  console.log(`Successfully Updated:  ${successCount}`);
  console.log(`Skipped (Up-to-date): ${skippedCount}`);
  console.log(`Errors Encountered:    ${errorCount}`);
  console.log("Batch update finished.");
}

// Run the script
runBatchUpdate(); 