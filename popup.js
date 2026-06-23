// popup.js

let currentTab = null;
let keysVisible = false;
let allKeys = [];      // every key path found on the page (for autocomplete)
let acItems = [];      // suggestions currently shown in the dropdown
let acActive = -1;     // index of the highlighted suggestion

// The side panel renders this same page with ?panel=1
const urlParams = new URLSearchParams(location.search);
const isPanel = urlParams.get('panel') === '1';

async function getActiveTab() {
  // In the side panel, target the active tab of the panel's own window
  if (isPanel) {
    try {
      const win = await chrome.windows.getCurrent();
      const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
      if (tab) return tab;
    } catch (_) {
      // fall through to the generic query
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ─── Pin (side panel) ────────────────────────────────────────────────────────

function updatePinButton() {
  const btn = document.getElementById('pinBtn');
  if (!btn) return;
  btn.classList.toggle('active', isPanel);
  btn.title = isPanel
    ? 'Unpin (close the side panel)'
    : 'Pin to this window (open in the side panel)';
}

async function onPinClick() {
  // Already running inside the side panel → unpin by closing it
  if (isPanel) {
    window.close();
    return;
  }

  // Dock the panel in the current window. sidePanel.open() must run inside the
  // user gesture, so call it before anything else, then close the popup.
  try {
    const windowId = currentTab ? currentTab.windowId : undefined;
    await chrome.sidePanel.open(windowId != null ? { windowId } : {});
    window.close();
  } catch (_) {
    // Couldn't open the panel — leave the popup as-is
  }
}

function setStatus(type, text) {
  const el = document.getElementById('status');
  const icon = document.getElementById('statusIcon');
  const textEl = document.getElementById('statusText');

  el.className = `status ${type}`;
  textEl.textContent = text;

  if (type === 'error') icon.textContent = '✕';
  else if (type === 'success') icon.textContent = '✓';
  else icon.textContent = '';
}

function clearStatus() {
  document.getElementById('status').className = 'status';
}

function getValueType(val) {
  if (val === null) return 'null';
  if (Array.isArray(val)) return `array[${val.length}]`;
  if (typeof val === 'object') return `object{${Object.keys(val).length}}`;
  return typeof val;
}

// Escape a single CSV field per RFC 4180 (quote if it contains , " or newline)
function csvEscape(value) {
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// One result per row. Objects/arrays are written as compact JSON on a single line.
function resultsToCsv(results, field) {
  const header = csvEscape(field || 'value');
  const rows = results.map((res) => {
    const cell = (res.value !== null && typeof res.value === 'object')
      ? JSON.stringify(res.value)
      : res.valueStr;
    return csvEscape(cell);
  });
  return [header, ...rows].join('\n');
}

function renderResults(data, field) {
  const section = document.getElementById('resultsSection');
  const list = document.getElementById('resultsList');
  const meta = document.getElementById('resultsMeta');

  section.classList.add('visible');
  section.classList.remove('collapsed');
  list.innerHTML = '';

  const results = data.results;
  const label = results.length === 1
    ? `1 match in ${data.totalBlocks} block(s)`
    : `${results.length} matches in ${data.totalBlocks} block(s)`;
  meta.textContent = label;

  // "Copy all" exports every match as CSV (header = field name, one value per row)
  const copyAllBtn = document.getElementById('copyAllBtn');
  copyAllBtn.style.display = results.length > 1 ? '' : 'none';
  copyAllBtn.textContent = 'Copy all (CSV)';
  copyAllBtn.classList.remove('copied');
  copyAllBtn.onclick = function () {
    navigator.clipboard.writeText(resultsToCsv(results, field)).then(() => {
      this.textContent = 'Copied!';
      this.classList.add('copied');
      setTimeout(() => {
        this.textContent = 'Copy all (CSV)';
        this.classList.remove('copied');
      }, 1500);
    });
  };

  for (const res of results) {
    const block = document.createElement('div');
    block.className = 'result-block';

    const typeBadge = getValueType(res.value);
    const copyId = `copy-${Math.random().toString(36).slice(2)}`;

    block.innerHTML = `
      <div class="result-meta">
        <span class="result-type">${typeBadge}</span>
        <button class="copy-btn" id="${copyId}">Copy</button>
      </div>
      <pre>${escapeHtml(res.valueStr)}</pre>
    `;

    list.appendChild(block);

    document.getElementById(copyId).addEventListener('click', function () {
      navigator.clipboard.writeText(res.valueStr).then(() => {
        this.textContent = 'Copied!';
        this.classList.add('copied');
        setTimeout(() => {
          this.textContent = 'Copy';
          this.classList.remove('copied');
        }, 1500);
      });
    });
  }
}

function renderSuggestions(suggestions) {
  const section = document.getElementById('suggestions');
  const list = document.getElementById('suggestionsList');

  if (!suggestions || suggestions.length === 0) {
    section.classList.remove('visible');
    return;
  }

  section.classList.add('visible');
  list.innerHTML = '';

  for (const s of suggestions) {
    const chip = document.createElement('div');
    chip.className = 'suggestion-chip';
    chip.textContent = s;
    chip.addEventListener('click', () => {
      document.getElementById('fieldInput').value = s;
      doSearch(s);
    });
    list.appendChild(chip);
  }
}

function renderKeys(keys) {
  const section = document.getElementById('keysSection');
  const list = document.getElementById('keysList');
  const meta = document.getElementById('keysMeta');

  if (!keys || keys.length === 0) {
    section.classList.remove('visible');
    return;
  }

  meta.textContent = `${keys.length} keys`;
  list.innerHTML = '';

  const fieldInput = document.getElementById('fieldInput');

  for (const key of keys) {
    const item = document.createElement('div');
    item.className = 'key-item';
    item.innerHTML = `<div class="key-dot"></div><span class="key-text">${escapeHtml(key)}</span>`;
    item.addEventListener('click', () => {
      fieldInput.value = key;
      keysToggleOff();
      doSearch(key);
    });
    list.appendChild(item);
  }

  section.classList.add('visible');
}

function clearResults() {
  document.getElementById('resultsSection').classList.remove('visible');
  document.getElementById('resultsList').innerHTML = '';
  document.getElementById('suggestions').classList.remove('visible');
  document.getElementById('suggestionsList').innerHTML = '';
}

async function doSearch(fieldValue) {
  const field = fieldValue.trim();
  if (!field) return;

  // Give results room to breathe once the user actually searches
  document.body.classList.add('searched');

  clearStatus();
  clearResults();

  if (!currentTab) return;

  try {
    // Ensure content script is injected
    await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      files: ['content.js']
    });
  } catch (_) {
    // Already injected or can't inject (chrome:// pages etc)
  }

  let result;
  try {
    result = await chrome.tabs.sendMessage(currentTab.id, {
      action: 'searchField',
      field
    });
  } catch (e) {
    setStatus('error', 'Cannot access page. Try refreshing.');
    return;
  }

  if (!result) {
    setStatus('error', 'No response from page');
    return;
  }

  if (!result.success) {
    setStatus('error', result.error || 'Field not found');
    renderSuggestions(result.suggestions);
    return;
  }

  setStatus('success', `Found "${field}"`);
  renderResults(result, field);
}

async function loadKeys() {
  if (!currentTab) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      files: ['content.js']
    });
  } catch (_) {}

  let result;
  try {
    result = await chrome.tabs.sendMessage(currentTab.id, { action: 'getAllKeys' });
  } catch (e) {
    return;
  }

  if (result && result.keys) {
    allKeys = result.keys;
    renderKeys(result.keys);

    // Update badge
    const jsonCount = document.getElementById('jsonCount');
    jsonCount.textContent = `${result.keys.length} keys`;
  }
}

function keysToggleOff() {
  const section = document.getElementById('keysSection');
  const btn = document.getElementById('keysToggle');
  section.classList.remove('visible');
  btn.textContent = 'Show all keys';
  keysVisible = false;
}

// ─── Autocomplete ──────────────────────────────────────────────────────────

// Rank a key against the query: exact leaf > leaf prefix > path prefix > contains
function acScore(key, q) {
  const lower = key.toLowerCase();
  const leaf = lower.split('.').pop();
  if (leaf === q) return 4;
  if (leaf.startsWith(q)) return 3;
  if (lower.startsWith(q)) return 2;
  return 1;
}

// Wrap the matched part of the key in a highlight span (input is escaped)
function highlightMatch(key, q) {
  const idx = key.toLowerCase().indexOf(q);
  if (idx === -1) return escapeHtml(key);
  return escapeHtml(key.slice(0, idx))
    + `<span class="ac-match">${escapeHtml(key.slice(idx, idx + q.length))}</span>`
    + escapeHtml(key.slice(idx + q.length));
}

function hideAutocomplete() {
  const box = document.getElementById('autocomplete');
  box.classList.remove('visible');
  box.innerHTML = '';
  acItems = [];
  acActive = -1;
}

function setAcActive(i) {
  acActive = i;
  const box = document.getElementById('autocomplete');
  [...box.children].forEach((c, idx) => c.classList.toggle('active', idx === i));
  const active = box.children[i];
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function selectAutocomplete(key) {
  document.getElementById('fieldInput').value = key;
  hideAutocomplete();
  doSearch(key);
}

function renderAutocomplete(query) {
  const box = document.getElementById('autocomplete');
  const q = query.trim().toLowerCase();
  acActive = -1;

  if (!q || allKeys.length === 0) {
    hideAutocomplete();
    return;
  }

  const matches = allKeys.filter(k => k.toLowerCase().includes(q));

  // Nothing useful to suggest (no match, or the only match is exactly typed)
  if (matches.length === 0 || (matches.length === 1 && matches[0].toLowerCase() === q)) {
    hideAutocomplete();
    return;
  }

  matches.sort((a, b) => acScore(b, q) - acScore(a, q) || a.length - b.length);
  acItems = matches.slice(0, 8);

  box.innerHTML = '';
  acItems.forEach((key, i) => {
    const item = document.createElement('div');
    item.className = 'autocomplete-item';
    item.innerHTML = `<div class="key-dot"></div><span>${highlightMatch(key, q)}</span>`;
    // mousedown fires before the input loses focus, so the click isn't swallowed
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      selectAutocomplete(key);
    });
    item.addEventListener('mouseenter', () => setAcActive(i));
    box.appendChild(item);
  });

  box.classList.add('visible');
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Init ────────────────────────────────────────────────────────────────────

// Resolve the active tab and refresh the key index / badge for it.
// Re-run whenever the side panel needs to follow a new tab.
async function scanTab() {
  currentTab = await getActiveTab();

  const badge = document.getElementById('jsonCount');
  badge.textContent = '...';
  allKeys = [];
  clearResults();
  clearStatus();
  keysToggleOff();

  if (!currentTab) {
    badge.textContent = 'no access';
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      files: ['content.js']
    });
    const r = await chrome.tabs.sendMessage(currentTab.id, { action: 'getAllKeys' });
    if (r && r.keys && r.keys.length > 0) {
      allKeys = r.keys;
      badge.textContent = `${r.keys.length} keys`;
    } else {
      badge.textContent = 'no JSON';
    }
  } catch (_) {
    badge.textContent = 'no access';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  if (isPanel) document.body.classList.add('panel');
  updatePinButton();
  document.getElementById('pinBtn').addEventListener('click', onPinClick);

  const fieldInput = document.getElementById('fieldInput');

  // Search button
  document.getElementById('searchBtn').addEventListener('click', () => {
    hideAutocomplete();
    doSearch(fieldInput.value);
  });

  // Live autocomplete as the user types / focuses
  fieldInput.addEventListener('input', () => renderAutocomplete(fieldInput.value));
  fieldInput.addEventListener('focus', () => renderAutocomplete(fieldInput.value));

  // Keyboard: navigate the dropdown, select, or run the search
  fieldInput.addEventListener('keydown', (e) => {
    const open = document.getElementById('autocomplete').classList.contains('visible');

    if (open && e.key === 'ArrowDown') {
      e.preventDefault();
      setAcActive((acActive + 1) % acItems.length);
    } else if (open && e.key === 'ArrowUp') {
      e.preventDefault();
      setAcActive((acActive - 1 + acItems.length) % acItems.length);
    } else if (e.key === 'Enter') {
      if (open && acActive >= 0) {
        e.preventDefault();
        selectAutocomplete(acItems[acActive]);
      } else {
        hideAutocomplete();
        doSearch(fieldInput.value);
      }
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      hideAutocomplete();
    }
  });

  // Close the dropdown when clicking elsewhere
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) hideAutocomplete();
  });

  // Collapse / expand the Results section
  document.getElementById('resultsToggle').addEventListener('click', () => {
    document.getElementById('resultsSection').classList.toggle('collapsed');
  });

  // Keys toggle
  document.getElementById('keysToggle').addEventListener('click', async () => {
    const btn = document.getElementById('keysToggle');

    if (keysVisible) {
      keysToggleOff();
    } else {
      btn.textContent = 'Hide keys';
      keysVisible = true;
      await loadKeys();
    }
  });

  await scanTab();

  // In the side panel, follow the active tab as the user switches or navigates
  if (isPanel) {
    const myWindowId = currentTab ? currentTab.windowId : null;
    const refreshIfMine = (winId) => {
      if (myWindowId == null || winId === myWindowId) scanTab();
    };
    chrome.tabs.onActivated.addListener((info) => refreshIfMine(info.windowId));
    chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
      if (change.status === 'complete' && tab.active) refreshIfMine(tab.windowId);
    });
  }
});
