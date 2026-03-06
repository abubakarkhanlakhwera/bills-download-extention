/**
 * popup.js – Water Bill Downloader extension
 *
 * Flow:
 *  1. On open → inject inline script to read Financial Year & Billing Period
 *     (always pre-loaded on page). Billing Duration is AJAX-loaded by the portal
 *     only after FY + BP are both selected, so it is fetched lazily.
 *  2. If saved FY + BP exist, auto-fetch Billing Duration from the page.
 *  3. When user changes FY or BP in the popup, auto-fetch Billing Duration again.
 *  4. "Refresh ↻" → re-reads FY & BP then reloads BD for saved selection.
 *  5. "Download" → validates selections → injects content.js → starts automation.
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
  const placeholder = selectEl.options[0].cloneNode(true);
  selectEl.innerHTML = '';
  selectEl.appendChild(placeholder);
  options.forEach(({ value, text }) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    selectEl.appendChild(opt);
  });
  if (savedValue) selectEl.value = savedValue;
}

/* ────────────────────────────────────────
   Persist current selections to storage
──────────────────────────────────────── */
let cachedPageOptions = null;

function saveSelections() {
  const bdSel = document.getElementById('billingDuration');
  const bdText = bdSel.selectedIndex > 0
    ? bdSel.options[bdSel.selectedIndex].textContent.trim()
    : '';
  const data = {
    financialYear:        document.getElementById('financialYear').value,
    billingPeriod:        document.getElementById('billingPeriod').value,
    billingDuration:      bdSel.value,
    billingDurationText:  bdText,
  };
  if (cachedPageOptions) data.cachedOptions = cachedPageOptions;
  chrome.storage.local.set({ [STORAGE_KEY]: data });
}

/* ────────────────────────────────────────
   Load saved settings from storage
──────────────────────────────────────── */
function loadSaved() {
  return new Promise(resolve => {
    chrome.storage.local.get(STORAGE_KEY, r => resolve(r[STORAGE_KEY] || {}));
  });
}

/* ────────────────────────────────────────
   Get active tab (not a chrome:// page)
──────────────────────────────────────── */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error('No active tab found.');
  if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://'))) {
    throw new Error('Cannot access browser internal pages.');
  }
  return tab;
}

/* ────────────────────────────────────────
   Shared helper injected into the page:
   finds a <select> by placeholder keyword
──────────────────────────────────────── */
function pageFindSelect(keyword) {
  // NOTE: this function is toString()-serialised and injected — keep it self-contained.
  const kw = keyword.toLowerCase();
  for (const sel of document.querySelectorAll('select')) {
    if (sel.options.length > 0 && sel.options[0].text.toLowerCase().includes(kw)) return sel;
  }
  for (const label of document.querySelectorAll('label')) {
    if (label.textContent.toLowerCase().includes(kw)) {
      const forId = label.getAttribute('for');
      if (forId) { const s = document.getElementById(forId); if (s && s.tagName === 'SELECT') return s; }
      const ch = label.querySelector('select');
      if (ch) return ch;
      const cont = label.closest('div,td,th,li,span') || label.parentElement;
      if (cont) { const n = cont.querySelector('select'); if (n) return n; }
    }
  }
  return null;
}

/* ────────────────────────────────────────
   Step 1 – Read Financial Year & Billing Period options
   (these are always pre-populated on page load)
──────────────────────────────────────── */
async function fetchFYandBP() {
  const tab = await getActiveTab();
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function () {
        function findSel(kw) {
          kw = kw.toLowerCase();
          for (const s of document.querySelectorAll('select')) {
            if (s.options.length > 0 && s.options[0].text.toLowerCase().includes(kw)) return s;
          }
          for (const lb of document.querySelectorAll('label')) {
            if (lb.textContent.toLowerCase().includes(kw)) {
              const id = lb.getAttribute('for');
              if (id) { const s = document.getElementById(id); if (s && s.tagName === 'SELECT') return s; }
              const ch = lb.querySelector('select');
              if (ch) return ch;
              const c = lb.closest('div,td,th,li,span') || lb.parentElement;
              if (c) { const n = c.querySelector('select'); if (n) return n; }
            }
          }
          return null;
        }
        function readOpts(s) {
          if (!s) return [];
          return Array.from(s.options).slice(1).map(o => ({ value: o.value, text: o.text.trim() }));
        }
        const fy = findSel('financial year');
        const bp = findSel('billing period');
        if (!fy && !bp) return { success: false, error: 'Water Bill dropdowns not found on this page.' };
        return { success: true, financialYear: readOpts(fy), billingPeriod: readOpts(bp) };
      },
    });
  } catch (e) {
    throw new Error('Cannot read page: ' + e.message);
  }
  const r = results && results[0] && results[0].result;
  if (!r) throw new Error('No result from page script.');
  if (!r.success) throw new Error(r.error);
  return r;
}

/* ────────────────────────────────────────
   Step 2 – Set FY + BP on page, wait for
   Billing Duration AJAX, return BD options
──────────────────────────────────────── */
async function fetchBillingDuration(fyVal, bpVal) {
  if (!fyVal || !bpVal) return [];
  const tab = await getActiveTab();
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async function (fyVal, bpVal) {
        function findSel(kw) {
          kw = kw.toLowerCase();
          for (const s of document.querySelectorAll('select')) {
            if (s.options.length > 0 && s.options[0].text.toLowerCase().includes(kw)) return s;
          }
          for (const lb of document.querySelectorAll('label')) {
            if (lb.textContent.toLowerCase().includes(kw)) {
              const id = lb.getAttribute('for');
              if (id) { const s = document.getElementById(id); if (s && s.tagName === 'SELECT') return s; }
              const ch = lb.querySelector('select');
              if (ch) return ch;
              const c = lb.closest('div,td,th,li,span') || lb.parentElement;
              if (c) { const n = c.querySelector('select'); if (n) return n; }
            }
          }
          return null;
        }
        function setVal(s, v) {
          if (!s) return;
          // Native setter – required for Angular ngModel to react
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLSelectElement.prototype, 'value'
          ).set;
          setter.call(s, v);
          s.dispatchEvent(new Event('input',  { bubbles: true }));
          s.dispatchEvent(new Event('change', { bubbles: true }));
        }
        function waitForOpts(s, ms) {
          return new Promise(res => {
            const end = Date.now() + ms;
            (function check() {
              if (!s || s.options.length > 1 || Date.now() >= end) return res();
              setTimeout(check, 300);
            })();
          });
        }
        const fy = findSel('financial year');
        const bp = findSel('billing period');
        const bd = findSel('billing duration');
        if (!bd) return { success: false, error: 'Billing Duration dropdown not found.' };

        // Set FY, wait briefly, then set BP to trigger AJAX for BD
        setVal(fy, fyVal);
        await new Promise(r => setTimeout(r, 700));
        setVal(bp, bpVal);

        // Wait up to 7 seconds for BD options to appear
        await waitForOpts(bd, 7000);

        const opts = Array.from(bd.options).slice(1).map(o => ({ value: o.value, text: o.text.trim() }));
        return { success: true, options: opts };
      },
      args: [fyVal, bpVal],
    });
  } catch (e) {
    throw new Error('BD script error: ' + e.message);
  }
  const r = results && results[0] && results[0].result;
  if (!r || !r.success) throw new Error(r ? r.error : 'No result.');
  return r.options;
}

/* ────────────────────────────────────────
   Helper: reset Billing Duration dropdown
──────────────────────────────────────── */
function resetBillingDuration() {
  const bd = document.getElementById('billingDuration');
  bd.innerHTML = '<option value="">\u2014 Select Billing Duration \u2014</option>';
}

/* ────────────────────────────────────────
   Wire change listeners
──────────────────────────────────────── */
function bindChangeListeners() {
  // When FY or BP changes: clear BD and reload it from the page
  ['financialYear', 'billingPeriod'].forEach(id => {
    document.getElementById(id).addEventListener('change', async () => {
      saveSelections();
      resetBillingDuration();
      const fy = document.getElementById('financialYear').value;
      const bp = document.getElementById('billingPeriod').value;
      if (!fy || !bp) return;
      showStatus('Loading Billing Duration…', 'info');
      try {
        const opts = await fetchBillingDuration(fy, bp);
        if (opts.length > 0) {
          populateSelect(document.getElementById('billingDuration'), opts, '');
          if (cachedPageOptions) cachedPageOptions.billingDuration = opts;
          saveSelections();
          clearStatus();
        } else {
          showStatus('No Billing Duration options returned — check the portal page.', 'error');
        }
      } catch (e) {
        showStatus('Could not load Billing Duration: ' + e.message, 'error');
      }
    });
  });

  document.getElementById('billingDuration').addEventListener('change', () => saveSelections());
}

/* ────────────────────────────────────────
   Main load: read FY + BP, restore saved,
   then auto-fetch BD if selection is known
──────────────────────────────────────── */
async function loadOptions(showSpinner = true) {
  if (showSpinner) showStatus('Loading options from page…', 'info');
  const saved = await loadSaved();

  // ── Try to read live FY + BP from the page ──
  let fyOpts = [], bpOpts = [];
  try {
    const r = await fetchFYandBP();
    fyOpts = r.financialYear;
    bpOpts = r.billingPeriod;
    if (!cachedPageOptions) cachedPageOptions = {};
    cachedPageOptions.financialYear = fyOpts;
    cachedPageOptions.billingPeriod = bpOpts;
  } catch {
    // Fall back to cache
    if (saved.cachedOptions) {
      fyOpts = saved.cachedOptions.financialYear || [];
      bpOpts = saved.cachedOptions.billingPeriod || [];
      cachedPageOptions = saved.cachedOptions;
    }
  }

  populateSelect(document.getElementById('financialYear'), fyOpts, saved.financialYear);
  populateSelect(document.getElementById('billingPeriod'), bpOpts, saved.billingPeriod);

  // ── Always reset BD first ──
  resetBillingDuration();

  const savedFY = document.getElementById('financialYear').value;
  const savedBP = document.getElementById('billingPeriod').value;

  if (savedFY && savedBP) {
    // We have both — try to fetch BD from page
    showStatus('Loading Billing Duration…', 'info');
    try {
      const bdOpts = await fetchBillingDuration(savedFY, savedBP);
      if (bdOpts.length > 0) {
        populateSelect(document.getElementById('billingDuration'), bdOpts, saved.billingDuration);
        if (cachedPageOptions) cachedPageOptions.billingDuration = bdOpts;
        saveSelections();
        showStatus('All options loaded. Ready to download.', 'success');
        setTimeout(clearStatus, 2500);
      } else {
        // Fall back to cached BD options
        const cachedBD = saved.cachedOptions && saved.cachedOptions.billingDuration;
        if (cachedBD && cachedBD.length > 0) {
          populateSelect(document.getElementById('billingDuration'), cachedBD, saved.billingDuration);
          showStatus('FY & Period loaded. Billing Duration from cache.', 'info');
          setTimeout(clearStatus, 3000);
        } else {
          showStatus('Select Financial Year & Billing Period to load Duration options.', 'info');
        }
      }
    } catch {
      const cachedBD = saved.cachedOptions && saved.cachedOptions.billingDuration;
      if (cachedBD && cachedBD.length > 0) {
        populateSelect(document.getElementById('billingDuration'), cachedBD, saved.billingDuration);
        showStatus('FY & Period loaded. Using cached Duration options.', 'info');
        setTimeout(clearStatus, 3000);
      } else {
        showStatus('Financial Year & Billing Period loaded. Select them to fetch Duration.', 'info');
      }
    }
  } else if (fyOpts.length > 0) {
    showStatus('Select Financial Year & Billing Period to load Duration options.', 'info');
  } else {
    showStatus('Open the Water Bill portal, then click ↻ to load options.', 'info');
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
    showStatus('Please select all three fields before downloading.', 'error');
    return;
  }

  const downloadBtn = document.getElementById('downloadBtn');
  downloadBtn.disabled = true;
  showStatus('Starting automation…', 'running');

  try {
    const tab = await getActiveTab();
    // Inject content.js on demand — guard prevents double-registration
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch (_) { /* already injected */ }

    // Also send the visible text label for BD so content.js can match by text
    // (Angular re-generates option value indices on every render)
    const bdSel = document.getElementById('billingDuration');
    const billingDurationText = bdSel.selectedIndex > 0
      ? bdSel.options[bdSel.selectedIndex].textContent.trim()
      : '';

    chrome.tabs.sendMessage(
      tab.id,
      { action: 'startDownload', data: { financialYear, billingPeriod, billingDuration, billingDurationText } },
      response => {
        if (chrome.runtime.lastError) {
          showStatus('Error: ' + chrome.runtime.lastError.message + ' — Make sure you are on the Water Bill portal.', 'error');
          downloadBtn.disabled = false;
          return;
        }
        if (response && response.success) {
          showStatus('Automation started! File will download to the WaterBills folder.', 'success');
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
document.getElementById('refreshBtn').addEventListener('click', () => loadOptions(true));

/* ────────────────────────────────────────
   Init
──────────────────────────────────────── */
bindChangeListeners();
loadOptions(true);
