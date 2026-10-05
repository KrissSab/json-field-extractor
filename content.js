// content.js - Runs in the context of the page

/**
 * Extracts all text from the page and attempts to find JSON blocks
 */
function extractPageText() {
  return document.body.innerText || document.body.textContent || '';
}

// Characters that may legally appear OUTSIDE a string in JSON. Anything else
// (a bare letter from "info", a "@", etc.) marks where the JSON has ended and
// unrelated page text — e.g. row metadata between log records — has begun.
const JSON_OUTSIDE_STRING = new Set([
  '{', '}', '[', ']', ',', ':', '"', '-', '+', '.', 'e', 'E',
  't', 'r', 'u', 'f', 'a', 'l', 's', 'n',            // true / false / null
  ' ', '\n', '\t', '\r', '\f', '\v'
]);

/**
 * Best-effort repair of a JSON string that was cut off (truncated logs).
 *
 * Walks the text tracking string state and open brackets, remembering the last
 * position where the structure was "between members" — right after a complete
 * value, a comma, or an opening/closing bracket. It stops at the first char that
 * can't belong to JSON (trailing page text), then rewinds to that safe point
 * (dropping any partial trailing token like an unfinished number or string) and
 * closes every still-open bracket, so everything before the cut is recovered.
 * Returns a parseable JSON string, or null if nothing complete was found.
 */
function repairTruncatedJson(str) {
  const stack = [];        // open brackets awaiting a close, e.g. ['}', ']']
  let inString = false;
  let escape = false;
  let safeLen = 0;         // length of the prefix that is safe to close off
  let safeStack = [];      // snapshot of `stack` at that safe point

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') { inString = true; continue; }

    if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']');
      safeLen = i + 1; safeStack = stack.slice();   // empty container is closable
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      safeLen = i + 1; safeStack = stack.slice();    // container just completed
    } else if (ch === ',') {
      safeLen = i; safeStack = stack.slice();         // member before comma is complete
    } else if (ch >= '0' && ch <= '9') {
      // digit — part of a number, keep scanning
    } else if (!JSON_OUTSIDE_STRING.has(ch)) {
      break;                                          // trailing non-JSON text → stop
    }
  }

  if (safeLen === 0 || safeStack.length === 0) return null;

  let out = str.slice(0, safeLen).replace(/,\s*$/, '');
  for (let i = safeStack.length - 1; i >= 0; i--) out += safeStack[i];
  return out;
}

/**
 * Parse one candidate segment that starts with '{' or '['. Returns
 * { obj, partial } or null. First tries to read a complete object (ignoring any
 * trailing text after it); if the segment is cut off, falls back to repair.
 */
function parseSegment(seg) {
  let depth = 0, inString = false, escape = false;

  for (let j = 0; j < seg.length; j++) {
    const ch = seg[j];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(seg.slice(0, j + 1));
          if (typeof parsed === 'object' && parsed !== null) {
            return { obj: parsed, partial: false };
          }
        } catch (_) {}
        break;   // balanced but not valid JSON → try repair below
      }
    }
  }

  const repaired = repairTruncatedJson(seg);
  if (repaired) {
    try {
      const parsed = JSON.parse(repaired);
      if (typeof parsed === 'object' && parsed !== null) {
        return { obj: parsed, partial: true };
      }
    } catch (_) {}
  }
  return null;
}

/**
 * Find all JSON-like objects from a text string.
 *
 * Pages like log viewers concatenate many JSON records (one per row), each of
 * which may be truncated in the display. We split the text at record boundaries
 * — every top-level '{' / '[' that isn't a nested value — and parse/repair each
 * record independently, so one truncated record can't swallow the rest.
 *
 * Returns [{ obj, partial }] — `partial` is true when the record was recovered
 * from truncated JSON and may be missing fields after the cut-off point.
 */
function findAllJsonBlocks(text) {
  const jsonBlocks = [];

  // Try the entire text as JSON first (e.g. pure JSON pages / API responses)
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    jsonBlocks.push({ obj: parsed, partial: false });
    return jsonBlocks;
  } catch (_) {}

  // Locate the start of each top-level record. A '{' or '[' begins a new record
  // unless it directly follows ':' ',' '[' (i.e. it's a nested value/element).
  const starts = [];
  let inString = false, escape = false, prev = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') { inString = false; prev = '"'; }
      continue;
    }

    if (ch === '"') { inString = true; continue; }          // keep prev until close
    if (ch === ' ' || ch === '\n' || ch === '\t' ||
        ch === '\r' || ch === '\f' || ch === '\v') continue; // whitespace: prev unchanged

    if (ch === '{' || ch === '[') {
      if (!(prev === ':' || prev === ',' || prev === '[')) starts.push(i);
    }
    prev = ch;
  }

  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : text.length;
    const block = parseSegment(text.slice(starts[k], end));
    if (block) jsonBlocks.push(block);
  }

  return jsonBlocks;
}

/**
 * Recursively search for a field in nested JSON
 * Supports dot notation: body.request_id
 */
function getFieldValue(obj, fieldPath) {
  const parts = fieldPath.split('.');
  let current = obj;
  
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    
    // Support array index notation: errors[0]
    const arrMatch = part.match(/^(.+)\[(\d+)\]$/);
    if (arrMatch) {
      current = current[arrMatch[1]];
      if (Array.isArray(current)) {
        current = current[parseInt(arrMatch[2])];
      } else {
        return undefined;
      }
    } else {
      current = current[part];
    }
  }
  
  return current;
}

/**
 * Search all JSON blocks on the page for a given field
 */
function searchField(fieldPath) {
  const pageText = extractPageText();
  const jsonBlocks = findAllJsonBlocks(pageText);
  
  if (jsonBlocks.length === 0) {
    return { success: false, error: 'No JSON found on this page' };
  }
  
  const results = [];

  for (let i = 0; i < jsonBlocks.length; i++) {
    const block = jsonBlocks[i];
    const value = getFieldValue(block.obj, fieldPath);

    if (value !== undefined) {
      results.push({
        blockIndex: i,
        value: value,
        valueStr: typeof value === 'object'
          ? JSON.stringify(value, null, 2)
          : String(value)
      });
    }
  }

  if (results.length === 0) {
    // Try to find partial matches (fuzzy search)
    const suggestions = [];
    for (const block of jsonBlocks) {
      collectKeys(block.obj, '', suggestions);
    }
    const uniqueSuggestions = [...new Set(suggestions)];
    const matches = uniqueSuggestions.filter(k =>
      k.toLowerCase().includes(fieldPath.toLowerCase())
    ).slice(0, 5);

    return {
      success: false,
      error: `Field "${fieldPath}" not found`,
      suggestions: matches,
      totalBlocks: jsonBlocks.length
    };
  }

  return {
    success: true,
    results,
    totalBlocks: jsonBlocks.length,
    partial: jsonBlocks.some(b => b.partial)
  };
}

/**
 * Collect all keys from a nested object (for suggestions)
 */
function collectKeys(obj, prefix, keys) {
  if (typeof obj !== 'object' || obj === null) return;
  
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    keys.push(fullKey);
    if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      collectKeys(obj[key], fullKey, keys);
    }
  }
}

/**
 * Get all available keys from the page JSON
 */
function getAllKeys() {
  const pageText = extractPageText();
  const jsonBlocks = findAllJsonBlocks(pageText);
  
  const keys = [];
  for (const block of jsonBlocks) {
    collectKeys(block.obj, '', keys);
  }

  return [...new Set(keys)].sort();
}

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'searchField') {
    const result = searchField(request.field);
    sendResponse(result);
  } else if (request.action === 'getAllKeys') {
    const keys = getAllKeys();
    sendResponse({ keys });
  }
  return true; // Keep message channel open for async
});
