// Page content element types — mirrors src/elements.rs
// These are the XML deserialization types for visual content elements
// that appear inside page layers and page blocks.
// The Event enum in Rust is replaced by a dispatch function (parseLayerEvents)
// that returns heterogeneous objects based on element tag names.

import { parseXml, getChild, getChildren, getAttr, getAttrInt, getAttrFloat, getTextContent, getAllChildren, getTagName } from './xml-parser.js';

// ============================================================
// Raw XML deserialization Color type (distinct from types.js computed Color)
// ============================================================

/**
 * Color — raw XML deserialization form.
 * value is the raw string from XML (e.g. "128 0 0"), NOT a parsed array.
 * alpha is optional (from "Alpha" attribute on parent elements like TextObject).
 * For rendering, this raw Color.value string is passed to types.Color.from()
 * to get the computed [r,g,b] array.
 */
export class Color {
  constructor(value = '0 0 0', alpha = null) {
    this.value = value;
    this.alpha = alpha;
  }

  /** Default color: black with alpha 255 */
  static default() {
    return new Color('0 0 0', 255);
  }
}

// ============================================================
// TextCode
// ============================================================

/**
 * TextCode — text content within a TextObject.
 * x/y are offsets within the boundary (in mm).
 * deltaX is per-character horizontal offset string (e.g. "3.18 3.18 3.18" or "g 18 2.54").
 * value is the actual text content (from element textContent, maps serde $value).
 */
export class TextCode {
  constructor(x = 0, y = 0, deltaX = null, deltaY = null, value = '') {
    this.x = x;
    this.y = y;
    this.deltaX = deltaX;
    this.deltaY = deltaY;
    this.value = value;
  }
}

// ============================================================
// PathObject
// ============================================================

/**
 * PathObject — a path/stroke drawing element.
 * Currently only rendered as a rectangle from boundary (AbbreviatedData not parsed).
 * Supports Fill and Stroke attributes, FillColor and StrokeColor.
 */
export class PathObject {
  constructor(id = 0, boundary = '', lineWidth = 0, stroke = null, fill = null, strokeColor = null, fillColor = null, ctm = null) {
    this.id = id;
    this.boundary = boundary;
    this.lineWidth = lineWidth;
    this.stroke = stroke;        // boolean (from "Stroke" attribute) or null
    this.fill = fill;            // boolean (from "Fill" attribute) or null
    this.strokeColor = strokeColor;  // Color (raw) or null
    this.fillColor = fillColor;      // Color (raw) or null
    this.ctm = ctm;                  // string (raw) or null
  }
}

// ============================================================
// TextObject
// ============================================================

/**
 * TextObject — a text drawing element.
 * font is a resource ID referencing PublicRes.fonts.
 * fillColor is optional Color (defaults to black when null).
 * textCode contains the text content and positioning.
 * ctm is optional coordinate transform matrix string.
 * alpha is optional transparency value (NOT used in rendering, matching Rust).
 * ReadDirection: reading direction (0=left-to-right, 90=top-to-bottom/vertical,
 *   180=right-to-left, 270=bottom-to-top). Default 0.
 * CharDirection: individual character drawing direction/baseline angle
 *   (0=default upright, 90=rotated 90° clockwise, 180=rotated 180°, 270=rotated 270°).
 *   Default 0.
 * HScale: horizontal scaling factor. Default 1.0.
 * Weight: font weight (0/100/200/300/400/500/600/700/800/900). Default 400.
 * Italic: whether italic font style. Default false.
 * Stroke: whether text should be stroked (outlined). Default false.
 * StrokeColor: color for text stroke. Optional.
 */
export class TextObject {
  constructor(id = 0, boundary = '', font = 0, size = 0, fillColor = null, textCode = new TextCode(), ctm = null, alpha = null, readDirection = 0, charDirection = 0, hScale = 1.0, weight = 400, italic = false, stroke = false, strokeColor = null) {
    this.id = id;
    this.boundary = boundary;
    this.font = font;
    this.size = size;
    this.fillColor = fillColor;  // Color (raw) or null
    this.textCode = textCode;
    this.ctm = ctm;              // string (raw) or null
    this.alpha = alpha;          // float or null
    this.readDirection = readDirection;    // int: 0, 90, 180, 270
    this.charDirection = charDirection;    // int: 0, 90, 180, 270
    this.hScale = hScale;                // float: default 1.0
    this.weight = weight;                // int: default 400
    this.italic = italic;                // boolean: default false
    this.stroke = stroke;                // boolean: default false (Stroke attribute on TextObject)
    this.strokeColor = strokeColor;      // Color (raw) or null
  }
}

// ============================================================
// ImageObject
// ============================================================

/**
 * ImageObject — an image drawing element.
 * ctm is required (NOT optional, unlike PathObject/TextObject).
 * resourceId references a MultiMedia entry in DocumentRes.
 */
export class ImageObject {
  constructor(id = 0, boundary = '', ctm = '', resourceId = 0) {
    this.id = id;
    this.boundary = boundary;
    this.ctm = ctm;
    this.resourceId = resourceId;
  }
}

// ============================================================
// PageBlock
// ============================================================

/**
 * PageBlock — a container for nested content elements.
 * events is an array of heterogeneous objects (PathObject, TextObject,
 * ImageObject, or nested PageBlock). This is recursive.
 */
export class PageBlock {
  constructor(id = 0, events = []) {
    this.id = id;
    this.events = events;
  }
}

// ============================================================
// Annot & Appearance (annotation types, also used in document.js)
// ============================================================

/**
 * Annot — an annotation (e.g. stamp/seal).
 * type can be "Stamp" etc.
 */
export class Annot {
  constructor(id = 0, type = '', creator = '', lastModDate = '', appearance = null) {
    this.id = id;
    this.type = type;
    this.creator = creator;
    this.lastModDate = lastModDate;
    this.appearance = appearance;  // Appearance or null
  }
}

/**
 * Appearance — visual representation of an annotation.
 * Contains a boundary string and an ImageObject.
 */
export class Appearance {
  constructor(boundary = '', imageObject = null) {
    this.boundary = boundary;
    this.imageObject = imageObject;  // ImageObject or null
  }
}

// ============================================================
// Parser functions
// ============================================================

/**
 * Parse a <StrokeColor Value="128 0 0"/> or <FillColor Value="128 0 0"/> element.
 * Color element may also have an Alpha attribute.
 * Value may be in integer format ("128 0 0") or hex format ("#ee #20 #25").
 */
function parseColorElement(el) {
  const value = getAttr(el, 'Value') || '0 0 0';
  const alpha = getAttrFloat(el, 'Alpha');
  return new Color(value, alpha);
}

/**
 * Parse a <TextCode X="0" Y="3" DeltaX="3 3 3 3">text content</TextCode> element.
 */
function parseTextCodeElement(el) {
  const x = getAttrFloat(el, 'X') || 0;
  const y = getAttrFloat(el, 'Y') || 0;
  const deltaX = getAttr(el, 'DeltaX');  // may be empty string "", treat as null if empty
  const deltaY = getAttr(el, 'DeltaY');  // same format as DeltaX, may contain "g" notation
  const value = getTextContent(el);
  return new TextCode(
    x, y,
    deltaX && deltaX.length > 0 ? deltaX : null,
    deltaY && deltaY.length > 0 ? deltaY : null,
    value
  );
}

/**
 * Parse a PathObject element.
 * XML: <ofd:PathObject Boundary="10 30 95.30 0.30" ID="12" LineWidth="0.3" Stroke="true" Fill="true" CTM="...">
 *        <ofd:StrokeColor Value="128 0 0"/>
 *        <ofd:FillColor Value="0 0 0"/>
 *        <ofd:AbbreviatedData>M 0 0.15 L 95.30 0.15</ofd:AbbreviatedData>  (not parsed)
 *      </ofd:PathObject>
 */
export function parsePathObject(el) {
  const id = getAttrInt(el, 'ID') || 0;
  const boundary = getAttr(el, 'Boundary') || '';
  const lineWidth = getAttrFloat(el, 'LineWidth') || 0;
  const strokeAttr = getAttr(el, 'Stroke');  // string "true"/"false" or null
  const fillAttr = getAttr(el, 'Fill');      // string "true"/"false" or null
  const strokeColorEl = getChild(el, 'StrokeColor');
  const strokeColor = strokeColorEl ? parseColorElement(strokeColorEl) : null;
  const fillColorEl = getChild(el, 'FillColor');
  const fillColor = fillColorEl ? parseColorElement(fillColorEl) : null;
  const ctm = getAttr(el, 'CTM');

  // Convert string booleans
  const strokeBool = strokeAttr === 'true' ? true : strokeAttr === 'false' ? false : null;
  const fillBool = fillAttr === 'true' ? true : fillAttr === 'false' ? false : null;

  return new PathObject(id, boundary, lineWidth, strokeBool, fillBool, strokeColor, fillColor, ctm);
}

/**
 * Parse a TextObject element.
 * XML: <ofd:TextObject Boundary="69 8 70 9" Font="5" ID="40" Size="7.0" Alpha="127" CTM="...">
 *        <ofd:FillColor Value="128 0 0"/>
 *        <ofd:TextCode DeltaX="7 7 7" X="0" Y="7">text</ofd:TextCode>
 *      </ofd:TextObject>
 */
export function parseTextObject(el) {
  const id = getAttrInt(el, 'ID') || 0;
  const boundary = getAttr(el, 'Boundary') || '';
  const font = getAttrInt(el, 'Font') || 0;
  const size = getAttrFloat(el, 'Size') || 0;
  const alpha = getAttrFloat(el, 'Alpha');
  const ctm = getAttr(el, 'CTM');
  const readDirection = getAttrInt(el, 'ReadDirection') || 0;
  const charDirection = getAttrInt(el, 'CharDirection') || 0;
  const hScale = getAttrFloat(el, 'HScale') || 1.0;
  const weight = getAttrInt(el, 'Weight') || 400;
  const italicAttr = getAttr(el, 'Italic');    // "true"/"false" or null
  const italicBool = italicAttr === 'true';
  const strokeAttr = getAttr(el, 'Stroke');    // "true"/"false" or null (OFD default false)
  const strokeBool = strokeAttr === 'true';

  const fillColorEl = getChild(el, 'FillColor');
  const fillColor = fillColorEl ? parseColorElement(fillColorEl) : null;

  const strokeColorEl = getChild(el, 'StrokeColor');
  const strokeColor = strokeColorEl ? parseColorElement(strokeColorEl) : null;

  const textCodeEl = getChild(el, 'TextCode');
  const textCode = textCodeEl ? parseTextCodeElement(textCodeEl) : new TextCode();

  return new TextObject(id, boundary, font, size, fillColor, textCode, ctm, alpha, readDirection, charDirection, hScale, weight, italicBool, strokeBool, strokeColor);
}

/**
 * Parse an ImageObject element.
 * XML: <ofd:ImageObject Boundary="7 6 20 20" CTM="20.50 0 0 20.50 0 0" ID="37" ResourceID="36"/>
 */
export function parseImageObject(el) {
  const id = getAttrInt(el, 'ID') || 0;
  const boundary = getAttr(el, 'Boundary') || '';
  const ctm = getAttr(el, 'CTM') || '';
  const resourceId = getAttrInt(el, 'ResourceID') || 0;
  return new ImageObject(id, boundary, ctm, resourceId);
}

/**
 * Parse a PageBlock element.
 * XML: <ofd:PageBlock ID="35">
 *        ... nested content elements (PathObject, TextObject, ImageObject, PageBlock) ...
 *      </ofd:PageBlock>
 * This is recursive — PageBlock can contain other PageBlocks.
 */
export function parsePageBlock(el) {
  const id = getAttrInt(el, 'ID') || 0;
  const events = parseLayerEvents(el);
  return new PageBlock(id, events);
}

/**
 * Parse an Appearance element.
 * XML: <ofd:Appearance Boundary="87.50 8.50 30 20">
 *        <ofd:ImageObject ID="175" ResourceID="174" Boundary="0 0 30 20" CTM="30 0 0 20 0 0"/>
 *      </ofd:Appearance>
 */
function parseAppearanceElement(el) {
  const boundary = getAttr(el, 'Boundary') || '';
  const imageObjectEl = getChild(el, 'ImageObject');
  const imageObject = imageObjectEl ? parseImageObject(imageObjectEl) : null;
  return new Appearance(boundary, imageObject);
}

/**
 * Parse an Annot element.
 * XML: <ofd:Annot Type="Stamp" Creator="OFD R&W" LastModDate="2024-10-22" ID="173">
 *        <ofd:Appearance Boundary="87.50 8.50 30 20">...</ofd:Appearance>
 *      </ofd:Annot>
 */
export function parseAnnotElement(el) {
  const id = getAttrInt(el, 'ID') || 0;
  const type = getAttr(el, 'Type') || '';
  const creator = getAttr(el, 'Creator') || '';
  const lastModDate = getAttr(el, 'LastModDate') || '';

  const appearanceEl = getChild(el, 'Appearance');
  const appearance = appearanceEl ? parseAppearanceElement(appearanceEl) : null;

  return new Annot(id, type, creator, lastModDate, appearance);
}

// ============================================================
// Core dispatch function — replaces Rust Event enum
// ============================================================

/**
 * Parse all direct child elements of a container (Layer or PageBlock)
 * and dispatch them to the appropriate parser based on their tag name.
 * This is the JS equivalent of Rust's serde Event enum + $value pattern.
 *
 * @param {Element} parentEl - the container element (Layer or PageBlock)
 * @returns {Array} heterogeneous array of PathObject, TextObject, ImageObject, PageBlock instances
 */
export function parseLayerEvents(parentEl) {
  const events = [];
  const children = getAllChildren(parentEl);

  for (const child of children) {
    const tag = getTagName(child);
    switch (tag) {
      case 'PathObject':
        events.push(parsePathObject(child));
        break;
      case 'TextObject':
        events.push(parseTextObject(child));
        break;
      case 'ImageObject':
        events.push(parseImageObject(child));
        break;
      case 'PageBlock':
        events.push(parsePageBlock(child));
        break;
      // Ignore unknown elements (AbbreviatedData, etc.)
    }
  }

  return events;
}