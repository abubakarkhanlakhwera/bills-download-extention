(() => {
  if (window.__waterBillSaverInitialized) {
    return;
  }
  window.__waterBillSaverInitialized = true;

  const STORAGE_KEY = "waterBillFirstThreeDropdowns";
  const EXPORT_WAIT_MS = 15000;
  const EXPORT_RETRY_MS = 1000;
  const EXPORT_MAX_RETRIES = 40;
  const EXPORT_DOWNLOAD_CONFIRM_MS = 3000;
  const LIST_BILL_STATE = {
    isRunning: false,
    timerId: null,
    runId: null,
    startedAt: null,
    listClickCount: 0,
    exportClickCount: 0,
    lastListClickAt: null,
    lastExportClickAt: null,
    intervalMs: 0,
    nextClickAt: null,
    phase: "idle",
    lastError: null
  };

  const TARGET_LABELS = ["Financial Year", "Billing Period", "Billing Duration"];

  function safeCssEscape(value) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }

    return String(value).replace(/([#.;?+*~\':"!^$\[\]()=>|/\\@])/g, "\\$1");
  }

  function getOptionData(selectEl) {
    return Array.from(selectEl.options).map((option) => ({
      value: option.value,
      text: option.text.trim()
    }));
  }

  function getSelectedFromNativeSelect(selectEl) {
    const selectedOption = selectEl.selectedOptions && selectEl.selectedOptions[0];
    return {
      value: selectEl.value || "",
      text: selectedOption ? (selectedOption.text || "").trim() : ""
    };
  }

  function getSelectedFromEnhancedUi(selectEl) {
    if (!selectEl.id) {
      return "";
    }

    const selector = `button[data-id="${safeCssEscape(selectEl.id)}"] .filter-option-inner-inner`;
    const uiNode = document.querySelector(selector);
    return uiNode ? uiNode.textContent.trim() : "";
  }

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function findSelectForLabel(labelText) {
    const wanted = normalize(labelText);
    const labels = Array.from(document.querySelectorAll("label"));

    const matchingLabel = labels.find((label) => normalize(label.textContent).includes(wanted));
    if (!matchingLabel) {
      return null;
    }

    const forId = matchingLabel.getAttribute("for");
    if (forId) {
      const byFor = document.getElementById(forId);
      if (byFor && byFor.tagName === "SELECT") {
        return byFor;
      }
    }

    const inContainer = matchingLabel.closest("div")?.querySelector("select");
    if (inContainer) {
      return inContainer;
    }

    const siblingSelect = matchingLabel.parentElement?.querySelector("select");
    return siblingSelect || null;
  }

  function getTargetSelects() {
    const matched = TARGET_LABELS.map((label) => findSelectForLabel(label));
    if (matched.every(Boolean)) {
      return matched;
    }

    // Fallback in case labels are changed in a future page update.
    return Array.from(document.querySelectorAll("select")).slice(0, 3);
  }

  function hasUsefulOptions(selectEl) {
    return Boolean(selectEl?.options && selectEl.options.length > 0);
  }

  function buildPayload(selects) {
    return {
      savedAt: new Date().toISOString(),
      page: window.location.href,
      dropdowns: selects.map((selectEl, index) => ({
        ...(() => {
          const nativeSelected = getSelectedFromNativeSelect(selectEl);
          const uiSelectedText = getSelectedFromEnhancedUi(selectEl);
          return {
            selectedValue: nativeSelected.value,
            selectedText: uiSelectedText || nativeSelected.text
          };
        })(),
        index: index + 1,
        label: TARGET_LABELS[index] || `Dropdown ${index + 1}`,
        id: selectEl.id || null,
        name: selectEl.name || null,
        optionCount: selectEl.options ? selectEl.options.length : 0,
        options: getOptionData(selectEl)
      }))
    };
  }

  function extractPayloadIfReady() {
    const selects = getTargetSelects();
    if (selects.length < 3 || !selects.every(hasUsefulOptions)) {
      return null;
    }

    return buildPayload(selects);
  }

  function isMeaningfulPayload(payload) {
    if (!payload || !Array.isArray(payload.dropdowns)) {
      return false;
    }

    return payload.dropdowns.some((dropdown) => {
      const selectedText = normalize(dropdown.selectedText);
      const hasSelected = selectedText && !selectedText.startsWith("select ");

      const hasNonPlaceholderOption = (dropdown.options || []).some((opt) => {
        const text = normalize(opt.text);
        const value = normalize(opt.value);
        return Boolean(value) || (text && !text.startsWith("select "));
      });

      return hasSelected || hasNonPlaceholderOption;
    });
  }

  function savePayload({ overwrite }, onDone) {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      const existing = result[STORAGE_KEY];
      if (existing && !overwrite) {
        console.log("[Water Bill Dropdown Saver] Already saved. Skipping.");
        if (onDone) {
          onDone({ ok: true, alreadySaved: true, payload: existing });
        }
        return;
      }

      const payload = extractPayloadIfReady();
      if (!payload) {
        if (onDone) {
          onDone({
            ok: false,
            reason: "Could not find all three dropdowns with loaded options yet."
          });
        }
        return;
      }

      if (!isMeaningfulPayload(payload)) {
        if (onDone) {
          onDone({
            ok: false,
            reason: "Dropdown data is still placeholder-only. Select values first, then Save Now."
          });
        }
        return;
      }

      chrome.storage.local.set({ [STORAGE_KEY]: payload }, () => {
        console.log("[Water Bill Dropdown Saver] Dropdown data saved.", payload);
        if (onDone) {
          onDone({ ok: true, alreadySaved: false, overwritten: Boolean(existing && overwrite), payload });
        }
      });
    });
  }

  function trySaveFirstTime(onDone) {
    savePayload({ overwrite: false }, onDone);
  }

  function forceSaveNow(sendResponse) {
    savePayload({ overwrite: true }, (result) => {
      if (sendResponse) {
        sendResponse(result);
      }
    });
  }

  function findListBillButton() {
    const clickable = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit'], a"));
    return clickable.find((el) => {
      const label = normalize(el.textContent || el.value || "");
      return label === "list bill" || label.includes("list bill");
    }) || null;
  }

  function clickListBillOnce() {
    const button = findListBillButton();
    if (!button) {
      return { ok: false, reason: "List Bill button not found on page." };
    }

    button.click();
    return { ok: true };
  }

  function findExportButton() {
    function isVisible(el) {
      if (!el) {
        return false;
      }
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    const selectors = [
      ".tbl-handles button[mattooltip*='Export Bills' i]",
      ".tbl-handles button[title*='Export Bills' i]",
      ".tbl-handles button[aria-label*='Export Bills' i]",
      ".tbl-handles button .fa-download",
      "button[mattooltip*='Export Bills' i]",
      "button[title*='Export Bills' i]",
      "button[aria-label*='Export Bills' i]",
      "button .fa-download"
    ];

    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const node of nodes) {
        const button = node.tagName === "BUTTON" ? node : node.closest("button");
        if (button && isVisible(button)) {
          return button;
        }
      }
    }

    const buttons = Array.from(document.querySelectorAll("button"));
    return buttons.find((button) => {
      const label = normalize(button.textContent || "");
      return isVisible(button) && label.includes("export") && label.includes("bill");
    }) || null;
  }

  function clickExportOnce() {
    const button = findExportButton();
    if (!button) {
      return { ok: false, reason: "Export Bills button not found on page." };
    }

    const isDisabled =
      button.disabled ||
      button.getAttribute("aria-disabled") === "true" ||
      normalize(button.className).includes("disabled");
    if (isDisabled) {
      return { ok: false, reason: "Export Bills button is disabled (table may still be loading)." };
    }

    button.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    button.focus();

    const rect = button.getBoundingClientRect();
    const clickX = Math.max(1, Math.round(rect.left + rect.width / 2));
    const clickY = Math.max(1, Math.round(rect.top + rect.height / 2));

    chrome.runtime.sendMessage({ type: "REAL_CLICK_EXPORT", x: clickX, y: clickY }, () => {
      // Best-effort trusted click. Synthetic fallback below still executes.
    });

    try {
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, composed: true }));
      button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, composed: true }));
    } catch (_err) {
      // PointerEvent may be unavailable in older contexts; fallback below still runs.
    }

    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view: window }));
    button.click();
    return { ok: true };
  }

  function getBillingDownloadCounter(callback) {
    chrome.runtime.sendMessage({ type: "GET_BILLING_DOWNLOAD_COUNTER" }, (response) => {
      if (chrome.runtime.lastError || !response || !response.ok) {
        callback({ ok: false, counter: 0 });
        return;
      }

      callback({ ok: true, counter: Number(response.counter) || 0 });
    });
  }

  function stopListBillRun() {
    if (LIST_BILL_STATE.timerId) {
      clearTimeout(LIST_BILL_STATE.timerId);
    }

    LIST_BILL_STATE.isRunning = false;
    LIST_BILL_STATE.timerId = null;
    LIST_BILL_STATE.runId = null;
    LIST_BILL_STATE.nextClickAt = null;
    LIST_BILL_STATE.phase = "idle";
  }

  function getListBillStatus() {
    const now = Date.now();
    const runSeconds = LIST_BILL_STATE.startedAt ? Math.floor((now - LIST_BILL_STATE.startedAt) / 1000) : 0;
    const listSecondsSinceLast = LIST_BILL_STATE.lastListClickAt
      ? Math.floor((now - LIST_BILL_STATE.lastListClickAt) / 1000)
      : -1;
    const exportSecondsSinceLast = LIST_BILL_STATE.lastExportClickAt
      ? Math.floor((now - LIST_BILL_STATE.lastExportClickAt) / 1000)
      : -1;

    return {
      ok: true,
      isRunning: LIST_BILL_STATE.isRunning,
      listClickCount: LIST_BILL_STATE.listClickCount,
      exportClickCount: LIST_BILL_STATE.exportClickCount,
      runSeconds,
      listSecondsSinceLast,
      exportSecondsSinceLast,
      intervalMs: LIST_BILL_STATE.intervalMs,
      nextClickAt: LIST_BILL_STATE.nextClickAt,
      phase: LIST_BILL_STATE.phase,
      exportWaitMs: EXPORT_WAIT_MS,
      lastError: LIST_BILL_STATE.lastError
    };
  }

  function runListBillRepeatedly(message, sendResponse) {
    const intervalMs = Math.max(1, Math.min(24 * 60 * 60 * 1000, Number(message.intervalMs) || 1500));

    if (LIST_BILL_STATE.isRunning) {
      sendResponse({ ok: false, reason: "List Bill run already in progress. Click Stop first." });
      return;
    }

    const runId = Date.now();
    LIST_BILL_STATE.isRunning = true;
    LIST_BILL_STATE.runId = runId;
    LIST_BILL_STATE.startedAt = Date.now();
    LIST_BILL_STATE.listClickCount = 0;
    LIST_BILL_STATE.exportClickCount = 0;
    LIST_BILL_STATE.lastListClickAt = null;
    LIST_BILL_STATE.lastExportClickAt = null;
    LIST_BILL_STATE.intervalMs = intervalMs;
    LIST_BILL_STATE.nextClickAt = null;
    LIST_BILL_STATE.phase = "starting";
    LIST_BILL_STATE.lastError = null;

    const scheduleNextCycle = () => {
      LIST_BILL_STATE.phase = "waiting-next-cycle";
      LIST_BILL_STATE.nextClickAt = Date.now() + intervalMs;
      LIST_BILL_STATE.timerId = setTimeout(step, intervalMs);
    };

    const scheduleExportStep = () => {
      LIST_BILL_STATE.phase = "waiting-export";
      LIST_BILL_STATE.nextClickAt = Date.now() + EXPORT_WAIT_MS;
      LIST_BILL_STATE.timerId = setTimeout(() => {
        if (!LIST_BILL_STATE.isRunning || LIST_BILL_STATE.runId !== runId) {
          return;
        }

        let exportAttempt = 0;
        const tryExport = () => {
          if (!LIST_BILL_STATE.isRunning || LIST_BILL_STATE.runId !== runId) {
            return;
          }

          LIST_BILL_STATE.phase = "clicking-export";
          LIST_BILL_STATE.nextClickAt = null;

          getBillingDownloadCounter((before) => {
            if (!LIST_BILL_STATE.isRunning || LIST_BILL_STATE.runId !== runId) {
              return;
            }

            const exportResult = clickExportOnce();
            if (!exportResult.ok) {
              exportAttempt += 1;
              if (exportAttempt >= EXPORT_MAX_RETRIES) {
                LIST_BILL_STATE.lastError = `${exportResult.reason} (retried ${EXPORT_MAX_RETRIES} times)`;
                stopListBillRun();
                return;
              }

              LIST_BILL_STATE.phase = "waiting-export";
              LIST_BILL_STATE.nextClickAt = Date.now() + EXPORT_RETRY_MS;
              LIST_BILL_STATE.timerId = setTimeout(tryExport, EXPORT_RETRY_MS);
              return;
            }

            LIST_BILL_STATE.phase = "confirming-download";
            LIST_BILL_STATE.nextClickAt = Date.now() + EXPORT_DOWNLOAD_CONFIRM_MS;
            LIST_BILL_STATE.timerId = setTimeout(() => {
              if (!LIST_BILL_STATE.isRunning || LIST_BILL_STATE.runId !== runId) {
                return;
              }

              getBillingDownloadCounter((after) => {
                if (!LIST_BILL_STATE.isRunning || LIST_BILL_STATE.runId !== runId) {
                  return;
                }

                const beforeCount = before.ok ? before.counter : 0;
                const afterCount = after.ok ? after.counter : 0;
                if (afterCount > beforeCount) {
                  LIST_BILL_STATE.exportClickCount += 1;
                  LIST_BILL_STATE.lastExportClickAt = Date.now();
                  scheduleNextCycle();
                  return;
                }

                exportAttempt += 1;
                if (exportAttempt >= EXPORT_MAX_RETRIES) {
                  LIST_BILL_STATE.lastError = "Export click did not start any download.";
                  stopListBillRun();
                  return;
                }

                LIST_BILL_STATE.phase = "waiting-export";
                LIST_BILL_STATE.nextClickAt = Date.now() + EXPORT_RETRY_MS;
                LIST_BILL_STATE.timerId = setTimeout(tryExport, EXPORT_RETRY_MS);
              });
            }, EXPORT_DOWNLOAD_CONFIRM_MS);
          });
        };

        tryExport();
      }, EXPORT_WAIT_MS);
    };

    const step = () => {
      if (!LIST_BILL_STATE.isRunning || LIST_BILL_STATE.runId !== runId) {
        return;
      }

      LIST_BILL_STATE.phase = "clicking-list-bill";
      LIST_BILL_STATE.nextClickAt = null;

      const clickResult = clickListBillOnce();
      if (!clickResult.ok) {
        LIST_BILL_STATE.lastError = clickResult.reason;
        stopListBillRun();
        return;
      }

      LIST_BILL_STATE.listClickCount += 1;
      LIST_BILL_STATE.lastListClickAt = Date.now();
      scheduleExportStep();
    };

    LIST_BILL_STATE.phase = "starting";
    LIST_BILL_STATE.nextClickAt = Date.now();
    step();
    sendResponse({
      ok: true,
      started: true,
      intervalMs,
      listClickedInitial: LIST_BILL_STATE.listClickCount,
      exportWaitMs: EXPORT_WAIT_MS
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      if (!message || !message.type) {
        return false;
      }

      if (message.type === "EXTRACT_AND_SAVE") {
        if (message.force) {
          forceSaveNow(sendResponse);
        } else {
          trySaveFirstTime(sendResponse);
        }
        return true;
      }

      if (message.type === "RUN_LIST_BILL") {
        runListBillRepeatedly(message, sendResponse);
        return true;
      }

      if (message.type === "STOP_LIST_BILL") {
        const wasRunning = LIST_BILL_STATE.isRunning;
        const listClickCount = LIST_BILL_STATE.listClickCount;
        const exportClickCount = LIST_BILL_STATE.exportClickCount;
        stopListBillRun();
        sendResponse({ ok: true, stopped: true, wasRunning, listClickCount, exportClickCount });
        return false;
      }

      if (message.type === "GET_LIST_BILL_STATUS") {
        sendResponse(getListBillStatus());
        return false;
      }

      return false;
    } catch (error) {
      sendResponse({
        ok: false,
        reason: `Unexpected error: ${error && error.message ? error.message : String(error)}`
      });
      return false;
    }
  });

  // Some dropdowns are populated after page load, so retry briefly.
  function runWithRetry(maxRetries = 20, intervalMs = 500) {
    let retries = 0;
    const timer = setInterval(() => {
      retries += 1;

      chrome.storage.local.get([STORAGE_KEY], (result) => {
        if (result[STORAGE_KEY]) {
          clearInterval(timer);
          return;
        }

        const ready = Boolean(extractPayloadIfReady());

        if (ready) {
          clearInterval(timer);
          trySaveFirstTime();
          return;
        }

        if (retries >= maxRetries) {
          clearInterval(timer);
          console.warn("[Water Bill Dropdown Saver] Dropdowns were not ready in time.");
        }
      });
    }, intervalMs);
  }

  runWithRetry();
})();
