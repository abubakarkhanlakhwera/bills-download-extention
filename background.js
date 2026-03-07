let panelWindowId = null;
const PANEL_WIDTH = 640;
const PANEL_HEIGHT = 820;
let billingDownloadCounter = 0;
let lastBillingDownloadAt = 0;
let activeAutomationTabId = null;

function isBillingUrl(value) {
  const text = String(value || "").toLowerCase();
  return text.includes("elgcd.punjab.gov.pk");
}

function isWaterBillsFileName(value) {
  return /[\\/]WaterBills[\\/]/i.test(String(value || ""));
}

function cleanupOldWaterBillsFiles(keepId) {
  chrome.downloads.search({ filenameRegex: "[\\\\/]WaterBills[\\\\/].*" }, (items) => {
    for (const item of items || []) {
      if (!item || item.id === keepId || item.state !== "complete") {
        continue;
      }

      chrome.downloads.removeFile(item.id, () => {
        // Ignore file deletion errors (file may already be missing/locked).
      });
      chrome.downloads.erase({ id: item.id }, () => {
        // Keep history clean and leave only the latest file entry.
      });
    }
  });
}

function openOrFocusPanel() {
  const panelUrl = chrome.runtime.getURL("panel.html");

  if (typeof panelWindowId === "number") {
    chrome.windows.get(panelWindowId, {}, (existingWindow) => {
      if (chrome.runtime.lastError || !existingWindow) {
        panelWindowId = null;
        openOrFocusPanel();
        return;
      }

      chrome.windows.update(panelWindowId, { focused: true, width: PANEL_WIDTH, height: PANEL_HEIGHT });
    });
    return;
  }

  chrome.windows.create(
    {
      url: panelUrl,
      type: "popup",
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      focused: true
    },
    (newWindow) => {
      if (!newWindow || typeof newWindow.id !== "number") {
        return;
      }
      panelWindowId = newWindow.id;
    }
  );
}

chrome.action.onClicked.addListener(() => {
  openOrFocusPanel();
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === panelWindowId) {
    panelWindowId = null;
  }
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const url = String(item.finalUrl || item.url || "").toLowerCase();
  const referrer = String(item.referrer || "").toLowerCase();
  const filename = item.filename || "";
  const isBillingDownload =
    (typeof item.tabId === "number" && item.tabId === activeAutomationTabId) ||
    url.includes("elgcd.punjab.gov.pk") ||
    referrer.includes("elgcd.punjab.gov.pk/e-billing/water-bill-list");

  if (!isBillingDownload) {
    suggest();
    return;
  }

  const safeName = filename.split(/[\\/]/).pop() || `water-bills-${Date.now()}.xlsx`;
  const dot = safeName.lastIndexOf(".");
  const base = dot > 0 ? safeName.slice(0, dot) : safeName;
  const ext = dot > 0 ? safeName.slice(dot) : ".xlsx";

  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yy = String(now.getFullYear()).slice(-2);
  const datePart = `${dd}-${mm}-${yy}`;

  suggest({
    filename: `WaterBills/${datePart}_${base}${ext}`,
    conflictAction: "overwrite"
  });
});

chrome.downloads.onCreated.addListener((item) => {
  const fromAutomationTab = typeof item.tabId === "number" && item.tabId === activeAutomationTabId;
  if (fromAutomationTab || isBillingUrl(item.finalUrl) || isBillingUrl(item.url) || isBillingUrl(item.referrer)) {
    billingDownloadCounter += 1;
    lastBillingDownloadAt = Date.now();
  }
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta || typeof delta.id !== "number" || !delta.state || delta.state.current !== "complete") {
    return;
  }

  chrome.downloads.search({ id: delta.id }, (items) => {
    const item = items && items[0];
    if (!item || !isWaterBillsFileName(item.filename)) {
      return;
    }

    cleanupOldWaterBillsFiles(item.id);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "REAL_CLICK_EXPORT") {
    const tabId = _sender && _sender.tab && _sender.tab.id;
    const x = Number(message.x);
    const y = Number(message.y);

    if (typeof tabId !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
      sendResponse({ ok: false, reason: "Invalid tab or coordinates for native click." });
      return false;
    }

    const target = { tabId };
    chrome.debugger.attach(target, "1.3", () => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, reason: chrome.runtime.lastError.message || "Debugger attach failed." });
        return;
      }

      const finish = (result) => {
        chrome.debugger.detach(target, () => {
          sendResponse(result);
        });
      };

      chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "left",
        clickCount: 1
      }, () => {
        if (chrome.runtime.lastError) {
          finish({ ok: false, reason: chrome.runtime.lastError.message || "mouseMoved failed." });
          return;
        }

        chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button: "left",
          clickCount: 1
        }, () => {
          if (chrome.runtime.lastError) {
            finish({ ok: false, reason: chrome.runtime.lastError.message || "mousePressed failed." });
            return;
          }

          chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x,
            y,
            button: "left",
            clickCount: 1
          }, () => {
            if (chrome.runtime.lastError) {
              finish({ ok: false, reason: chrome.runtime.lastError.message || "mouseReleased failed." });
              return;
            }

            finish({ ok: true });
          });
        });
      });
    });

    return true;
  }

  if (message.type === "SET_AUTOMATION_TAB") {
    activeAutomationTabId = typeof message.tabId === "number" ? message.tabId : null;
    sendResponse({ ok: true, activeAutomationTabId });
    return false;
  }

  if (message.type === "CLEAR_AUTOMATION_TAB") {
    activeAutomationTabId = null;
    sendResponse({ ok: true });
    return false;
  }

  if (message.type !== "GET_BILLING_DOWNLOAD_COUNTER") {
    return false;
  }

  sendResponse({
    ok: true,
    counter: billingDownloadCounter,
    lastAt: lastBillingDownloadAt,
    activeAutomationTabId
  });
  return false;
});

