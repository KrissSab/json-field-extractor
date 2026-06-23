// popup.js

let currentTab = null;
let keysVisible = false;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
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

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Init ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  currentTab = await getActiveTab();

  // Update badge with JSON presence
  const badge = document.getElementById('jsonCount');
  badge.textContent = '...';

  try {
    await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      files: ['content.js']
    });
    const r = await chrome.tabs.sendMessage(currentTab.id, { action: 'getAllKeys' });
    if (r && r.keys && r.keys.length > 0) {
      badge.textContent = `${r.keys.length} keys`;
    } else {
      badge.textContent = 'no JSON';
    }
  } catch (_) {
    badge.textContent = 'no access';
  }

  // Search button
  document.getElementById('searchBtn').addEventListener('click', () => {
    const val = document.getElementById('fieldInput').value;
    doSearch(val);
  });

  // Enter key
  document.getElementById('fieldInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const val = document.getElementById('fieldInput').value;
      doSearch(val);
    }
  });

  // Keys toggle
  document.getElementById('keysToggle').addEventListener('click', async () => {
    const section = document.getElementById('keysSection');
    const btn = document.getElementById('keysToggle');

    if (keysVisible) {
      keysToggleOff();
    } else {
      btn.textContent = 'Hide keys';
      keysVisible = true;
      await loadKeys();
    }
  });
});
