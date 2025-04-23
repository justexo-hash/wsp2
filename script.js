// --- Firebase Configuration ---
// IMPORTANT: Replace the placeholder values below with your actual Firebase project configuration!
const firebaseConfig = {
    apiKey: "AIzaSyCK4SJ3e1fJq47n0EtDmtuO-ypL-eqkND8",
    authDomain: "weirdstickerpacks.firebaseapp.com",
    projectId: "weirdstickerpacks",
    storageBucket: "weirdstickerpacks.firebasestorage.app",
    messagingSenderId: "347914186405",
    appId: "1:347914186405:web:92c8f1aa2eb8cb9880e74c",
    measurementId: "G-FDZLY02EXZ"
};

// --- Initialize Firebase ---
// Check if Firebase apps are already initialized to avoid errors during hot reloads
let app;
if (!firebase.apps.length) {
  app = firebase.initializeApp(firebaseConfig);
} else {
  app = firebase.app(); // if already initialized, use that one
}
const db = firebase.firestore();
const stickerCollection = db.collection("stickerPacks"); // Name of our Firestore collection

// --- Constants ---
const PACKS_PER_PAGE = 12; // Show 12 packs per page

// --- State Variables ---
let firstVisible = null; // Track the first document snapshot of the current page
let lastVisible = null;  // Track the last document snapshot of the current page
let currentPageDocs = []; // Store the docs of the current page for prev functionality
let isFirstPage = true;
let isLastPage = false;

// --- DOM Elements ---
const gallery = document.getElementById('sticker-gallery');
const submissionForm = document.getElementById('submission-form').querySelector('form');
const packLinkInput = document.getElementById('pack-link');
const prevButton = document.getElementById('prev-button');
const nextButton = document.getElementById('next-button');
const contractAddressElement = document.getElementById('contract-address');
const copyFeedbackElement = document.getElementById('copy-feedback');

// --- Functions ---

// Function to render a single sticker pack in the gallery
function renderStickerPack(doc) {
    const data = doc.data();
    const packDiv = document.createElement('div');
    packDiv.classList.add('sticker-pack');
    packDiv.setAttribute('data-id', doc.id);

    const img = document.createElement('img');
    // Use fetched imageUrl or fallback to generic placeholder
    const fetchedImageUrl = data.imageUrl;
    img.src = (fetchedImageUrl && fetchedImageUrl.startsWith('http')) ? fetchedImageUrl : 'images/generic-placeholder.png';
    // Use fetched name from Telegram (or fallback) for alt text
    img.alt = data.name ? `${data.name} Sticker Pack` : 'Telegram Sticker Pack';
    img.onerror = () => {
        // Use console.warn for non-critical errors
        console.warn(`Failed to load image: ${fetchedImageUrl}. Falling back to placeholder.`);
        img.src = 'images/generic-placeholder.png';
        img.onerror = null;
    };

    const namePara = document.createElement('p');
    // Display name fetched by Cloud Function (or fallback)
    namePara.textContent = data.name || 'Loading Name...'; // Show loading state initially

    const link = document.createElement('a');
    link.href = data.link;
    link.textContent = 'View Pack';
    link.target = '_blank'; // Open in new tab

    packDiv.appendChild(img);
    packDiv.appendChild(namePara);
    packDiv.appendChild(link);

    gallery.appendChild(packDiv);
}

// Function to update pagination button states
function updatePaginationButtons() {
    prevButton.disabled = isFirstPage;
    nextButton.disabled = isLastPage;
    // console.log(`Buttons updated: Prev disabled=${isFirstPage}, Next disabled=${isLastPage}`);
}

// Refactored function to load sticker packs with pagination
function loadStickerPacks(direction = 'initial') {
    // console.log(`Loading packs, direction: ${direction}`);
    gallery.innerHTML = '<h2>Sticker Pack Gallery</h2>'; // Clear previous gallery content but keep title

    let query = stickerCollection
        .orderBy("timestamp", "desc") // MUST order consistently

    // Adjust query based on direction
    if (direction === 'next' && lastVisible) {
        // console.log('Querying next page after:', lastVisible.data().timestamp);
        query = query.startAfter(lastVisible);
        isFirstPage = false; // Moving forward, so no longer first page
    } else if (direction === 'prev' && firstVisible) {
        // For 'prev', we query backwards then reverse the results client-side
        // Firestore doesn't have a simple 'endBefore' with limit that works intuitively for pagination
        // So we fetch the previous N items *ending* at our current first item
        // console.log('Querying previous page before:', firstVisible.data().timestamp);
        query = stickerCollection
            .orderBy("timestamp", "desc")
            .endBefore(firstVisible)
            .limitToLast(PACKS_PER_PAGE); // Get the last N items *before* the first visible
    } else {
        // Initial load or returning to first page
        // console.log('Querying initial page');
        query = query.limit(PACKS_PER_PAGE);
        isFirstPage = true;
        firstVisible = null; // Reset cursors for initial load
        lastVisible = null;
    }

    // If not going previous, apply the standard limit
    if (direction !== 'prev') {
        query = query.limit(PACKS_PER_PAGE);
    }

    query.get()
        .then((querySnapshot) => {
            // console.log(`Query successful, docs found: ${querySnapshot.size}`);

            if (querySnapshot.empty) {
                // console.log('Query was empty.');
                if (direction === 'initial') {
                    gallery.innerHTML += '<p>No sticker packs submitted yet. Be the first!</p>';
                }
                // If going next and it's empty, we are on the last page
                if (direction === 'next') {
                    isLastPage = true;
                } else if (direction === 'prev') {
                    // If going prev and it's empty, we have reached the beginning again
                    isFirstPage = true;
                    // It's possible we need to reload the actual first page if logic gets complex
                    loadStickerPacks('initial'); // Reload first page cleanly
                    return; // Stop processing this empty snapshot
                } else {
                    // Initial load was empty
                    isLastPage = true;
                }
                currentPageDocs = [];
            } else {
                // Process the documents
                currentPageDocs = querySnapshot.docs;

                // If we queried for 'prev', Firestore gives them in ascending order relative to the query,
                // but we want descending overall. Since we used limitToLast, they *should* be correct.
                // No reversal needed if limitToLast + endBefore works as expected.

                // Update cursors
                firstVisible = currentPageDocs[0];
                lastVisible = currentPageDocs[currentPageDocs.length - 1];
                // console.log('New firstVisible timestamp:', firstVisible?.data().timestamp);
                // console.log('New lastVisible timestamp:', lastVisible?.data().timestamp);

                // Render the current page docs
                currentPageDocs.forEach(renderStickerPack);

                // Check if this is potentially the last page
                // A simple check: if we received fewer docs than requested, it must be the last page
                isLastPage = currentPageDocs.length < PACKS_PER_PAGE;
                // console.log(`isLastPage set to ${isLastPage} (docs: ${currentPageDocs.length})`);

                 // If we are on the first page, we explicitly know `prev` is disabled
                if(direction === 'initial' || firstVisible === currentPageDocs[0] && querySnapshot.size < PACKS_PER_PAGE && direction !== 'next'){
                    isFirstPage = true;
                } else if (direction === 'prev') {
                    // Check if the very first document overall is in our currentDocs
                    // This requires an extra check or knowing the absolute first doc
                    // For simplicity, we'll rely on the 'prev was empty' check above primarily.
                    // Let's assume if direction is 'prev', isFirstPage becomes false unless proven otherwise.
                    isFirstPage = false;
                }
            }

            updatePaginationButtons();
        })
        .catch((error) => {
            console.error("Error getting documents: ", error);
            gallery.innerHTML += '<p>Error loading sticker packs. Please try again later.</p>';
            // Disable buttons on error
            isFirstPage = true;
            isLastPage = true;
            updatePaginationButtons();
        });
}

// Function to validate Telegram sticker link
function isValidTelegramStickerLink(link) {
    // Basic check for the correct URL structure
    // You might want a more robust regex depending on exact requirements
    const pattern = /^https:\/\/t\.me\/addstickers\/[a-zA-Z0-9_]+(?:\/)?$/;
    return pattern.test(link);
}

// Function to handle form submission (Simplified)
function handleFormSubmit(event) {
    event.preventDefault();

    const packLink = packLinkInput.value.trim();

    // Validation
    if (!packLink) {
        alert('Please enter a Telegram sticker pack link.');
        return;
    }
    if (!isValidTelegramStickerLink(packLink)) {
        alert('Invalid Telegram sticker link format. It should look like: https://t.me/addstickers/YourPackName');
        return;
    }

    // Add to Firestore (only link and timestamp initially)
    stickerCollection.add({
        link: packLink,
        // name and imageUrl will be added by the Cloud Function
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
    })
    .then((docRef) => {
        console.log("Document written with ID: ", docRef.id);
        submissionForm.reset();
        alert('Sticker pack submitted successfully! It will appear shortly with its preview.');
        // Reload the first page to show the newest submission placeholder
        loadStickerPacks('initial');
    })
    .catch((error) => {
        console.error("Error adding document: ", error);
        alert('Error submitting sticker pack. Please try again.');
    });
}

// --- Event Listeners ---
submissionForm.addEventListener('submit', handleFormSubmit);

prevButton.addEventListener('click', () => {
    // console.log('Prev button clicked');
    loadStickerPacks('prev');
});

nextButton.addEventListener('click', () => {
    // console.log('Next button clicked');
    loadStickerPacks('next');
});

// Add click listener for contract address
if (contractAddressElement) {
    contractAddressElement.addEventListener('click', () => {
        const address = contractAddressElement.innerText;
        navigator.clipboard.writeText(address).then(() => {
            // Success feedback
            copyFeedbackElement.textContent = 'Copied!';
            copyFeedbackElement.classList.add('show'); // Show feedback
            contractAddressElement.style.backgroundColor = '#aaffaa'; // Optional: Light green flash

            // Clear feedback after a delay
            setTimeout(() => {
                copyFeedbackElement.classList.remove('show'); // Hide feedback
                contractAddressElement.style.backgroundColor = ''; // Reset style
                // Ensure text content is cleared after fade out
                 setTimeout(() => { copyFeedbackElement.textContent = ''; }, 300);
            }, 1500); // Hide after 1.5 seconds
        }).catch(err => {
            console.error('Failed to copy address: ', err);
            copyFeedbackElement.textContent = 'Copy failed!';
            copyFeedbackElement.classList.add('show');
            setTimeout(() => {
                copyFeedbackElement.classList.remove('show');
                 setTimeout(() => { copyFeedbackElement.textContent = ''; }, 300);
            }, 1500);
        });
    });
}

// --- Initial Load ---
document.addEventListener('DOMContentLoaded', () => {
    // console.log('DOM Content Loaded, loading initial packs');
    loadStickerPacks('initial'); // Load the first page initially
});

// --- Helper: Add a generic placeholder image ---
// You should create a simple PNG file named 'generic-placeholder.png' in the 'images' folder.
// For example, a simple grey square or a question mark icon. 