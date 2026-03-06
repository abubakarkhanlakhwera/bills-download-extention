/**
 * content.js – Water Bill Downloader
 *
 * Injected into every page. Listens for two messages from popup.js:
 *
 *  • { action: 'getDropdownOptions' }
 *      → Reads the Financial Year / Billing Period / Billing Duration
 *        <select> elements on the page and returns their option lists.
 *
 *  • { action: 'startDownload', data: { financialYear, billingPeriod, billingDuration } }
 *      → Automates the full workflow:
 *          1. Set Financial Year
 *          2. Set Billing Period
 *          3. Set Billing Duration
 *          4. Click "List Bill"
 *          5. Wait for the results table (3.5 s)
 *          6. Click "Export Bills"
 */

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
    const label = (el.textContent || el.value || el.getAttribute('aria-label') || '').toLowerCase();
    if (label.includes(t)) return el;
  }
  return null;
}

/**
 * Set a <select>'s value and fire the change/input events so that any
 * framework listeners (Vue, Angular, plain JS) react correctly.
 */
function setSelectValue(select, value) {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  select.dispatchEvent(new Event('input',  { bubbles: true }));
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
async function automateDownload(financialYear, billingPeriod, billingDuration) {

  /* ── Step 1: Financial Year ── */
  const fySelect = findSelectByKeyword('financial year');
  if (!fySelect) throw new Error('Financial Year dropdown not found on this page.');
  setSelectValue(fySelect, financialYear);
  await delay(600);

  /* ── Step 2: Billing Period ──
     Some portals reload Billing Period options after FY change via AJAX.
     Wait up to 6 s for at least one real option to appear, then set. */
  const bpSelect = findSelectByKeyword('billing period');
  if (!bpSelect) throw new Error('Billing Period dropdown not found on this page.');
  await waitFor(() => bpSelect.options.length > 1, 6000).catch(() => {/* proceed anyway */});
  setSelectValue(bpSelect, billingPeriod);
  await delay(600);

  /* ── Step 3: Billing Duration ──
     Same AJAX pattern possible. */
  const bdSelect = findSelectByKeyword('billing duration');
  if (!bdSelect) throw new Error('Billing Duration dropdown not found on this page.');
  await waitFor(() => bdSelect.options.length > 1, 6000).catch(() => {/* proceed anyway */});
  setSelectValue(bdSelect, billingDuration);
  await delay(600);

  /* ── Step 4: Click "List Bill" ── */
  const listBtn = findButtonByText('list bill');
  if (!listBtn) throw new Error('"List Bill" button not found on this page.');
  listBtn.click();

  /* ── Step 5: Wait for the results table to appear (up to 15 s) ──
     We look for a <table> or any element with class/id hinting at results.
     Fallback: just wait 4 s. */
  let tableFound = false;
  try {
    await waitFor(() => {
      // Common patterns: a <table> with more than the header row,
      // or a container that wasn't there before.
      const tables = document.querySelectorAll('table');
      for (const tbl of tables) {
        if (tbl.rows.length > 1) { tableFound = true; return true; }
      }
      return false;
    }, 15000);
  } catch {
    // Table didn't appear – still try to click Export after base delay
    await delay(4000);
  }

  if (tableFound) {
    // A little extra buffer to ensure the Export button has rendered
    await delay(1000);
  }

  /* ── Step 6: Tell background to tag the next download ── */
  chrome.runtime.sendMessage({ action: 'prepareDownload' });

  /* ── Step 7: Click "Export Bills" ──
     The button may only exist after the table loads, so poll for it. */
  let exportBtn = null;
  try {
    await waitFor(() => {
      // Try several common label variants
      exportBtn = findButtonByText('export bills')
               || findButtonByText('export bill')
               || findButtonByText('export');
      return exportBtn !== null;
    }, 12000);
  } catch {
    throw new Error(
      '"Export Bills" button not found. ' +
      'The table may not have loaded — try increasing the wait time or check the page manually.'
    );
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
    const { financialYear, billingPeriod, billingDuration } = message.data || {};

    // Respond immediately so the popup doesn't hang waiting
    sendResponse({ success: true });

    // Run automation independently in the background
    automateDownload(financialYear, billingPeriod, billingDuration)
      .catch(err => {
        console.error('[WaterBillDownloader] Automation error:', err.message);
        // Attempt to surface the error via the background (badge / notification)
        chrome.runtime.sendMessage({ action: 'automationError', error: err.message });
      });

    return false; // No further async response needed
  }
});
