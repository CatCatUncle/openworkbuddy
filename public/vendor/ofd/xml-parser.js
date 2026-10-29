// Provide a DOMParser polyfill for Node.js environments.
// In browser, DOMParser is native. In Node.js, we need linkedom or xmldom.
let _DOMParser = null;
let _DOMParserInitPromise = null;

async function getDOMParserAsync() {
  if (_DOMParser) return _DOMParser;

  // Browser: native DOMParser
  if (typeof globalThis !== 'undefined' && typeof globalThis.DOMParser !== 'undefined') {
    _DOMParser = globalThis.DOMParser;
    return _DOMParser;
  }
  if (typeof window !== 'undefined' && typeof window.DOMParser !== 'undefined') {
    _DOMParser = window.DOMParser;
    return _DOMParser;
  }

  // Node.js: try dynamic import of linkedom
  try {
    const linkedom = await import('linkedom');
    if (linkedom.DOMParser) {
      _DOMParser = linkedom.DOMParser;
      return _DOMParser;
    }
  } catch (e) {
    // linkedom not available
  }

  // Node.js: try dynamic import of @xmldom/xmldom
  try {
    const xmldom = await import('@xmldom/xmldom');
    if (xmldom.DOMParser) {
      _DOMParser = xmldom.DOMParser;
      return _DOMParser;
    }
  } catch (e) {
    // xmldom not available
  }

  throw new Error('DOMParser is not available. In Node.js, install linkedom or @xmldom/xmldom package.');
}

/**
 * Synchronous DOMParser getter — requires DOMParser to already be initialized
 * or available globally (browser). For Node.js ESM, call initDOMParser() first.
 */
function getDOMParser() {
  if (_DOMParser) return _DOMParser;

  // Browser: native DOMParser
  if (typeof globalThis !== 'undefined' && typeof globalThis.DOMParser !== 'undefined') {
    _DOMParser = globalThis.DOMParser;
    return _DOMParser;
  }
  if (typeof window !== 'undefined' && typeof window.DOMParser !== 'undefined') {
    _DOMParser = window.DOMParser;
    return _DOMParser;
  }

  // Node.js CJS: try require (only works if module is loaded as CJS)
  // Guard: require is not defined in pure ESM, ReferenceError is not caught by try/catch
  if (typeof require !== 'undefined') {
    try {
      const linkedom = require('linkedom');
      if (linkedom.DOMParser) {
        _DOMParser = linkedom.DOMParser;
        return _DOMParser;
      }
    } catch (e) {}

    try {
      const xmldom = require('@xmldom/xmldom');
      if (xmldom.DOMParser) {
        _DOMParser = xmldom.DOMParser;
        return _DOMParser;
      }
    } catch (e) {}
  }

  throw new Error('DOMParser is not available. In Node.js, install linkedom or @xmldom/xmldom package, or call initDOMParser() first.');
}

/**
 * Initialize DOMParser for Node.js ESM environments.
 * Must be called before using parseXml() in Node.js ESM context.
 * In browser, this is a no-op (DOMParser is already available).
 * @returns {Promise<void>}
 */
export async function initDOMParser() {
  const Parser = await getDOMParserAsync();
  _DOMParser = Parser;
}

/**
 * Parse an XML string into a DOM Document.
 * Uses DOMParser (native in browser, polyfill in Node.js via linkedom/xmldom).
 *
 * @param {string} xmlString - XML content to parse
 * @returns {Document} parsed DOM Document
 * @throws {Error} if parsing fails
 */
export function parseXml(xmlString) {
  const Parser = getDOMParser();
  const parser = new Parser();
  const doc = parser.parseFromString(xmlString, 'text/xml');

  // Check for parse errors — DOMParser doesn't throw, it returns
  // a document with <parsererror> elements
  const errorNode = doc.querySelector('parsererror');
  if (errorNode) {
    throw new Error('XML parse error: ' + errorNode.textContent);
  }

  return doc;
}

/**
 * Strip namespace prefix from a tag name.
 * OFD uses "ofd:" prefix; DOMParser may or may not strip it.
 * @param {string} tagName - e.g. "ofd:PathObject" or "PathObject"
 * @returns {string} tag name without namespace prefix, e.g. "PathObject"
 */
export function stripNamespace(tagName) {
  const idx = tagName.indexOf(':');
  return idx >= 0 ? tagName.substring(idx + 1) : tagName;
}

/**
 * Get the effective tag name of an element, stripping namespace prefix.
 * Uses localName if available (which DOMParser sets correctly for namespaced XML),
 * otherwise falls back to stripping tagName manually.
 * @param {Element} el
 * @returns {string} tag name without namespace
 */
export function getTagName(el) {
  // Some DOM implementations (like linkedom) don't set localName correctly
  // for namespaced XML — they include the prefix. We always strip the namespace.
  if (el.localName && el.localName.indexOf(':') === -1) {
    return el.localName;
  }
  // Fall back to stripping the prefix from tagName
  return stripNamespace(el.tagName || '');
}

/**
 * Get the first direct child element matching a tag name (namespace-agnostic).
 * @param {Element} parent - parent element to search in
 * @param {string} tagName - tag name to match (without namespace prefix)
 * @returns {Element|null} first matching child, or null
 */
export function getChild(parent, tagName) {
  for (const child of parent.children) {
    if (getTagName(child) === tagName) {
      return child;
    }
  }
  return null;
}

/**
 * Get all direct child elements matching a tag name (namespace-agnostic).
 * @param {Element} parent - parent element to search in
 * @param {string} tagName - tag name to match (without namespace prefix)
 * @returns {Element[]} array of matching children (empty if none)
 */
export function getChildren(parent, tagName) {
  const result = [];
  for (const child of parent.children) {
    if (getTagName(child) === tagName) {
      result.push(child);
    }
  }
  return result;
}

/**
 * Get an attribute value from an element.
 * @param {Element} el - element to read from
 * @param {string} name - attribute name (case-sensitive)
 * @returns {string|null} attribute value, or null if missing
 */
export function getAttr(el, name) {
  return el.getAttribute(name);
}

/**
 * Get an attribute value as an integer.
 * @param {Element} el
 * @param {string} name
 * @returns {number|null} integer value, or null if missing/invalid
 */
export function getAttrInt(el, name) {
  const val = el.getAttribute(name);
  if (val === null || val === '') return null;
  const num = parseInt(val, 10);
  return isNaN(num) ? null : num;
}

/**
 * Get an attribute value as a float.
 * @param {Element} el
 * @param {string} name
 * @returns {number|null} float value, or null if missing/invalid
 */
export function getAttrFloat(el, name) {
  const val = el.getAttribute(name);
  if (val === null || val === '') return null;
  const num = parseFloat(val);
  return isNaN(num) ? null : num;
}

/**
 * Get the text content of an element.
 * Maps serde's $value pattern (which captures element text content).
 * @param {Element|null} el - element to read text from (may be null)
 * @returns {string} text content, or empty string if el is null
 */
export function getTextContent(el) {
  if (!el) return '';
  return el.textContent || '';
}

/**
 * Get all direct child elements of a parent, regardless of tag name.
 * Used for polymorphic content (Layer/PageBlock children) where
 * we need to iterate and dispatch based on tag name.
 * @param {Element} parent
 * @returns {Element[]} all direct child Element nodes
 */
export function getAllChildren(parent) {
  return Array.from(parent.children);
}