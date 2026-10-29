// Page.xml parsing — mirrors src/page.rs
// A Page is parsed from the content XML file referenced by PageElement.baseLoc
// within the OFD ZIP archive.

import { parseXml, getChild, getChildren, getAttr, getAttrInt, getTextContent, getTagName } from './xml-parser.js';
import { parseLayerEvents } from './elements.js';

// ============================================================
// Page structure types
// ============================================================

/**
 * Area — page area dimensions (string fields, raw from XML).
 * physicalBox/applicationBox are strings like "0 0 211.50 140".
 * For rendering, these are parsed into types.PageArea numeric values.
 */
export class Area {
  constructor(physicalBox = '', applicationBox = '') {
    this.physicalBox = physicalBox;
    this.applicationBox = applicationBox;
  }
}

/**
 * Layer — contains a list of content events (the polymorphic drawing commands).
 * In the current Rust implementation, only one layer per page is supported.
 */
export class Layer {
  constructor(events = []) {
    this.events = events;  // heterogeneous array of PathObject, TextObject, ImageObject, PageBlock
  }
}

/**
 * Content — page content container, holds a single Layer.
 */
export class Content {
  constructor(layer = new Layer()) {
    this.layer = layer;
  }
}

/**
 * Template — a template reference within a Page.
 * Specifies which template to use and how to layer it (Background vs Foreground).
 * OFD spec: <ofd:Template TemplateID="9" ZOrder="Background"/>
 */
export class Template {
  constructor(templateId = 0, zOrder = 'Background') {
    this.templateId = templateId;  // references TemplatePage.id
    this.zOrder = zOrder;          // "Background" or "Foreground"
  }
}

/**
 * Page — a single page in the OFD document.
 * area holds page dimensions.
 * content holds the drawing elements.
 * templates holds template references (e.g. form layouts).
 * annotations is populated later (not from this XML), matching Rust #[serde(skip)].
 */
export class Page {
  constructor(area = new Area(), content = new Content(), templates = [], annotations = []) {
    this.area = area;
    this.content = content;
    this.templates = templates;    // array of Template references
    this.annotations = annotations;  // populated later from Annot files
  }
}

// ============================================================
// Internal parse helpers
// ============================================================

function parseAreaElement(el) {
  const physicalBox = getTextContent(getChild(el, 'PhysicalBox'));
  const applicationBox = getTextContent(getChild(el, 'ApplicationBox'));
  return new Area(physicalBox, applicationBox);
}

function parseLayerElement(el) {
  // parseLayerEvents dispatches child elements by tag name
  // (PathObject, TextObject, ImageObject, PageBlock)
  const events = parseLayerEvents(el);
  return new Layer(events);
}

function parseContentElement(el) {
  const layerEl = getChild(el, 'Layer');
  const layer = layerEl ? parseLayerElement(layerEl) : new Layer();
  return new Content(layer);
}

function parseTemplateElement(el) {
  const templateId = getAttrInt(el, 'TemplateID') || 0;
  const zOrder = getAttr(el, 'ZOrder') || 'Background';
  return new Template(templateId, zOrder);
}

function parsePageElement(el) {
  const areaEl = getChild(el, 'Area');
  const area = areaEl ? parseAreaElement(areaEl) : new Area();

  const contentEl = getChild(el, 'Content');
  const content = contentEl ? parseContentElement(contentEl) : new Content();

  // Parse Template references (may have multiple)
  const templateEls = getChildren(el, 'Template');
  const templates = templateEls.map(parseTemplateElement);

  // annotations is NOT parsed from this XML (serde skip)
  return new Page(area, content, templates);
}

// ============================================================
// Public parse function
// ============================================================

/**
 * Parse a Page content XML string into a Page object.
 * This is the XML file referenced by PageElement.baseLoc in the ZIP,
 * e.g. "Pages/Page_0/Content.xml".
 *
 * @param {string} xmlString - XML content of the page file
 * @returns {Page} parsed page with area, content, and layer events
 */
export function parsePageXml(xmlString) {
  const doc = parseXml(xmlString);
  const root = doc.documentElement;
  return parsePageElement(root);
}