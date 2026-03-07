/**
 * content.js – Water Bill Downloader
 *
 * Injected on demand (and also via manifest). The guard at the top
 * prevents duplicate listener registration if injected more than once.
 *
 * Listens for two messages from popup.js:
 *
 *  • { action: 'getDropdownOptions' }  (legacy – now handled inline)
 *  • { action: 'startDownload', data: { financialYear, billingPeriod, billingDuration } }
 *      → Automates the full workflow:
 *          1. Set Financial Year
 *          2. Set Billing Period
 *          3. Set Billing Duration
 *          4. Click "List Bill"
 *          5. Wait for the results table
 *          6. Click "Export Bills"
 */

// ── Guard: skip re-registration if already injected ──────────────────────────
if (window.__waterBillExtensionLoaded) {
  // Already running – nothing to do.
} else {
window.__waterBillExtensionLoaded = true;

/* ════════════════════════════════════════
   DOM helpers
════════════════════════════════════════ */

/**
 * Find a <select> whose first placeholder option text contains `keyword`.
 * Also falls back to finding a <label> whose text contains `keyword`
 * and then locating the nearest <select>.
 */
function findSelectByKeyword(keyword) {
  const kw = keyword.toLowerCase();

  // Primary: match placeholder option text  (e.g. "Select Financial Year")
  for (const sel of document.querySelectorAll('select')) {
    if (sel.options.length > 0 && sel.options[0].text.toLowerCase().includes(kw)) {
      return sel;
    }
  }

  // Fallback: label text → associated select
  for (const label of document.querySelectorAll('label')) {
    if (label.textContent.toLowerCase().includes(kw)) {
      // Explicit `for` attribute
      const forId = label.getAttribute('for');
      if (forId) {
        const sel = document.getElementById(forId);
        if (sel && sel.tagName === 'SELECT') return sel;
      }
      // Child select
      const child = label.querySelector('select');
      if (child) return child;
      // Sibling/cousin select inside the same parent container
      const container = label.closest('div, td, th, li, span') || label.parentElement;
      if (container) {
        const nearby = container.querySelector('select');
        if (nearby) return nearby;
      }
    }
  }

  return null;
}

/**
 * Find a clickable element (button / anchor / input) whose visible text
 * contains `text` (case-insensitive).
 */
function findButtonByText(text) {
  const t = text.toLowerCase();
  const candidates = document.querySelectorAll(
    'button, input[type="button"], input[type="submit"], a[href], [role="button"]'
  );
  for (const el of candidates) {
    const label = (
      el.textContent ||
      el.value ||
      el.getAttribute('aria-label') ||
      el.getAttribute('mattooltip') ||
      el.getAttribute('title') ||
      ''
    ).toLowerCase();
    if (label.includes(t)) return el;
  }
  return null;
}

/**
 * Set a <select>'s value in a way that Angular / React / Vue all pick up.
 * Using the native HTMLSelectElement property setter bypasses framework
 * wrappers so the synthetic 'change' event is treated as a real user action.
 */
function setSelectValue(select, value) {
  // Native setter trick – required for Angular ngModel two-way binding
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype, 'value'
  ).set;
  nativeSetter.call(select, value);
  select.dispatchEvent(new Event('input',  { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Poll until `condition()` is truthy, or reject after `timeout` ms.
 */
function waitFor(condition, timeout = 8000, interval = 250) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    (function check() {
      if (condition()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('Timeout waiting for condition.'));
      setTimeout(check, interval);
    })();
  });
}

/** Simple delay in milliseconds. */
const delay = ms => new Promise(r => setTimeout(r, ms));

/* ════════════════════════════════════════
   Read options from a <select>
════════════════════════════════════════ */
function readOptions(select) {
  if (!select) return [];
  // Skip the first placeholder option (index 0)
  return Array.from(select.options).slice(1).map(o => ({
    value: o.value,
    text:  o.text.trim(),
  }));
}

/* ════════════════════════════════════════
   Automation
════════════════════════════════════════ */
async function automateDownload(financialYear, billingPeriod, billingDuration, billingDurationText) {

  /* ── Step 1: Financial Year ── */
  const fySelect = findSelectByKeyword('financial year');
  if (!fySelect) throw new Error('Financial Year dropdown not found on this page.');
  setSelectValue(fySelect, financialYear);
  // Wait 1 s — Angular clears BP/BD after FY change
  await delay(1000);

  /* ── Step 2: Billing Period ── */
  const bpSelect = findSelectByKeyword('billing period');
  if (!bpSelect) throw new Error('Billing Period dropdown not found on this page.');
  await waitFor(() => bpSelect.options.length > 1, 5000).catch(() => {});
  setSelectValue(bpSelect, billingPeriod);
  // Give Angular 800 ms to clear BD before polling for its AJAX reload
  await delay(800);

  /* ── Step 3: Billing Duration (AJAX-loaded after BP change) ── */
  const bdSelect = findSelectByKeyword('billing duration');
  if (!bdSelect) throw new Error('Billing Duration dropdown not found on this page.');

  // Wait up to 12 s for BD options to load via AJAX
  await waitFor(() => bdSelect.options.length > 1, 12000).catch(() => {});

  if (bdSelect.options.length <= 1) {
    throw new Error('Billing Duration options did not load — AJAX may have timed out.');
  }

  // ── NEW: match by visible text (Angular re-generates value indices each render) ──
  const normalise = s => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const targetText = normalise(billingDurationText);

  let matchedIndex = -1;
  for (let i = 1; i < bdSelect.options.length; i++) {
    if (normalise(bdSelect.options[i].text) === targetText) {
      matchedIndex = i;
      break;
    }
  }

  // Fallback: also try matching by saved value string in case it hasn't changed
  if (matchedIndex === -1) {
    for (let i = 1; i < bdSelect.options.length; i++) {
      if (bdSelect.options[i].value === billingDuration) {
        matchedIndex = i;
        break;
      }
    }
  }

  if (matchedIndex === -1) {
    const available = Array.from(bdSelect.options).slice(1).map(o => o.text).join(' | ');
    throw new Error(
      `Billing Duration "${billingDurationText || billingDuration}" not found. ` +
      `Available: ${available}`
    );
  }

  // Select by index — Angular always honours selectedIndex changes
  bdSelect.selectedIndex = matchedIndex;
  bdSelect.dispatchEvent(new Event('input',  { bubbles: true }));
  bdSelect.dispatchEvent(new Event('change', { bubbles: true }));
  await delay(500);

  /* ── Step 4: Click "List Bill" ── */
  const listBtn = findButtonByText('list bill');
  if (!listBtn) throw new Error('"List Bill" button not found on this page.');
  listBtn.click();
  // Mandatory pause: let the portal clear the old table before we start polling.
  // Without this, the old loaded table satisfies rows>1 immediately.
  await delay(2000);

  /* ── Step 5: Wait for the results table (up to 15 s) ── */
  let tableFound = false;
  try {
    await waitFor(() => {
      const tables = document.querySelectorAll('table');
      for (const tbl of tables) {
        if (tbl.rows.length > 1) { tableFound = true; return true; }
      }
      return false;
    }, 15000);
  } catch {
    await delay(4000);
  }

  if (tableFound) await delay(1000);

  /* ── Step 6: Tag next download ── */
  chrome.runtime.sendMessage({ action: 'prepareDownload' });

  /* ── Step 7: Click "Export Bills" ── */
  let exportBtn = null;
  try {
    await waitFor(() => {
      exportBtn = findButtonByText('export bills')
               || findButtonByText('export bill')
               || document.querySelector('button[mattooltip*="Export"]')
               || document.querySelector('button[title*="Export"]')
               || findButtonByText('export');
      return exportBtn !== null;
    }, 12000);
  } catch {
    throw new Error('"Export Bills" button not found. The table may not have loaded.');
  }

  exportBtn.click();
}

/* ════════════════════════════════════════
   Message listener
════════════════════════════════════════ */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  /* ── Get dropdown options ── */
  if (message.action === 'getDropdownOptions') {
    const fySelect = findSelectByKeyword('financial year');
    const bpSelect = findSelectByKeyword('billing period');
    const bdSelect = findSelectByKeyword('billing duration');

    if (!fySelect && !bpSelect && !bdSelect) {
      sendResponse({ success: false, error: 'No water bill dropdowns found on this page.' });
      return true;
    }

    sendResponse({
      success: true,
      options: {
        financialYear:  readOptions(fySelect),
        billingPeriod:  readOptions(bpSelect),
        billingDuration: readOptions(bdSelect),
      },
    });
    return true;
  }

  /* ── Start download automation ── */
  if (message.action === 'startDownload') {
    const { financialYear, billingPeriod, billingDuration, billingDurationText } = message.data || {};

    // Respond immediately so the popup doesn't hang waiting
    sendResponse({ success: true });

    // Run automation independently in the background
    automateDownload(financialYear, billingPeriod, billingDuration, billingDurationText)
      .catch(err => {
        console.error('[WaterBillDownloader] Automation error:', err.message);
        chrome.runtime.sendMessage({ action: 'automationError', error: err.message });
      });

    return false;
  }
});

} // end of window.__waterBillExtensionLoaded guard
