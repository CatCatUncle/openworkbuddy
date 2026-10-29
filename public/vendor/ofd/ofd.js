// OFD.xml parsing — mirrors src/ofd.rs
// OFD.xml is the root entry point inside the ZIP archive.
// It contains DocBody which has DocInfo and a DocRoot path.

import { parseXml, getChild, getChildren, getAttr, getTextContent } from './xml-parser.js';

/**
 * CustomData — a key-value pair from the CustomDatas section.
 * name is from the "Name" attribute, value is the element's text content.
 * Maps Rust's serde rename="$value" pattern.
 */
export class CustomData {
  constructor(name = null, value = '') {
    this.name = name;
    this.value = value;
  }
}

/**
 * CustomDataList — container for multiple CustomData entries.
 */
export class CustomDataList {
  constructor(customData = []) {
    this.customData = customData;
  }
}

/**
 * DocInfo — document metadata from <DocInfo> element.
 */
export class DocInfo {
  constructor(docId = '', creationDate = '', creator = '', creatorVersion = '', modDate = '', customDatas = new CustomDataList()) {
    this.docId = docId;
    this.creationDate = creationDate;
    this.creator = creator;
    this.creatorVersion = creatorVersion;
    this.modDate = modDate;
    this.customDatas = customDatas;
  }
}

/**
 * DocBody — the main body of the OFD.xml, containing DocInfo and DocRoot path.
 */
export class DocBody {
  constructor(docInfo = new DocInfo(), docRoot = '') {
    this.docInfo = docInfo;
    this.docRoot = docRoot;
  }
}

/**
 * OfdNode — the root parsed structure from OFD.xml.
 */
export class OfdNode {
  constructor(docBody = new DocBody()) {
    this.docBody = docBody;
  }
}

// --- Parse helper functions (internal) ---

function parseCustomDataElement(el) {
  const name = getAttr(el, 'Name');
  const value = getTextContent(el);
  return new CustomData(name, value);
}

function parseCustomDataListElement(el) {
  const customDataEls = getChildren(el, 'CustomData');
  const customData = customDataEls.map(parseCustomDataElement);
  return new CustomDataList(customData);
}

function parseDocInfoElement(el) {
  const docId = getTextContent(getChild(el, 'DocID'));
  const creationDate = getTextContent(getChild(el, 'CreationDate'));
  const creator = getTextContent(getChild(el, 'Creator'));
  const creatorVersion = getTextContent(getChild(el, 'CreatorVersion'));
  const modDate = getTextContent(getChild(el, 'ModDate'));

  const customDatasEl = getChild(el, 'CustomDatas');
  let customDatas = new CustomDataList();
  if (customDatasEl) {
    customDatas = parseCustomDataListElement(customDatasEl);
  }

  return new DocInfo(docId, creationDate, creator, creatorVersion, modDate, customDatas);
}

function parseDocBodyElement(el) {
  const docInfoEl = getChild(el, 'DocInfo');
  const docInfo = docInfoEl ? parseDocInfoElement(docInfoEl) : new DocInfo();

  const docRootEl = getChild(el, 'DocRoot');
  const docRoot = getTextContent(docRootEl);

  return new DocBody(docInfo, docRoot);
}

// --- Public parse function ---

/**
 * Parse OFD.xml content string into an OfdNode.
 * @param {string} xmlString - XML content of OFD.xml
 * @returns {OfdNode} parsed OFD root node
 * @throws {Error} if XML parsing fails
 */
export function parseOfdXml(xmlString) {
  const doc = parseXml(xmlString);
  const root = doc.documentElement;

  // The root element is <ofd:OFD> or <OFD>
  // Its child is <ofd:DocBody> or <DocBody>
  const docBodyEl = getChild(root, 'DocBody');
  if (!docBodyEl) {
    throw new Error('OFD.xml: missing DocBody element');
  }

  const docBody = parseDocBodyElement(docBodyEl);
  return new OfdNode(docBody);
}