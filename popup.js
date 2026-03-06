/**
 * popup.js – Water Bill Downloader extension
 *
 * Flow:
 *  1. On open → inject inline script into the active tab to read dropdown options.
 *  2. Populate local <select> elements; restore previously-saved selections.
 *  3. Auto-save on every change.
 *  4. "Refresh" button → re-fetch options from the live page.
 *  5. "Download" button → validate → inject content.js then trigger automation.
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
   Read dropdown options directly from the tab via scripting API.
   This works even if the content script hasn't been injected yet.
──────────────────────────────────────── */
async function fetchOptionsFromPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error('No active tab found.');
  if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://'))) {
    throw new Error('Cannot access browser internal pages.');
  }

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function () {
        function findSelect(keyword) {
          const kw = keyword.toLowerCase();
          for (const sel of document.querySelectorAll('select')) {
            if (sel.options.length > 0 && sel.options[0].text.toLowerCase().includes(kw)) return sel;
          }
          for (const label of document.querySelectorAll('label')) {
            if (label.textContent.toLowerCase().includes(kw)) {
              const forId = label.getAttribute('for');
              if (forId) { const s = document.getElementById(forId); if (s && s.tagName === 'SELECT') return s; }
              const child = label.querySelector('select');
              if (child) return child;
              const cont = label.closest('div,td,th,li,span') || label.parentElement;
              if (cont) { const n = cont.querySelector('select'); if (n) return n; }
            }
          }
          return null;
        }
        function readOpts(sel) {
          if (!sel) return [];
          return Array.from(sel.options).slice(1).map(o => ({ value: o.value, text: o.text.trim() }));
        }
        const fy = findSelect('financial year');
        const bp = findSelect('billing period');
        const bd = findSelect('billing duration');
        if (!fy && !bp && !bd) return { success: false, error: 'No water bill dropdowns found on this page.' };
        return {
          success: true,
          options: {
            financialYear:   readOpts(fy),
            billingPeriod:   readOpts(bp),
            billingDuration: readOpts(bd),
          },
        };
      },
    });
  } catch (e) {
    throw new Error('Cannot inject into this page: ' + e.message);
  }

  const result = results && results[0] && results[0].result;
  if (!result) throw new Error('Script returned no result.');
  if (!result.success) throw new Error(result.error);
  return result.options;
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

    // Inject content.js on demand (guard inside the file prevents double-registration)
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch (_) {
      // Ignore – already injected via manifest declaration
    }

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
