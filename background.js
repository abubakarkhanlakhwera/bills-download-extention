/**
 * background.js – Water Bill Downloader (MV3 Service Worker)
 *
 * Responsibilities:
 *  1. Receive 'prepareDownload' signal from the content script.
 *  2. On the next download, rename the file to:
 *       WaterBills/DD-MM-YYYY_HH-MM-SS.<ext>
 *     (stored in the user's default Downloads/WaterBills/ directory).
 *  3. Once that download completes, delete the PREVIOUS water-bill file
 *     so only the latest one is kept.
 *  4. Show a desktop notification on success or error.
 *
 * State keys in chrome.storage.local (persistent across browser restarts):
 *   lastWaterBillDownloadId  – chrome.downloads ID of the previous bill file
 *
 * State keys in chrome.storage.session (cleared when browser closes):
 *   pendingWaterBillDownload – boolean flag: tag the NEXT download as a water bill
 *   currentWaterBillDownloadId – download ID currently being tracked
 */

/* ════════════════════════════════════════
   Helper: zero-pad a number to 2 digits
════════════════════════════════════════ */
const pad = n => String(n).padStart(2, '0');

/* ════════════════════════════════════════
   Helper: build the destination filename
════════════════════════════════════════ */
function buildFilename(originalFilename) {
  const now = new Date();
  const dd   = pad(now.getDate());
  const mm   = pad(now.getMonth() + 1);
  const yyyy = now.getFullYear();
  const HH   = pad(now.getHours());
  const MIN  = pad(now.getMinutes());
  const SS   = pad(now.getSeconds());

  // Preserve original extension; default to xlsx
  const dotIdx = (originalFilename || '').lastIndexOf('.');
  const ext    = dotIdx > -1 ? originalFilename.substring(dotIdx + 1).toLowerCase() : 'xlsx';

  return `WaterBills/${dd}-${mm}-${yyyy}_${HH}-${MIN}-${SS}.${ext}`;
}

/* ════════════════════════════════════════
   Helper: show a desktop notification
════════════════════════════════════════ */
function notify(title, message) {
  chrome.notifications.create({
    type:     'basic',
    iconUrl:  'icons/icon48.png',
    title,
    message,
    priority: 1,
  });
}

/* ════════════════════════════════════════
   Message listener
   – 'prepareDownload'  : set the pending flag so the next download is captured
   – 'automationError'  : surface content-script errors to the user
════════════════════════════════════════ */
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'prepareDownload') {
    chrome.storage.session.set({ pendingWaterBillDownload: true });
  }

  if (message.action === 'automationError') {
    notify('Water Bill – Automation Error', message.error || 'An unknown error occurred.');
  }
});

/* ════════════════════════════════════════
   Download filename interception
   Called by Chrome before a download is saved. We rename water-bill files
   to our standard path and mark their ID for later cleanup.
════════════════════════════════════════ */
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  chrome.storage.session.get(['pendingWaterBillDownload'], data => {
    if (!data.pendingWaterBillDownload) {
      // Not our download – leave Chrome's default alone
      suggest();
      return;
    }

    // Clear the flag immediately to avoid accidentally catching a second download
    chrome.storage.session.remove('pendingWaterBillDownload');

    const newFilename = buildFilename(downloadItem.filename);

    // Remember this download ID so we can track completion and delete it next time
    chrome.storage.session.set({ currentWaterBillDownloadId: downloadItem.id });

    suggest({ filename: newFilename, conflictAction: 'uniquify' });
  });

  return true; // Signal that suggest() will be called asynchronously
});

/* ════════════════════════════════════════
   Download completion listener
   When our tagged download completes:
     • Delete the PREVIOUS water-bill file (if any)
     • Persist this download's ID as the new "last"
     • Show a success notification
════════════════════════════════════════ */
chrome.downloads.onChanged.addListener(delta => {
  // Only care about state changes to 'complete' or 'interrupted'
  if (!delta.state) return;

  chrome.storage.session.get(['currentWaterBillDownloadId'], sessionData => {
    if (delta.id !== sessionData.currentWaterBillDownloadId) return;

    if (delta.state.current === 'complete') {
      // Retrieve the ID of the previously-downloaded water bill
      chrome.storage.local.get(['lastWaterBillDownloadId'], localData => {
        const prevId = localData.lastWaterBillDownloadId;

        if (prevId && prevId !== delta.id) {
          // Delete the old file from disk
          chrome.downloads.removeFile(prevId, () => {
            if (chrome.runtime.lastError) {
              // File may already be missing – not a fatal error
              console.warn(
                '[WaterBillDownloader] Could not delete previous file:',
                chrome.runtime.lastError.message
              );
            }
            // Remove it from the downloads list in Chrome as well
            chrome.downloads.erase({ id: prevId });
          });
        }

        // Persist the new download as "last"
        chrome.storage.local.set({ lastWaterBillDownloadId: delta.id });

        // Notify the user
        notify(
          'Water Bill Downloaded ✓',
          'Saved to Downloads → WaterBills folder. Previous bill has been removed.'
        );
      });

    } else if (delta.state.current === 'interrupted') {
      notify(
        'Water Bill Download Failed',
        'The download was interrupted. Please try again.'
      );
    }

    // Always clear the in-session tracking ID once we've handled this download
    chrome.storage.session.remove('currentWaterBillDownloadId');
  });
});
