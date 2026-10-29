// Public API and orchestration — mirrors src/lib.rs
// This is the entry point for the JS OFD reader library.
// Provides: readOfd, renderOfdToCanvas, renderPageToCanvas, exportOfdToPng,
//           getPageCount, getPageDimensions

import { parseOfdXml, OfdNode } from './ofd.js';
import { parseDocumentXml, parseDocumentResXml, parsePublicResXml, parseAnnotationsXml, parsePageAnnotXml } from './document.js';
import { parsePageXml } from './page.js';
import { renderPage } from './render.js';
import { parentDir, resolvePath, resolveResourcePath, resolveAnnotPath, resolvePagePath } from './path-resolver.js';
import { mmtopx, PageArea as CtPageArea } from './types.js';

// ============================================================
// JSZip loader — handles both browser (global) and Node.js (import)
// ============================================================

let _JSZip = null;

async function getJSZip() {
  if (_JSZip) return _JSZip;

  // Browser: JSZip loaded via <script> tag (global)
  if (typeof window !== 'undefined' && window.JSZip) {
    _JSZip = window.JSZip;
    return _JSZip;
  }

  // Node.js / ESM environment: try dynamic import
  try {
    const module = await import('jszip');
    _JSZip = module.default || module;
    return _JSZip;
  } catch (e) {
    throw new Error('JSZip is required but not available. Install it via npm (jszip) or load via <script> tag in browser.');
  }
}

// ============================================================
// Ofd class — runtime container for parsed data + ZIP archive
// ============================================================

/**
 * Ofd — the top-level runtime object.
 * Holds parsed OFD metadata, the open ZIP archive for lazy resource reads,
 * pre-loaded images, and the parsed document structure.
 */
export class Ofd {
  constructor(node = null, zipArchive = null) {
    this.node = node;            // OfdNode (parsed from OFD.xml)
    this.zipArchive = zipArchive;  // JSZip instance
    this.images = new Map();      // resourceId → pre-loaded HTMLImageElement/Image
    this.document = null;         // Document (parsed from Document.xml chain)
  }

  /**
   * Read a text file from the ZIP archive by path.
   * @param {string} path - path within the ZIP (forward slashes, no leading /)
   * @returns {Promise<string>} text content of the file
   */
  async readFile(path) {
    // Strip leading slash if present — ZIP paths don't use leading /
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    const file = this.zipArchive.file(cleanPath);
    if (!file) {
      throw new Error(`File not found in ZIP: ${path}`);
    }
    return await file.async('string');
  }

  /**
   * Read a binary file from the ZIP archive by path.
   * @param {string} path - path within the ZIP
   * @returns {Promise<ArrayBuffer>} binary content of the file
   */
  async readBinaryFile(path) {
    // Strip leading slash if present — ZIP paths don't use leading /
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    const file = this.zipArchive.file(cleanPath);
    if (!file) {
      throw new Error(`File not found in ZIP: ${path}`);
    }
    return await file.async('arraybuffer');
  }
}

// ============================================================
// Core API functions
// ============================================================

/**
 * Read and parse an OFD file.
 * This is the main entry point — mirrors Rust's read_ofd() + render_ofd_to_context() pipeline.
 *
 * @param {File|Blob|ArrayBuffer|string} source - OFD file source:
 *   - File/Blob (from <input> or drag-drop)
 *   - ArrayBuffer (from fetch response)
 *   - string URL (for fetch in browser)
 * @returns {Promise<Ofd>} parsed Ofd object with all data ready for rendering
 */
export async function readOfd(source) {
  const JSZip = await getJSZip();
  let zipData;

  // Handle different source types
  if (typeof source === 'string') {
    // URL — fetch first
    const response = await fetch(source);
    zipData = await response.arrayBuffer();
  } else {
    // File, Blob, or ArrayBuffer — JSZip handles all of these
    zipData = source;
  }

  const zip = await JSZip.loadAsync(zipData);

  // Step 1: Parse OFD.xml
  const ofdXmlContent = await zip.file('OFD.xml').async('string');
  const ofdNode = parseOfdXml(ofdXmlContent);

  const ofd = new Ofd(ofdNode, zip);

  // Step 2: Parse Document.xml (DocRoot)
  const docRoot = ofdNode.docBody.docRoot;
  const docXmlContent = await ofd.readFile(docRoot);
  const document = parseDocumentXml(docXmlContent);

  // Step 3: Parse DocumentRes.xml (optional — some OFD files don't have it)
  if (document.commonData.documentRes) {
    const docResPath = resolvePath(docRoot, document.commonData.documentRes);
    try {
      const docResXmlContent = await ofd.readFile(docResPath);
      document.docRes = parseDocumentResXml(docResXmlContent);
    } catch (e) {
      console.warn('DocumentRes.xml not found or failed to parse:', docResPath);
      document.docRes = { baseLoc: '', multiMedias: { multiMedia: [] } };
    }
  } else {
    document.docRes = { baseLoc: '', multiMedias: { multiMedia: [] } };
  }

  // Step 4: Parse PublicRes.xml (optional — some OFD files don't have it)
  if (document.commonData.publicRes) {
    const publicResPath = resolvePath(docRoot, document.commonData.publicRes);
    try {
      const publicResXmlContent = await ofd.readFile(publicResPath);
      document.publicRes = parsePublicResXml(publicResXmlContent);
    } catch (e) {
      console.warn('PublicRes.xml not found or failed to parse:', publicResPath);
      document.publicRes = { baseLoc: '', fonts: { font: [] } };
    }
  } else {
    document.publicRes = { baseLoc: '', fonts: { font: [] } };
  }

  // Step 5: Parse Annotations.xml (if present)
  if (document.annotations) {
    try {
      const annotsPath = resolvePath(docRoot, document.annotations);
      const annotsXmlContent = await ofd.readFile(annotsPath);
      const annotations = parseAnnotationsXml(annotsXmlContent);

      // Parse each annotation page file
      for (const annotPage of annotations.page) {
        const annotFilePath = resolveAnnotPath(docRoot, annotPage.fileLoc);
        try {
          const annotFileContent = await ofd.readFile(annotFilePath);
          const pageAnnot = parsePageAnnotXml(annotFileContent);
          // Store annotations for later use (could attach to pages by PageID)
          console.log('Parsed annotation page:', annotPage.pageId, pageAnnot);
        } catch (e) {
          console.warn('Failed to parse annotation file:', annotFilePath, e);
        }
      }
    } catch (e) {
      console.warn('Failed to parse Annotations.xml:', e);
    }
  }

  // Step 6: Parse and store template page content
  ofd.templates = new Map();  // templateId → parsed Page object
  if (document.commonData.templatePages && document.commonData.templatePages.length > 0) {
    for (const tpl of document.commonData.templatePages) {
      if (!tpl.baseLoc) continue;
      try {
        const tplPath = resolvePath(docRoot, tpl.baseLoc);
        const tplXmlContent = await ofd.readFile(tplPath);
        const tplPage = parsePageXml(tplXmlContent);
        ofd.templates.set(tpl.id, tplPage);
        console.log('Loaded template:', tpl.id, tpl.baseLoc, 'events:', tplPage.content.layer.events.length);
      } catch (e) {
        console.warn('Failed to load template:', tpl.id, tpl.baseLoc, e);
      }
    }
  }

  // Step 7: Pre-load all image resources
  await preloadImages(ofd, document);

  // Store document in Ofd object
  ofd.document = document;

  return ofd;
}

/**
 * Determine image MIME type from format attribute or file extension.
 * @param {string} format - Format attribute from MultiMedia (may be empty)
 * @param {string} mediaFile - Media file name (e.g. "image.JPG", "photo.png")
 * @returns {{mime: string, supported: boolean}} mime type and whether it's supported
 */
function getImageMimeAndSupport(format, mediaFile) {
  // Normalize format: could be empty, "PNG", "png", "JPG", "JB2", etc.
  const fmt = (format || '').toUpperCase().trim();

  // Try file extension as fallback
  const ext = mediaFile.split('.').pop().toUpperCase().trim();

  // Determine the effective format (attribute first, then extension)
  const effectiveFmt = fmt || ext;

  switch (effectiveFmt) {
    case 'PNG':
      return { mime: 'image/png', supported: true };
    case 'JPG':
    case 'JPEG':
      return { mime: 'image/jpeg', supported: true };
    case 'JB2':
    case 'JBIG2':
      return { mime: 'image/jbig2', supported: false };
    case 'TIFF':
    case 'TIF':
      return { mime: 'image/tiff', supported: false };
    case 'BMP':
      return { mime: 'image/bmp', supported: false };
    case 'GIF':
      return { mime: 'image/gif', supported: true };
    default:
      // Unknown format — try based on extension if format attribute was empty
      if (!fmt && ext) {
        // If extension is known image format, try it
        if (['JPG', 'JPEG', 'PNG', 'GIF', 'WEBP'].includes(ext)) {
          const mimeMap = { JPG: 'image/jpeg', JPEG: 'image/jpeg', PNG: 'image/png', GIF: 'image/gif', WEBP: 'image/webp' };
          return { mime: mimeMap[ext], supported: true };
        }
      }
      return { mime: '', supported: false };
  }
}

/**
 * Pre-load all image resources from the ZIP into Image objects.
 * This makes rendering synchronous — no async image loading during render.
 * Supports PNG and JPG/JPEG formats. JB2/JBIG2 and others are skipped.
 *
 * @param {Ofd} ofd - the Ofd object with ZIP archive
 * @param {Object} document - parsed Document with docRes
 */
async function preloadImages(ofd, document) {
  if (!document.docRes || !document.docRes.multiMedias) return;

  const docRoot = ofd.node.docBody.docRoot;
  const resBaseLoc = document.docRes.baseLoc;

  for (const mm of document.docRes.multiMedias.multiMedia) {
    const { mime, supported } = getImageMimeAndSupport(mm.format, mm.mediaFile);

    if (!supported) {
      console.warn('Skipping unsupported media format:', mm.format || '(empty)', mm.mediaFile);
      continue;
    }

    const imagePath = resolveResourcePath(docRoot, resBaseLoc, mm.mediaFile);

    try {
      const buffer = await ofd.readBinaryFile(imagePath);

      // Store raw buffer for both browser and Node.js rendering
      // In browser: create Image element from Blob URL
      // In Node.js: store raw ArrayBuffer (canvas package can use Buffer directly)
      const isBrowser = typeof Image !== 'undefined' && typeof Blob !== 'undefined';

      if (isBrowser) {
        const blob = new Blob([buffer], { type: mime });
        const url = URL.createObjectURL(blob);

        const img = new Image();
        img.src = url;

        // Wait for image to load
        await new Promise((resolve, reject) => {
          img.onload = () => {
            URL.revokeObjectURL(url);
            resolve();
          };
          img.onerror = () => {
            console.warn('Failed to load image:', imagePath);
            URL.revokeObjectURL(url);
            reject(new Error('Image load failed: ' + imagePath));
          };
        });

        ofd.images.set(mm.id, img);
      } else {
        // Node.js: store the raw buffer for later use with node-canvas
        ofd.images.set(mm.id, { buffer, format: 'png', width: 0, height: 0 });
      }
    } catch (e) {
      console.warn('Failed to extract image from ZIP:', imagePath, e);
    }
  }
}

/**
 * Render an OFD document to a Canvas element.
 * Renders all pages sequentially (clearing canvas between each page for multi-page docs).
 * For single-page viewing, use renderPageToCanvas instead.
 *
 * @param {Ofd} ofd - parsed Ofd object from readOfd
 * @param {HTMLCanvasElement} canvas - the canvas element to render on
 * @param {Object} [options] - optional settings
 * @param {number} [options.dpi=97] - dots per inch for mm→px conversion
 * @param {number} [options.scale=1] - additional scale factor
 * @returns {Promise<void>}
 */
export async function renderOfdToCanvas(ofd, canvas, options = {}) {
  const { dpi = 97, scale = 1 } = options;
  const document = ofd.document;

  // Calculate page dimensions from first page's PhysicalBox
  const pages = document.pages.page;
  if (pages.length === 0) {
    throw new Error('No pages found in document');
  }

  // Read and render each page
  for (let i = 0; i < pages.length; i++) {
    await renderPageToCanvas(ofd, i, canvas, options);
  }
}

/**
 * Render a specific page to a Canvas element.
 *
 * @param {Ofd} ofd - parsed Ofd object
 * @param {number} pageIndex - page index (0-based)
 * @param {HTMLCanvasElement} canvas - the canvas element
 * @param {Object} [options] - optional settings
 * @param {number} [options.dpi=97] - dots per inch
 * @param {number} [options.scale=1] - additional scale factor
 * @returns {Promise<void>}
 */
export async function renderPageToCanvas(ofd, pageIndex, canvas, options = {}) {
  const { dpi = 97, scale = 1 } = options;
  const document = ofd.document;
  const docRoot = ofd.node.docBody.docRoot;

  const pageInfo = document.pages.page[pageIndex];
  if (!pageInfo || !pageInfo.baseLoc) {
    throw new Error(`Page ${pageIndex} not found or has no BaseLoc`);
  }

  // Read page XML from ZIP
  const pagePath = resolvePagePath(docRoot, pageInfo.baseLoc);
  const pageXmlContent = await ofd.readFile(pagePath);
  const page = parsePageXml(pageXmlContent);

  // Set canvas dimensions based on page PhysicalBox
  const pageArea = CtPageArea.from(page.area.physicalBox).toPixel(dpi);
  canvas.width = Math.round(pageArea.width * scale);
  canvas.height = Math.round(pageArea.height * scale);

  // Get Canvas2D context
  const ctx = canvas.getContext('2d');

  // Apply scale factor
  if (scale !== 1) {
    ctx.scale(scale, scale);
  }

  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Render the page
  renderPage(page, ctx, ofd, document);
}

/**
 * Export an OFD document page to PNG.
 * Creates an OffscreenCanvas (or regular canvas) and renders to it.
 *
 * @param {Ofd} ofd - parsed Ofd object
 * @param {number} [pageIndex=0] - page index to export
 * @param {Object} [options] - optional settings (dpi, scale)
 * @returns {Promise<Blob>} PNG image blob
 */
export async function exportOfdToPng(ofd, pageIndex = 0, options = {}) {
  // Use OffscreenCanvas if available, otherwise create a temporary canvas
  let canvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    const dims = getPageDimensions(ofd, pageIndex);
    const pageArea = CtPageArea.from(`${dims.x} ${dims.y} ${dims.width} ${dims.height}`).toPixel(options.dpi || 97);
    const scale = options.scale || 1;
    canvas = new OffscreenCanvas(Math.round(pageArea.width * scale), Math.round(pageArea.height * scale));
  } else {
    // Browser fallback: create a temporary canvas element
    canvas = document.createElement('canvas');
  }

  await renderPageToCanvas(ofd, pageIndex, canvas, options);

  // Convert to PNG blob
  if (canvas instanceof OffscreenCanvas) {
    return await canvas.convertToBlob({ type: 'image/png' });
  } else {
    return new Promise((resolve) => {
      canvas.toBlob(resolve, 'image/png');
    });
  }
}

/**
 * Get the number of pages in the OFD document.
 * @param {Ofd} ofd - parsed Ofd object
 * @returns {number} page count
 */
export function getPageCount(ofd) {
  return ofd.document.pages.page.length;
}

/**
 * Get the dimensions of a page in millimeters.
 * Reads the actual page's PhysicalBox (which may differ from document-level PhysicalBox).
 * Falls back to document-level PhysicalBox if the page XML can't be read.
 *
 * @param {Ofd} ofd - parsed Ofd object
 * @param {number} [pageIndex=0] - page index
 * @returns {{x: number, y: number, width: number, height: number}} dimensions in mm
 */
export async function getPageDimensions(ofd, pageIndex = 0) {
  const document = ofd.document;
  const docRoot = ofd.node.docBody.docRoot;
  const pageInfo = document.pages.page[pageIndex];

  if (!pageInfo || !pageInfo.baseLoc) {
    throw new Error(`Page ${pageIndex} not found`);
  }

  // Try to read the actual page's PhysicalBox first (more accurate)
  try {
    const pagePath = resolvePagePath(docRoot, pageInfo.baseLoc);
    const pageXmlContent = await ofd.readFile(pagePath);
    const page = parsePageXml(pageXmlContent);
    const area = CtPageArea.from(page.area.physicalBox);
    return { x: area.x, y: area.y, width: area.width, height: area.height };
  } catch (e) {
    // Fall back to document-level CommonData PageArea
    const pageAreaStr = document.commonData.pageArea.physicalBox;
    const area = CtPageArea.from(pageAreaStr);
    return { x: area.x, y: area.y, width: area.width, height: area.height };
  }
}