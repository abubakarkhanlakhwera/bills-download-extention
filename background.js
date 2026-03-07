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
   Download log – keep last 5 entries
════════════════════════════════════════ */
const LOG_KEY = 'waterBillDownloadLog';

function addDownloadLog(filename, timestamp) {
  chrome.storage.local.get(LOG_KEY, data => {
    const log = data[LOG_KEY] || [];
    log.unshift({ filename, timestamp });
    chrome.storage.local.set({ [LOG_KEY]: log.slice(0, 5) });
  });
}

/* ════════════════════════════════════════
   Time-range helper for the scheduler
════════════════════════════════════════ */
function isInTimeRange(startTime, endTime) {
  if (!startTime || !endTime) return true;
  const now = new Date();
  const cur   = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  const start = sh * 60 + sm;
  const end   = eh * 60 + em;
  // Overnight range (e.g. 22:00 – 06:00)
  if (start > end) return cur >= start || cur <= end;
  return cur >= start && cur <= end;
}

/* ════════════════════════════════════════
   Message listener
   – 'prepareDownload'   : set the pending flag so the next download is captured
   – 'automationError'   : surface content-script errors to the user
   – 'downloadDataUrl'   : explicit download from a blob intercepted in content.js
════════════════════════════════════════ */
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'prepareDownload') {
    chrome.storage.session.set({ pendingWaterBillDownload: true });
  }

  if (message.action === 'automationError') {
    notify('Water Bill – Automation Error', message.error || 'An unknown error occurred.');
  }

  // Explicit download initiated by the blob-URL interceptor in content.js.
  // data-URLs are accessible from the service worker, unlike blob: URLs.
  if (message.action === 'downloadDataUrl') {
    // Clear the pending flag – we are handling this download ourselves.
    chrome.storage.session.remove('pendingWaterBillDownload');
    const filename = buildFilename(message.originalFilename || 'water_bill.xlsx');
    chrome.downloads.download(
      { url: message.dataUrl, filename, conflictAction: 'uniquify', saveAs: false },
      downloadId => {
        if (chrome.runtime.lastError) {
          notify('Water Bill Download Error', chrome.runtime.lastError.message);
          return;
        }
        // Tag this download so onChanged can log + clean up the previous one
        chrome.storage.session.set({ currentWaterBillDownloadId: downloadId });
      }
    );
  }
});

/* ════════════════════════════════════════
   Download filename interception
   Called by Chrome before a download is saved. We rename water-bill files
   to our standard path and mark their ID for later cleanup.
════════════════════════════════════════ */
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  // PRIMARY: check if this download was initiated from the portal tab.
  // This is reliable regardless of service-worker sleep timing.
  chrome.tabs.query({ url: '*://elgcd.punjab.gov.pk/*' }, tabs => {
    const isFromPortal = tabs.some(t => t.id === downloadItem.tabId);

    if (isFromPortal) {
      // Definitely our water-bill export — rename it.
      const newFilename = buildFilename(downloadItem.filename);
      chrome.storage.session.set({ currentWaterBillDownloadId: downloadItem.id });
      chrome.storage.session.remove('pendingWaterBillDownload'); // clean up flag
      suggest({ filename: newFilename, conflictAction: 'uniquify' });
      return;
    }

    // FALLBACK: check the pending flag (handles edge cases where tabId is 0/-1)
    chrome.storage.session.get(['pendingWaterBillDownload'], data => {
      if (!data.pendingWaterBillDownload) {
        suggest(); // not our download
        return;
      }
      chrome.storage.session.remove('pendingWaterBillDownload');
      const newFilename = buildFilename(downloadItem.filename);
      chrome.storage.session.set({ currentWaterBillDownloadId: downloadItem.id });
      suggest({ filename: newFilename, conflictAction: 'uniquify' });
    });
  });

  return true; // async suggest()
});

/* ════════════════════════════════════════
   Download completion listener
   When our tagged download completes:
     • Delete the PREVIOUS water-bill file (if any)
     • Persist this download's ID as the new "last"
     • Show a success notification
════════════════════════════════════════ */
chrome.downloads.onChanged.addListener(delta => {
  // Only handle terminal state transitions (complete / interrupted)
  if (!delta.state) return;
  if (delta.state.current !== 'complete' && delta.state.current !== 'interrupted') return;

  chrome.storage.session.get(['currentWaterBillDownloadId'], sessionData => {
    if (delta.id !== sessionData.currentWaterBillDownloadId) return;

    if (delta.state.current === 'complete') {
      // Record this download in the log
      chrome.downloads.search({ id: delta.id }, items => {
        if (items && items[0]) {
          const rawPath = items[0].filename || '';
          const fn = rawPath.replace(/\\/g, '/').split('/').pop() || rawPath || 'unknown';
          addDownloadLog(fn, new Date().toISOString());
        }
      });

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

/* ════════════════════════════════════════
   Extension icon click → open popup as a
   persistent window (won't auto-close on blur)
════════════════════════════════════════ */
chrome.action.onClicked.addListener(() => {
  chrome.windows.create({
    url:     chrome.runtime.getURL('popup.html'),
    type:    'popup',
    width:   420,
    height:  820,
    focused: true,
  });
});

/* ════════════════════════════════════════
   Scheduled auto-download (chrome.alarms)
════════════════════════════════════════ */
const PORTAL_URL = 'https://elgcd.punjab.gov.pk/e-billing/water-bill-list';

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'waterBillSchedule') return;

  // Load saved selections and schedule settings
  const stored = await chrome.storage.local.get(['waterBillSettings', 'waterBillSchedule']);
  const s     = stored.waterBillSettings;
  const sched = stored.waterBillSchedule || {};

  if (!s || !s.financialYear || !s.billingPeriod || !s.billingDuration) {
    notify(
      'Water Bill Scheduler',
      'No saved settings found. Open the extension, select options, and click Save Settings first.'
    );
    return;
  }

  // Honour the time-range window if one is configured
  if (sched.startTime && sched.endTime) {
    if (!isInTimeRange(sched.startTime, sched.endTime)) {
      // Outside the allowed window – skip silently
      return;
    }
  }

  // Find an existing portal tab; otherwise open a new one
  const tabs = await chrome.tabs.query({ url: '*://elgcd.punjab.gov.pk/*' });
  let tab = tabs[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: PORTAL_URL, active: false });
    // Wait for the page to fully load
    await new Promise(resolve => {
      chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      });
    });
    // Extra wait for Angular to render
    await new Promise(r => setTimeout(r, 3000));
  }

  // Inject content.js (guard inside prevents double-registration)
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (_) { /* already injected */ }

  // Trigger automation with saved settings
  chrome.tabs.sendMessage(tab.id, {
    action: 'startDownload',
    data: {
      financialYear:       s.financialYear,
      billingPeriod:       s.billingPeriod,
      billingDuration:     s.billingDuration,
      billingDurationText: s.billingDurationText || '',
    },
  });
});
