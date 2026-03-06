/**
 * popup.js – Water Bill Downloader extension
 *
 * Flow:
 *  1. On open → ask content script for page's dropdown options.
 *  2. Populate local <select> elements; restore previously-saved selections.
 *  3. Auto-save on every change.
 *  4. "Refresh" button → re-fetch options from the live page.
 *  5. "Download" button → validate → tell content script to start automation.
 */

const STORAGE_KEY = 'waterBillSettings';

/* ────────────────────────────────────────
   Status helper
──────────────────────────────────────── */
function showStatus(msg, type = 'info') {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + type;
}

function clearStatus() {
  const el = document.getElementById('status');
  el.className = 'status';
  el.textContent = '';
}

/* ────────────────────────────────────────
   Build <option> elements in a <select>
──────────────────────────────────────── */
function populateSelect(selectEl, options, savedValue) {
  // Keep the first placeholder option
  const placeholder = selectEl.options[0].cloneNode(true);
  selectEl.innerHTML = '';
  selectEl.appendChild(placeholder);

  options.forEach(({ value, text }) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    selectEl.appendChild(opt);
  });

  if (savedValue) {
    selectEl.value = savedValue;
  }
}

/* ────────────────────────────────────────
   Persist current selections
──────────────────────────────────────── */
function saveSelections(cachedOptions) {
  const data = {
    financialYear:  document.getElementById('financialYear').value,
    billingPeriod:  document.getElementById('billingPeriod').value,
    billingDuration: document.getElementById('billingDuration').value,
  };
  if (cachedOptions) {
    data.cachedOptions = cachedOptions;
  }
  chrome.storage.local.set({ [STORAGE_KEY]: data });
}

/* ────────────────────────────────────────
   Load saved settings from storage
──────────────────────────────────────── */
function loadSaved() {
  return new Promise(resolve => {
    chrome.storage.local.get(STORAGE_KEY, result => {
      resolve(result[STORAGE_KEY] || {});
    });
  });
}

/* ────────────────────────────────────────
   Ask the content script for dropdown options
──────────────────────────────────────── */
async function fetchOptionsFromPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error('No active tab found.');

  // chrome:// pages cannot receive messages – avoid trying
  if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://'))) {
    throw new Error('Cannot access browser internal pages.');
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { action: 'getDropdownOptions' }, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || !response.success) {
        reject(new Error(response?.error || 'No water bill dropdowns found on this page.'));
        return;
      }
      resolve(response.options);
    });
  });
}

/* ────────────────────────────────────────
   Wire change listeners (auto-save)
──────────────────────────────────────── */
let cachedPageOptions = null;

function bindChangeListeners() {
  ['financialYear', 'billingPeriod', 'billingDuration'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      saveSelections(cachedPageOptions);
    });
  });
}

/* ────────────────────────────────────────
   Load options (page → cache → empty)
──────────────────────────────────────── */
async function loadOptions(showSpinner = true) {
  if (showSpinner) showStatus('Loading options from page…', 'info');

  const saved = await loadSaved();

  try {
    const options = await fetchOptionsFromPage();
    cachedPageOptions = options;

    populateSelect(document.getElementById('financialYear'),  options.financialYear  || [], saved.financialYear);
    populateSelect(document.getElementById('billingPeriod'),  options.billingPeriod  || [], saved.billingPeriod);
    populateSelect(document.getElementById('billingDuration'), options.billingDuration || [], saved.billingDuration);

    // Persist the fresh options so they survive page changes
    saveSelections(options);

    showStatus('Options loaded from the Water Bill page.', 'success');
    setTimeout(clearStatus, 2500);

  } catch (pageErr) {
    // Fall back to previously cached options
    if (saved.cachedOptions) {
      cachedPageOptions = saved.cachedOptions;
      populateSelect(document.getElementById('financialYear'),  saved.cachedOptions.financialYear  || [], saved.financialYear);
      populateSelect(document.getElementById('billingPeriod'),  saved.cachedOptions.billingPeriod  || [], saved.billingPeriod);
      populateSelect(document.getElementById('billingDuration'), saved.cachedOptions.billingDuration || [], saved.billingDuration);
      showStatus('Using cached options — open the Water Bill portal to refresh.', 'info');
    } else {
      // Restore at least the stored text values even without option lists
      showStatus('Open the Water Bill portal, then click ↻ to load options.', 'info');
    }
  }
}

/* ────────────────────────────────────────
   Download button handler
──────────────────────────────────────── */
document.getElementById('downloadBtn').addEventListener('click', async () => {
  const financialYear   = document.getElementById('financialYear').value;
  const billingPeriod   = document.getElementById('billingPeriod').value;
  const billingDuration = document.getElementById('billingDuration').value;

  if (!financialYear || !billingPeriod || !billingDuration) {
    showStatus('Please select Financial Year, Billing Period and Billing Duration.', 'error');
    return;
  }

  const downloadBtn = document.getElementById('downloadBtn');
  downloadBtn.disabled = true;
  showStatus('Starting automation…', 'running');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('No active tab.');

    chrome.tabs.sendMessage(
      tab.id,
      { action: 'startDownload', data: { financialYear, billingPeriod, billingDuration } },
      response => {
        if (chrome.runtime.lastError) {
          showStatus('Error: ' + chrome.runtime.lastError.message + ' — Make sure you are on the Water Bill portal.', 'error');
          downloadBtn.disabled = false;
          return;
        }
        if (response && response.success) {
          showStatus('Automation started! File will download into the WaterBills folder.', 'success');
        } else {
          showStatus('Automation error: ' + (response?.error || 'Unknown error.'), 'error');
        }
        downloadBtn.disabled = false;
      }
    );
  } catch (e) {
    showStatus('Error: ' + e.message, 'error');
    downloadBtn.disabled = false;
  }
});

/* ────────────────────────────────────────
   Refresh button handler
──────────────────────────────────────── */
document.getElementById('refreshBtn').addEventListener('click', () => {
  loadOptions(true);
});

/* ────────────────────────────────────────
   Init
──────────────────────────────────────── */
bindChangeListeners();
loadOptions(true);
