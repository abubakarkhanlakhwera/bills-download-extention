# Water Bill Dropdown Saver (Step 1)

This extension extracts data from the first three dropdowns on:

`https://elgcd.punjab.gov.pk/e-billing/water-bill-list`

It saves the data **only once** in `chrome.storage.local` under key:

`waterBillFirstThreeDropdowns`

It also shows this saved data in a persistent extension panel window.

## Files

- `manifest.json`
- `content.js`
- `popup.html`
- `popup.css`
- `popup.js`
- `panel.html`
- `background.js`
- `icons/icon16.png`
- `icons/icon48.png`
- `icons/icon128.png`

## How to test

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked**.
4. Select this folder:
   - `c:\Users\Rising\Downloads\bills download extention`
5. Open the target page:
   - `https://elgcd.punjab.gov.pk/e-billing/water-bill-list`
6. Wait a few seconds for dropdowns to load.
7. Open DevTools on that page and run:

```js
chrome.storage.local.get("waterBillFirstThreeDropdowns", console.log)
```

You should see saved dropdown data.

## Step 2: View in panel window

1. Go back to `chrome://extensions/`
2. Click the extension's refresh icon (reload the unpacked extension)
3. Click the extension icon in Chrome toolbar
4. A panel window will open and stay visible until you click `Close`
5. Panel shows:
   - Saved timestamp
   - Page URL
   - All options from dropdown 1, 2, and 3
   - Highlighted selected text and selected value

Use buttons in popup:

- `Refresh`: reload from storage
- `Clear Saved Data`: remove stored record

## Reset saved data (for re-test)

```js
chrome.storage.local.remove("waterBillFirstThreeDropdowns")
```
