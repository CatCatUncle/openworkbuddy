// Document.xml + resources parsing — mirrors src/document.rs
// This file handles parsing of the Document structure, DocumentRes,
// PublicRes, Annotations, and annotation page content.

import { parseXml, getChild, getChildren, getAttr, getAttrInt, getAttrFloat, getTextContent } from './xml-parser.js';
import { parseImageObject, parseAnnotElement } from './elements.js';

// ============================================================
// Document-level types
// ============================================================

/**
 * PageArea — document-level page area (string fields, not computed).
 * Separate from types.js PageArea which holds numeric values.
 * physicalBox/applicationBox are raw strings like "0 0 210 297".
 */
export class PageArea {
  constructor(physicalBox = '', applicationBox = '') {
    this.physicalBox = physicalBox;
    this.applicationBox = applicationBox;
  }
}

/**
 * TemplatePage — a reusable page template (e.g. form layout).
 * OFD documents can reference templates via <Template TemplateID="..." ZOrder="..."/>
 * in page XML, which merges the template's content with the page's own content.
 */
export class TemplatePage {
  constructor(id = 0, baseLoc = '', name = null) {
    this.id = id;        // from "ID" attribute
    this.baseLoc = baseLoc;  // path to template Content.xml (from "BaseLoc" attribute)
    this.name = name;    // optional template name (from "Name" attribute)
  }
}

/**
 * CommonData — shared document metadata.
 * Now includes templatePages for template support.
 */
export class CommonData {
  constructor(pageArea = new PageArea(), publicRes = '', documentRes = '', maxUnitId = 0, templatePages = []) {
    this.pageArea = pageArea;
    this.publicRes = publicRes;
    this.documentRes = documentRes;
    this.maxUnitId = maxUnitId;
    this.templatePages = templatePages;  // array of TemplatePage
  }
}

/**
 * PageElement — a page reference in the page list.
 * baseLoc and id are both optional (matching Rust Option<String>/Option<u32>).
 */
export class PageElement {
  constructor(baseLoc = null, id = null) {
    this.baseLoc = baseLoc;
    this.id = id;
  }
}

/**
 * PageList — container for page references.
 */
export class PageList {
  constructor(page = []) {
    this.page = page;
  }
}

/**
 * Document — the top-level document structure parsed from Document.xml.
 * docRes and publicRes are NOT parsed from this XML — they are populated
 * later from separate resource files. This mirrors Rust #[serde(skip)].
 */
export class Document {
  constructor(commonData = new CommonData(), pages = new PageList(), annotations = null, customTags = null, docRes = null, publicRes = null) {
    this.commonData = commonData;
    this.pages = pages;
    this.annotations = annotations;    // string path to Annotations.xml, or null
    this.customTags = customTags;      // string path to CustomTags.xml, or null
    this.docRes = docRes;              // DocumentRes, populated later
    this.publicRes = publicRes;        // PublicRes, populated later
  }
}

// ============================================================
// DocumentRes types
// ============================================================

/**
 * MultiMedia — a media resource entry (e.g. PNG image).
 * id from "ID" attribute, format from "Format" attribute,
 * mediaFile is text content of <MediaFile> child element.
 */
export class MultiMedia {
  constructor(id = 0, format = '', mediaFile = '') {
    this.id = id;
    this.format = format;
    this.mediaFile = mediaFile;
  }
}

/**
 * MultiMedias — container for media resource entries.
 */
export class MultiMedias {
  constructor(multiMedia = []) {
    this.multiMedia = multiMedia;
  }
}

/**
 * DocumentRes — document resource definitions (images, etc).
 * baseLoc from "BaseLoc" attribute on root <Res> element.
 */
export class DocumentRes {
  constructor(baseLoc = '', multiMedias = new MultiMedias()) {
    this.baseLoc = baseLoc;
    this.multiMedias = multiMedias;
  }
}

// ============================================================
// PublicRes types
// ============================================================

/**
 * Font — a font definition.
 * id from "ID" attribute, familyName/fontName from respective attributes.
 */
export class Font {
  constructor(id = 0, familyName = '', fontName = '', bold = false, italic = false, serif = false, fixedWidth = false) {
    this.id = id;
    this.familyName = familyName;
    this.fontName = fontName;
    this.bold = bold;        // boolean: whether bold font (for matching)
    this.italic = italic;    // boolean: whether italic font (for matching)
    this.serif = serif;      // boolean: whether serif font (for matching)
    this.fixedWidth = fixedWidth;  // boolean: whether fixed-width font (for matching)
  }
}

/**
 * Fonts — container for font definitions.
 */
export class Fonts {
  constructor(font = []) {
    this.font = font;
  }
}

/**
 * PublicRes — public resource definitions (fonts).
 * baseLoc from "BaseLoc" attribute on root <Res> element.
 */
export class PublicRes {
  constructor(baseLoc = '', fonts = new Fonts()) {
    this.baseLoc = baseLoc;
    this.fonts = fonts;
  }
}

// ============================================================
// Annotations types
// ============================================================

/**
 * AnnotationPageNode — links a page ID to an annotation file location.
 * pageId from "PageID" attribute.
 * fileLoc from text content of <FileLoc> child or the <Page> element itself
 * (Rust uses serde rename="$value" which captures element text content).
 */
export class AnnotationPageNode {
  constructor(pageId = 0, fileLoc = '') {
    this.pageId = pageId;
    this.fileLoc = fileLoc;
  }
}

/**
 * Annotations — container for annotation page references.
 */
export class Annotations {
  constructor(page = []) {
    this.page = page;
  }
}

/**
 * PageAnnot — annotation content for a specific page.
 * Contains an array of Annot objects imported from elements.js.
 */
export class PageAnnot {
  constructor(annot = []) {
    this.annot = annot;
  }
}

// ============================================================
// Internal parse helper functions
// ============================================================

function parsePageAreaElement(el) {
  const physicalBox = getTextContent(getChild(el, 'PhysicalBox'));
  const applicationBox = getTextContent(getChild(el, 'ApplicationBox'));
  return new PageArea(physicalBox, applicationBox);
}

function parseTemplatePageElement(el) {
  const id = getAttrInt(el, 'ID') || 0;
  const baseLoc = getAttr(el, 'BaseLoc') || '';
  const name = getAttr(el, 'Name');
  return new TemplatePage(id, baseLoc, name);
}

function parseCommonDataElement(el) {
  const pageAreaEl = getChild(el, 'PageArea');
  const pageArea = pageAreaEl ? parsePageAreaElement(pageAreaEl) : new PageArea();

  const publicRes = getTextContent(getChild(el, 'PublicRes'));
  const documentRes = getTextContent(getChild(el, 'DocumentRes'));
  const maxUnitId = getAttrInt(el, 'MaxUnitID') ||
    getAttrInt(getChild(el, 'MaxUnitID'), 'Value') ||
    parseInt(getTextContent(getChild(el, 'MaxUnitID')), 10) || 0;

  // Parse TemplatePage elements (may have multiple)
  const templatePageEls = getChildren(el, 'TemplatePage');
  const templatePages = templatePageEls.map(parseTemplatePageElement);

  return new CommonData(pageArea, publicRes, documentRes, maxUnitId, templatePages);
}

function parsePageElement(el) {
  const baseLoc = getAttr(el, 'BaseLoc');
  const id = getAttrInt(el, 'ID');
  return new PageElement(baseLoc, id);
}

function parsePageListElement(el) {
  const pageEls = getChildren(el, 'Page');
  const page = pageEls.map(parsePageElement);
  return new PageList(page);
}

function parseDocumentElement(el) {
  const commonDataEl = getChild(el, 'CommonData');
  const commonData = commonDataEl ? parseCommonDataElement(commonDataEl) : new CommonData();

  const pagesEl = getChild(el, 'Pages');
  const pages = pagesEl ? parsePageListElement(pagesEl) : new PageList();

  // Annotations is a text element containing the path to Annotations.xml
  const annotationsEl = getChild(el, 'Annotations');
  const annotations = annotationsEl ? getTextContent(annotationsEl) : null;

  const customTagsEl = getChild(el, 'CustomTags');
  const customTags = customTagsEl ? getTextContent(customTagsEl) : null;

  return new Document(commonData, pages, annotations, customTags);
}

function parseMultiMediaElement(el) {
  const id = getAttrInt(el, 'ID') || 0;
  const format = getAttr(el, 'Format') || '';
  const mediaFile = getTextContent(getChild(el, 'MediaFile'));
  return new MultiMedia(id, format, mediaFile);
}

function parseMultiMediasElement(el) {
  const mmEls = getChildren(el, 'MultiMedia');
  const multiMedia = mmEls.map(parseMultiMediaElement);
  return new MultiMedias(multiMedia);
}

function parseDocumentResElement(el) {
  const baseLoc = getAttr(el, 'BaseLoc') || '';
  const multiMediasEl = getChild(el, 'MultiMedias');
  const multiMedias = multiMediasEl ? parseMultiMediasElement(multiMediasEl) : new MultiMedias();
  return new DocumentRes(baseLoc, multiMedias);
}

function parseFontElement(el) {
  const id = getAttrInt(el, 'ID') || 0;
  const familyName = getAttr(el, 'FamilyName') || '';
  const fontName = getAttr(el, 'FontName') || '';
  const boldAttr = getAttr(el, 'Bold');
  const italicAttr = getAttr(el, 'Italic');
  const serifAttr = getAttr(el, 'Serif');
  const fixedWidthAttr = getAttr(el, 'FixedWidth');
  const bold = boldAttr === 'true';
  const italic = italicAttr === 'true';
  const serif = serifAttr === 'true';
  const fixedWidth = fixedWidthAttr === 'true';
  return new Font(id, familyName, fontName, bold, italic, serif, fixedWidth);
}

function parseFontsElement(el) {
  const fontEls = getChildren(el, 'Font');
  const font = fontEls.map(parseFontElement);
  return new Fonts(font);
}

function parsePublicResElement(el) {
  const baseLoc = getAttr(el, 'BaseLoc') || '';
  const fontsEl = getChild(el, 'Fonts');
  const fonts = fontsEl ? parseFontsElement(fontsEl) : new Fonts();
  return new PublicRes(baseLoc, fonts);
}

function parseAnnotationPageNode(el) {
  const pageId = getAttrInt(el, 'PageID') || 0;
  // fileLoc is from the text content of <FileLoc> child element
  // or from the element's own text content (serde $value pattern)
  const fileLocEl = getChild(el, 'FileLoc');
  const fileLoc = fileLocEl ? getTextContent(fileLocEl) : getTextContent(el);
  return new AnnotationPageNode(pageId, fileLoc);
}

function parseAnnotationsElement(el) {
  const pageEls = getChildren(el, 'Page');
  const page = pageEls.map(parseAnnotationPageNode);
  return new Annotations(page);
}

function parsePageAnnotElement(el) {
  const annotEls = getChildren(el, 'Annot');
  const annot = annotEls.map(parseAnnotElement);
  return new PageAnnot(annot);
}

// ============================================================
// Public parse functions
// ============================================================

/**
 * Parse Document.xml content string into a Document object.
 * @param {string} xmlString - XML content of Document.xml
 * @returns {Document}
 */
export function parseDocumentXml(xmlString) {
  const doc = parseXml(xmlString);
  const root = doc.documentElement;
  return parseDocumentElement(root);
}

/**
 * Parse DocumentRes.xml content string into a DocumentRes object.
 * @param {string} xmlString - XML content of DocumentRes.xml
 * @returns {DocumentRes}
 */
export function parseDocumentResXml(xmlString) {
  const doc = parseXml(xmlString);
  const root = doc.documentElement;
  return parseDocumentResElement(root);
}

/**
 * Parse PublicRes.xml content string into a PublicRes object.
 * @param {string} xmlString - XML content of PublicRes.xml
 * @returns {PublicRes}
 */
export function parsePublicResXml(xmlString) {
  const doc = parseXml(xmlString);
  const root = doc.documentElement;
  return parsePublicResElement(root);
}

/**
 * Parse Annotations.xml content string into an Annotations object.
 * @param {string} xmlString - XML content of Annotations.xml
 * @returns {Annotations}
 */
export function parseAnnotationsXml(xmlString) {
  const doc = parseXml(xmlString);
  const root = doc.documentElement;
  return parseAnnotationsElement(root);
}

/**
 * Parse an annotation page XML (Annot_*.xml) into a PageAnnot object.
 * @param {string} xmlString - XML content of the annotation file
 * @returns {PageAnnot}
 */
export function parsePageAnnotXml(xmlString) {
  const doc = parseXml(xmlString);
  const root = doc.documentElement;
  return parsePageAnnotElement(root);
}