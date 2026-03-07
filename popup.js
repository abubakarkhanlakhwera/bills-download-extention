(() => {
  const STORAGE_KEY = "waterBillFirstThreeDropdowns";

  const statusEl = document.getElementById("status");
  const contentEl = document.getElementById("content");
  const saveBtn = document.getElementById("saveBtn");
  const refreshBtn = document.getElementById("refreshBtn");
  const clearBtn = document.getElementById("clearBtn");
  const closeBtn = document.getElementById("closeBtn");
  const delayValueInput = document.getElementById("delayValue");
  const delayUnitSelect = document.getElementById("delayUnit");
  const runListBillBtn = document.getElementById("runListBillBtn");
  const stopListBillBtn = document.getElementById("stopListBillBtn");

  let statusPollTimer = null;

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function setStatus(message) {
    statusEl.textContent = message;
  }

  function renderEmptyState() {
    contentEl.innerHTML =
      '<div class="empty">No saved data yet. Open the billing page once and wait for dropdowns to load.</div>';
  }

  function formatSavedAt(value) {
    if (!value) {
      return "Unknown";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return String(value);
    }

    return date.toLocaleString();
  }

  function renderData(payload) {
    const headerCard = `
      <article class="card">
        <h2>Saved Snapshot</h2>
        <p class="meta"><strong>Saved at:</strong> ${escapeHtml(formatSavedAt(payload.savedAt))}</p>
        <p class="meta"><strong>Page:</strong> ${escapeHtml(payload.page || "Unknown")}</p>
      </article>
    `;

    const dropdownCards = (payload.dropdowns || []).map((dropdown) => {
      const title = dropdown.label || `Dropdown ${dropdown.index || "?"}`;
      const idValue = dropdown.id ? `#${dropdown.id}` : "(no id)";
      const nameValue = dropdown.name || "(no name)";
      const selectedText = dropdown.selectedText || "(not selected)";
      const selectedValue = dropdown.selectedValue || "(empty)";

      const normalizedSelectedText = String(selectedText).trim().toLowerCase();
      const normalizedSelectedValue = String(selectedValue).trim();

      const optionItems = (dropdown.options || [])
        .map((option) => {
          const rawText = option.text || "";
          const rawValue = option.value || "";
          const text = escapeHtml(rawText);
          const value = escapeHtml(rawValue);

          const isSelectedByValue = String(rawValue).trim() === normalizedSelectedValue;
          const isSelectedByText = String(rawText).trim().toLowerCase() === normalizedSelectedText;
          const selectedAttr = (isSelectedByValue || isSelectedByText) ? " selected" : "";

          return `<option value="${value}"${selectedAttr}>${text} (${value || "empty"})</option>`;
        })
        .join("");

      const optionsCount = (dropdown.options || []).length;

      return `
        <article class="card">
          <h2>${escapeHtml(title)}</h2>
          <p class="meta"><strong>id:</strong> ${escapeHtml(idValue)}</p>
          <p class="meta"><strong>name:</strong> ${escapeHtml(nameValue)}</p>
          <p class="meta"><strong>selected text:</strong> <span class="selected-text">${escapeHtml(selectedText)}</span></p>
          <p class="meta"><strong>selected value:</strong> <span class="selected-value">${escapeHtml(selectedValue)}</span></p>
          <p class="meta"><strong>options:</strong> ${escapeHtml(optionsCount)}</p>
          <div class="options-wrap">
            <select class="options-select" size="4" disabled>
              ${optionItems || "<option>No options</option>"}
            </select>
          </div>
        </article>
      `;
    });

    contentEl.innerHTML = [headerCard, ...dropdownCards].join("");
  }

  function loadData() {
    setStatus("Loading...");

    chrome.storage.local.get([STORAGE_KEY], (result) => {
      const payload = result[STORAGE_KEY];

      if (!payload) {
        setStatus("No saved record found.");
        renderEmptyState();
        return;
      }

      setStatus("Saved record loaded.");
      renderData(payload);
    });
  }

  function sendSaveRequestToActiveTab() {
    setStatus("Saving from current page...");

    getTargetBillingTab((targetTab) => {
      if (!targetTab || typeof targetTab.id !== "number") {
        setStatus("Open the billing page tab first, then click Save Now.");
        return;
      }

      function handleSaveResponse(response) {
        if (!response || !response.ok) {
          const reason = (response && response.reason) || "Save failed.";
          setStatus(reason);
          return;
        }

        if (response.alreadySaved) {
          setStatus("Already saved earlier (first-time-only rule).");
        } else if (response.overwritten) {
          setStatus("Saved successfully (previous data replaced).");
        } else {
          setStatus("Saved successfully.");
        }

        loadData();
      }

      sendMessageWithInjectionFallback(targetTab.id, { type: "EXTRACT_AND_SAVE", force: true }, handleSaveResponse);
    });
  }

  function getTargetBillingTab(callback) {
    chrome.tabs.query(
      { url: ["https://elgcd.punjab.gov.pk/e-billing/water-bill-list*"] },
      (tabs) => {
        const targetTab = (tabs && tabs.find((tab) => tab.active)) || (tabs && tabs[0]);
        callback(targetTab || null);
      }
    );
  }

  function sendMessageWithInjectionFallback(targetTabId, message, onResult) {
    chrome.tabs.sendMessage(targetTabId, message, (response) => {
      if (!chrome.runtime.lastError) {
        onResult(response);
        return;
      }

      chrome.scripting.executeScript(
        {
          target: { tabId: targetTabId },
          files: ["content.js"]
        },
        () => {
          if (chrome.runtime.lastError) {
            onResult({ ok: false, reason: "Could not connect to page script. Reload target tab and try again." });
            return;
          }

          chrome.tabs.sendMessage(targetTabId, message, (retryResponse) => {
            if (chrome.runtime.lastError) {
              onResult({ ok: false, reason: "Could not connect to page script. Reload target tab and try again." });
              return;
            }

            onResult(retryResponse);
          });
        }
      );
    });
  }

  function convertDelayToMs(rawValue, unit) {
    const base = Number(rawValue);
    if (!Number.isFinite(base) || base <= 0) {
      return null;
    }

    if (unit === "sec") {
      return Math.round(base * 1000);
    }

    if (unit === "hour") {
      return Math.round(base * 60 * 60 * 1000);
    }

    if (unit === "min") {
      return Math.round(base * 60 * 1000);
    }

    return Math.round(base);
  }

  function formatDuration(ms) {
    const safe = Math.max(0, Number(ms) || 0);
    if (safe >= 60 * 60 * 1000) {
      return `${(safe / (60 * 60 * 1000)).toFixed(2)}h`;
    }
    if (safe >= 60 * 1000) {
      return `${(safe / (60 * 1000)).toFixed(2)}m`;
    }
    if (safe >= 1000) {
      return `${(safe / 1000).toFixed(2)}s`;
    }
    return `${safe}ms`;
  }

  function formatSeconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      return "-";
    }
    return `${n}s`;
  }

  function stopStatusPolling() {
    if (statusPollTimer) {
      clearInterval(statusPollTimer);
      statusPollTimer = null;
    }
  }

  function pollListBillStatus() {
    getTargetBillingTab((targetTab) => {
      if (!targetTab || typeof targetTab.id !== "number") {
        stopStatusPolling();
        return;
      }

      sendMessageWithInjectionFallback(targetTab.id, { type: "GET_LIST_BILL_STATUS" }, (response) => {
        if (!response || !response.ok) {
          return;
        }

        if (!response.isRunning) {
          if (response.lastError) {
            setStatus(`Stopped: ${response.lastError}`);
          }
          stopStatusPolling();
          return;
        }

        const remainingMs = Math.max(0, (response.nextClickAt || 0) - Date.now());
        const phase = (() => {
          if (response.phase === "clicking-list-bill") {
            return "Clicking List Bill";
          }
          if (response.phase === "waiting-export") {
            return "Waiting 15s before Export Bills";
          }
          if (response.phase === "clicking-export") {
            return "Clicking Export Bills";
          }
          if (response.phase === "confirming-download") {
            return "Confirming download start";
          }
          if (response.phase === "waiting-next-cycle") {
            return "Waiting custom delay for next cycle";
          }
          if (response.phase === "starting") {
            return "Starting";
          }
          return "Running";
        })();

        setStatus(
          `${phase}. List clicks: ${response.listClickCount} (last ${formatSeconds(response.listSecondsSinceLast)}), ` +
          `Export clicks: ${response.exportClickCount} (last ${formatSeconds(response.exportSecondsSinceLast)}), ` +
          `Run: ${formatSeconds(response.runSeconds)}. Next in ${formatDuration(remainingMs)}.`
        );
      });
    });
  }

  function startStatusPolling() {
    stopStatusPolling();
    pollListBillStatus();
    statusPollTimer = setInterval(pollListBillStatus, 500);
  }

  function runListBillRepeatedly() {
    setStatus("Starting List Bill run...");

    const intervalMs = convertDelayToMs(delayValueInput?.value, delayUnitSelect?.value || "ms");
    if (!intervalMs) {
      setStatus("Enter a valid delay value.");
      return;
    }

    getTargetBillingTab((targetTab) => {
      if (!targetTab || typeof targetTab.id !== "number") {
        setStatus("Open the billing page tab first, then click Run List Bill.");
        return;
      }

      sendMessageWithInjectionFallback(
        targetTab.id,
        { type: "RUN_LIST_BILL", intervalMs },
        (response) => {
          if (!response || !response.ok) {
            setStatus((response && response.reason) || "Could not start List Bill run.");
            return;
          }

          chrome.runtime.sendMessage({ type: "SET_AUTOMATION_TAB", tabId: targetTab.id }, () => {
            // No-op: start should continue even if this metadata update fails.
          });

          setStatus(
            `Automation started: List Bill -> wait ${formatDuration(response.exportWaitMs || 15000)} -> Export Bills -> wait ${formatDuration(intervalMs)}.`
          );
          startStatusPolling();
        }
      );
    });
  }

  function stopListBillRun() {
    setStatus("Stopping List Bill run...");

    getTargetBillingTab((targetTab) => {
      if (!targetTab || typeof targetTab.id !== "number") {
        setStatus("Billing page tab not found.");
        return;
      }

      sendMessageWithInjectionFallback(targetTab.id, { type: "STOP_LIST_BILL" }, (response) => {
        if (!response || !response.ok) {
          setStatus((response && response.reason) || "Could not stop run.");
          return;
        }

        chrome.runtime.sendMessage({ type: "CLEAR_AUTOMATION_TAB" }, () => {
          // No-op: status update is enough for user flow.
        });

        setStatus(
          response.wasRunning
            ? `Automation stopped. List clicks: ${response.listClickCount}, Export clicks: ${response.exportClickCount}.`
            : "No active List Bill run."
        );
        stopStatusPolling();
      });
    });
  }

  function clearData() {
    chrome.storage.local.remove(STORAGE_KEY, () => {
      setStatus("Saved record cleared.");
      renderEmptyState();
    });
  }

  saveBtn.addEventListener("click", sendSaveRequestToActiveTab);
  refreshBtn.addEventListener("click", loadData);
  clearBtn.addEventListener("click", clearData);
  closeBtn.addEventListener("click", () => window.close());
  if (runListBillBtn) {
    runListBillBtn.addEventListener("click", runListBillRepeatedly);
  }
  if (stopListBillBtn) {
    stopListBillBtn.addEventListener("click", stopListBillRun);
  }

  window.addEventListener("beforeunload", stopStatusPolling);

  loadData();
})();
