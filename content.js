// content.js - Runs in the context of the page

/**
 * Extracts all text from the page and attempts to find JSON blocks
 */
function extractPageText() {
  return document.body.innerText || document.body.textContent || '';
}

/**
 * Find all JSON-like objects from a text string
 */
function findAllJsonBlocks(text) {
  const jsonBlocks = [];
  
  // Try the entire text as JSON first (e.g. pure JSON pages)
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    jsonBlocks.push(parsed);
    return jsonBlocks;
  } catch (_) {}

  // Find JSON blocks using bracket matching
  const openChars = ['{', '['];
  
  for (let i = 0; i < text.length; i++) {
    if (openChars.includes(text[i])) {
      let depth = 0;
      let inString = false;
      let escape = false;
      let j = i;
      
      for (; j < text.length; j++) {
        const ch = text[j];
        
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        
        if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') {
          depth--;
          if (depth === 0) {
            const candidate = text.slice(i, j + 1);
            try {
              const parsed = JSON.parse(candidate);
              if (typeof parsed === 'object' && parsed !== null) {
                jsonBlocks.push(parsed);
              }
            } catch (_) {}
            break;
          }
        }
      }
    }
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
    const value = getFieldValue(block, fieldPath);
    
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
      collectKeys(block, '', suggestions);
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
    totalBlocks: jsonBlocks.length
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
    collectKeys(block, '', keys);
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
