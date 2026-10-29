// Canvas2D rendering implementations — mirrors src/render.rs
// Maps Cairo API calls to HTML5 Canvas2D API.
// Improvements beyond Rust implementation:
//   - ReadDirection/CharDirection support (horizontal + vertical layout)
//   - DeltaX + DeltaY per-character spacing (independent of ReadDirection)
//   - DeltaY in LTR mode enables vertical stacking (e.g. "密码区" labels)
//   - Stroke text uses per-character positioning to match fill layout
//   - HScale (horizontal scaling) support
//   - Weight (font weight) support
//   - Alpha transparency rendering
// Current limitations (matching Rust):
//   - PathObject rendered as rectangle (AbbreviatedData not parsed)
//   - CTM not applied to PathObject
//   - Only PNG images supported

import { mmtopx, Box, Color as CtColor, Matrix } from './types.js';
import { PathObject, TextObject, ImageObject, PageBlock, Color as ElColor } from './elements.js';

// For Node.js canvas: try to load the Canvas Image class
// In ESM context, require() may not work, so we use dynamic import
let CanvasImage = null;

async function loadCanvasImage() {
  try {
    const canvasModule = await import('canvas');
    CanvasImage = canvasModule.Image;
  } catch (e) {
    // Not in node-canvas environment (browser, or canvas package not installed)
  }
}

// Eagerly try synchronous require (works in CJS-style ESM bundling)
// Guard: require is not defined in pure ESM, ReferenceError is not caught by try/catch
if (typeof require !== 'undefined') {
  try {
    const canvasModule = require('canvas');
    CanvasImage = canvasModule.Image;
  } catch (e) {
    // canvas not installed or build failed — will use dynamic import when needed
  }
}

// ============================================================
// Cairo → Canvas2D API mapping reference:
//   context.save()          → ctx.save()
//   context.restore()       → ctx.restore()
//   set_source_rgb(r,g,b)   → ctx.strokeStyle/fillStyle = rgb string
//   set_line_width(w)       → ctx.lineWidth = w
//   move_to(x,y)            → ctx.moveTo(x,y)
//   line_to(x,y)            → ctx.lineTo(x,y)
//   stroke()                → ctx.stroke()
//   translate(x,y)          → ctx.translate(x,y)
//   transform(matrix)       → ctx.transform(a,b,c,d,e,f)
//   select_font_face(name)  → ctx.font string
//   set_font_size(size)     → ctx.font string
//   show_text(text)         → ctx.fillText(text,x,y)
//   scale(sx,sy)            → ctx.scale(sx,sy)
//   set_source_surface+paint → ctx.drawImage(img,x,y,w,h)
// ============================================================

/**
 * Render a PathObject to Canvas2D context.
 * Currently only draws a rectangle from boundary coordinates.
 * AbbreviatedData (SVG-like path commands) is NOT parsed or rendered.
 * CTM transformation is NOT applied (matching Rust TODO).
 *
 * @param {PathObject} pathObj - the path object to render
 * @param {CanvasRenderingContext2D} ctx - Canvas2D context
 */
export function renderPathObject(pathObj, ctx) {
  ctx.save();

  const boundary = Box.from(pathObj.boundary).toPixel();

  // Draw rectangle path (matching Rust: move_to + line_to 4 corners clockwise)
  ctx.beginPath();
  ctx.moveTo(boundary.x, boundary.y);
  ctx.lineTo(boundary.x + boundary.width, boundary.y);
  ctx.lineTo(boundary.x + boundary.width, boundary.y + boundary.height);
  ctx.lineTo(boundary.x, boundary.y + boundary.height);
  ctx.closePath();

  // Handle fill: use FillColor when Fill=true or when FillColor is present without explicit Fill=false
  const shouldFill = pathObj.fill === true || (pathObj.fill === null && pathObj.fillColor !== null);
  if (shouldFill) {
    let fillColor;
    if (pathObj.fillColor && pathObj.fillColor.value) {
      fillColor = CtColor.from(pathObj.fillColor.value);
    } else {
      fillColor = CtColor.from('0 0 0');
    }
    ctx.fillStyle = fillColor.toRgbString();
    ctx.fill();
  }

  // Handle stroke: use StrokeColor when Stroke=true or when StrokeColor is present without explicit Stroke=false
  const shouldStroke = pathObj.stroke === true || (pathObj.stroke === null && pathObj.strokeColor !== null);
  if (shouldStroke) {
    let strokeColor;
    if (pathObj.strokeColor && pathObj.strokeColor.value) {
      strokeColor = CtColor.from(pathObj.strokeColor.value);
    } else {
      strokeColor = CtColor.from('0 0 0');
    }
    ctx.strokeStyle = strokeColor.toRgbString();
    ctx.lineWidth = mmtopx(pathObj.lineWidth);
    ctx.stroke();
  }

  // Default: if neither fill nor stroke specified, stroke with black (matching Rust behavior)
  if (!shouldFill && !shouldStroke) {
    const strokeColor = CtColor.from('0 0 0');
    ctx.strokeStyle = strokeColor.toRgbString();
    ctx.lineWidth = mmtopx(pathObj.lineWidth);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Render a TextObject to Canvas2D context.
 * Supports ReadDirection (0=LTR, 90=top-to-bottom/vertical, 180=RTL, 270=bottom-to-top),
 * CharDirection (individual character rotation 0/90/180/270),
 * DeltaX/DeltaY "g N X" repeat notation for per-character spacing,
 * HScale (horizontal scaling), Weight (font weight), Alpha, and CTM.
 *
 * OFD text positioning mechanism:
 *   - DeltaX and DeltaY are per-character offsets INDEPENDENT of ReadDirection.
 *     Each character's position = accumulated DeltaX (X axis) + accumulated DeltaY (Y axis).
 *   - ReadDirection controls the default advance direction:
 *     - 0 (LTR): default advance is X axis (DeltaX); DeltaY provides vertical offsets
 *     - 90 (vertical): default advance is Y axis (DeltaY); DeltaX provides horizontal adjustments
 *     - 180 (RTL): default advance is negative X axis
 *     - 270 (reverse vertical): default advance is negative Y axis
 *   - When DeltaY is present with ReadDirection=0, characters stack vertically
 *     (e.g. "密码区" with DeltaY="6.35 6.35" renders as three chars top-to-bottom)
 *   - CharDirection rotates individual characters (e.g. 90° for vertical labels)
 *
 * @param {TextObject} textObj - the text object to render
 * @param {CanvasRenderingContext2D} ctx - Canvas2D context
 * @param {Object} document - the parsed Document (for font lookup)
 */
export function renderTextObject(textObj, ctx, document) {
  ctx.save();

  const boundary = Box.from(textObj.boundary).toPixel();

  // Fill color: default to black if not specified
  let fillColor;
  if (textObj.fillColor && textObj.fillColor.value) {
    fillColor = CtColor.from(textObj.fillColor.value);
  } else {
    fillColor = CtColor.from(ElColor.default().value);  // "0 0 0" → black
  }

  // Alpha: apply transparency if specified (0-255, default 255)
  if (textObj.alpha !== null && textObj.alpha !== undefined) {
    ctx.globalAlpha = Math.min(1, Math.max(0, textObj.alpha / 255));
  }

  // Find font by ID in document.publicRes.fonts.font
  let fontFamily = 'sans-serif';
  let fontBold = false;
  let fontItalic = false;
  if (document && document.publicRes && document.publicRes.fonts) {
    for (const font of document.publicRes.fonts.font) {
      if (font.id === textObj.font) {
        fontFamily = font.familyName;
        fontBold = font.bold;
        fontItalic = font.italic;
        break;
      }
    }
  }

  // Font weight: combine OFD Weight attribute with Font Bold attribute
  // Weight >= 700 or Bold=true → bold rendering
  const isBold = textObj.weight >= 700 || fontBold;
  const fontWeight = isBold ? 'bold' : textObj.weight >= 500 ? '600' : 'normal';

  // Font italic: combine TextObject Italic attribute with Font Italic attribute
  const isItalic = textObj.italic || fontItalic;

  // Set font: italic + Weight + Size + FontFamily
  const fontSize = mmtopx(textObj.size);
  const fontStyle = isItalic ? 'italic' : '';
  ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px "${fontFamily}"`;

  // Set fill color
  ctx.fillStyle = fillColor.toRgbString();

  // Translate to position (boundary + text code offsets)
  ctx.translate(
    boundary.x + mmtopx(textObj.textCode.x),
    boundary.y + mmtopx(textObj.textCode.y)
  );

  // Apply HScale (horizontal scaling factor, default 1.0)
  // HScale stretches text horizontally; it scales the X axis only
  if (textObj.hScale !== null && textObj.hScale !== undefined && textObj.hScale !== 1.0) {
    ctx.scale(textObj.hScale, 1.0);
  }

  // Apply CTM if present
  if (textObj.ctm) {
    const matrix = Matrix.from(textObj.ctm);
    ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
  }

  // Render text according to ReadDirection and CharDirection
  const textValue = textObj.textCode.value;
  const deltaX = textObj.textCode.deltaX;
  const deltaY = textObj.textCode.deltaY;
  const readDir = textObj.readDirection || 0;
  const charDir = textObj.charDirection || 0;

  // Expand delta notations
  const expandedDeltaX = deltaX && deltaX.trim().length > 0
    ? expandDeltaNotation(deltaX, fontSize) : null;
  const expandedDeltaY = deltaY && deltaY.trim().length > 0
    ? expandDeltaNotation(deltaY, fontSize) : null;

  if (readDir === 90 || readDir === 270) {
    // Vertical text layout (竖排): characters arranged top-to-bottom (90) or bottom-to-top (270)
    renderVerticalText(textObj, ctx, textValue, expandedDeltaX, expandedDeltaY, readDir, charDir, fontSize);
  } else if (readDir === 180) {
    // Right-to-left horizontal layout: characters arranged right-to-left
    renderRTLText(textObj, ctx, textValue, expandedDeltaX, expandedDeltaY, charDir, fontSize);
  } else {
    // Default: horizontal left-to-right (ReadDirection=0)
    renderLTRText(textObj, ctx, textValue, expandedDeltaX, expandedDeltaY, charDir, fontSize);
  }

  // Handle text stroke (Stroke attribute on TextObject, default false)
  // OFD: Stroke=true means text outline is drawn with StrokeColor
  // Must use per-character positioning (same as fill) to match DeltaX/DeltaY layout
  if (textObj.stroke) {
    let strokeColor;
    if (textObj.strokeColor && textObj.strokeColor.value) {
      strokeColor = CtColor.from(textObj.strokeColor.value);
    } else {
      strokeColor = fillColor;  // fallback to fill color if StrokeColor not specified
    }
    ctx.strokeStyle = strokeColor.toRgbString();
    ctx.lineWidth = 1;  // default stroke width for text outline

    // Re-render stroke using the same per-character positioning logic as fill
    const strokeChars = [...textValue];
    if (readDir === 90 || readDir === 270) {
      // Vertical stroke (per-character with DeltaY)
      const topToBottom = readDir === 90;
      let totalHeight = 0;
      if (!topToBottom) {
        if (expandedDeltaY) {
          for (let i = 0; i < Math.min(expandedDeltaY.length, strokeChars.length - 1); i++) {
            totalHeight += mmtopx(expandedDeltaY[i]);
          }
          for (let i = expandedDeltaY.length; i < strokeChars.length - 1; i++) {
            totalHeight += fontSize;
          }
        } else {
          totalHeight = strokeChars.length * fontSize;
        }
      }
      let yOff = topToBottom ? 0 : totalHeight;
      let xOff = 0;
      for (let i = 0; i < strokeChars.length; i++) {
        ctx.save();
        if (expandedDeltaX && i < expandedDeltaX.length) {
          xOff = mmtopx(expandedDeltaX[i]);
        }
        applyCharRotation(ctx, charDir, xOff, yOff, fontSize);
        ctx.strokeText(strokeChars[i], xOff, yOff);
        ctx.restore();
        if (i < strokeChars.length - 1) {
          const yStep = (expandedDeltaY && i < expandedDeltaY.length)
            ? mmtopx(expandedDeltaY[i]) : fontSize;
          yOff += topToBottom ? yStep : -yStep;
        }
      }
    } else if (readDir === 180) {
      // RTL stroke (per-character, reversed horizontal)
      let totalWidth = 0;
      if (expandedDeltaX) {
        for (let i = 0; i < Math.min(expandedDeltaX.length, strokeChars.length - 1); i++) {
          totalWidth += mmtopx(expandedDeltaX[i]);
        }
        for (let i = expandedDeltaX.length; i < strokeChars.length - 1; i++) {
          totalWidth += fontSize;
        }
      } else {
        totalWidth = strokeChars.length * fontSize;
      }
      let xOff = totalWidth;
      let yOff = 0;
      for (let i = 0; i < strokeChars.length; i++) {
        ctx.save();
        applyCharRotation(ctx, charDir, xOff, yOff, fontSize);
        ctx.strokeText(strokeChars[i], xOff, yOff);
        ctx.restore();
        if (i < strokeChars.length - 1) {
          if (expandedDeltaX && i < expandedDeltaX.length) {
            xOff -= mmtopx(expandedDeltaX[i]);
          } else {
            xOff -= fontSize;
          }
          if (expandedDeltaY && i < expandedDeltaY.length) {
            yOff += mmtopx(expandedDeltaY[i]);
          }
        }
      }
    } else {
      // LTR stroke (per-character with DeltaX + DeltaY)
      if (expandedDeltaX || expandedDeltaY) {
        let xOff = 0;
        let yOff = 0;
        for (let i = 0; i < strokeChars.length; i++) {
          ctx.save();
          applyCharRotation(ctx, charDir, xOff, yOff, fontSize);
          ctx.strokeText(strokeChars[i], xOff, yOff);
          ctx.restore();
          if (i < strokeChars.length - 1) {
            if (expandedDeltaX && i < expandedDeltaX.length) {
              xOff += mmtopx(expandedDeltaX[i]);
            } else if (expandedDeltaX) {
              xOff += fontSize;
            }
            if (expandedDeltaY && i < expandedDeltaY.length) {
              yOff += mmtopx(expandedDeltaY[i]);
            }
          }
        }
      } else {
        // No deltas — stroke entire string at (0,0)
        if (charDir !== 0) {
          ctx.save();
          applyCharRotation(ctx, charDir, 0, 0, fontSize);
          ctx.strokeText(textValue, 0, 0);
          ctx.restore();
        } else {
          ctx.strokeText(textValue, 0, 0);
        }
      }
    }
  }

  ctx.restore();
}

/**
 * Render left-to-right text (ReadDirection=0).
 * Characters positioned by DeltaX offsets along X axis and DeltaY offsets along Y axis.
 * When only DeltaY is present (no DeltaX), characters stack vertically —
 * this handles OFD files that use DeltaY for vertical layout without ReadDirection=90.
 * CharDirection rotates individual characters if needed.
 */
function renderLTRText(textObj, ctx, textValue, expandedDeltaX, expandedDeltaY, charDir, fontSize) {
  const chars = [...textValue];

  if (expandedDeltaX || expandedDeltaY) {
    // Per-character positioning: at least one delta array is present
    // DeltaX advances X offset, DeltaY advances Y offset (per OFD spec §11.2/§11.3)
    // When only DeltaY is present (no DeltaX), characters stack vertically —
    // this is how "密码区" etc. achieve vertical layout with ReadDirection=0
    let xOffset = 0;
    let yOffset = 0;
    for (let i = 0; i < chars.length; i++) {
      ctx.save();
      applyCharRotation(ctx, charDir, xOffset, yOffset, fontSize);
      ctx.fillText(chars[i], xOffset, yOffset);
      ctx.restore();

      // Advance position for next character
      if (i < chars.length - 1) {
        if (expandedDeltaX && i < expandedDeltaX.length) {
          xOffset += mmtopx(expandedDeltaX[i]);
        } else if (expandedDeltaX) {
          // Beyond DeltaX array length — use fontSize as default glyph width
          xOffset += fontSize;
        }
        if (expandedDeltaY && i < expandedDeltaY.length) {
          yOffset += mmtopx(expandedDeltaY[i]);
        }
        // If no DeltaX, xOffset stays at 0 (vertical stack)
        // If no DeltaY, yOffset stays at 0 (horizontal line)
      }
    }
  } else {
    // No deltas at all — draw entire string at (0,0)
    if (charDir !== 0) {
      ctx.save();
      applyCharRotation(ctx, charDir, 0, 0, fontSize);
      ctx.fillText(textValue, 0, 0);
      ctx.restore();
    } else {
      ctx.fillText(textValue, 0, 0);
    }
  }
}

/**
 * Render right-to-left horizontal text (ReadDirection=180).
 * Characters are arranged from right to left, but drawing order remains left-to-right
 * in the logical string. We reverse the character positions by accumulating
 * DeltaX offsets from right end of boundary.
 */
function renderRTLText(textObj, ctx, textValue, expandedDeltaX, expandedDeltaY, charDir, fontSize) {
  const chars = [...textValue];
  const boundary = Box.from(textObj.boundary).toPixel();

  // For RTL, we need to know total width to position first char at right edge
  let totalWidth = 0;
  if (expandedDeltaX) {
    for (let i = 0; i < Math.min(expandedDeltaX.length, chars.length - 1); i++) {
      totalWidth += mmtopx(expandedDeltaX[i]);
    }
    // Add remaining chars' default width
    for (let i = expandedDeltaX.length; i < chars.length - 1; i++) {
      totalWidth += fontSize;
    }
  } else {
    totalWidth = chars.length * fontSize;
  }

  // Start from rightmost position, walk leftward
  let xOffset = totalWidth;
  let yOffset = 0;
  for (let i = 0; i < chars.length; i++) {
    ctx.save();
    applyCharRotation(ctx, charDir, xOffset, yOffset, fontSize);
    ctx.fillText(chars[i], xOffset, yOffset);
    ctx.restore();
    // Move left for next character
    if (i < chars.length - 1) {
      if (expandedDeltaX && i < expandedDeltaX.length) {
        xOffset -= mmtopx(expandedDeltaX[i]);
      } else {
        xOffset -= fontSize;
      }
      if (expandedDeltaY && i < expandedDeltaY.length) {
        yOffset += mmtopx(expandedDeltaY[i]);
      }
    }
  }
}

/**
 * Render vertical text (竖排): ReadDirection=90 (top-to-bottom) or 270 (bottom-to-top).
 * Characters positioned by DeltaY offsets along Y axis.
 * When DeltaY is absent, fontSize is used as default vertical spacing.
 * For vertical text, each character is individually drawn with optional CharDirection rotation.
 *
 * In OFD vertical layout (ReadDirection=90):
 *   - X stays constant (or uses DeltaX for small horizontal adjustments)
 *   - Y advances downward via DeltaY
 *   - CharDirection=0 means characters are upright (e.g. Chinese chars in vertical layout)
 *   - Some OFD files use CharDirection=90 to rotate Latin chars for vertical reading
 */
function renderVerticalText(textObj, ctx, textValue, expandedDeltaX, expandedDeltaY, readDir, charDir, fontSize) {
  const chars = [...textValue];
  const boundary = Box.from(textObj.boundary).toPixel();

  // Determine vertical direction: 90 = top-to-bottom, 270 = bottom-to-top
  const topToBottom = readDir === 90;

  // Calculate total vertical height if we need bottom-to-top positioning
  let totalHeight = 0;
  if (!topToBottom) {
    if (expandedDeltaY) {
      for (let i = 0; i < Math.min(expandedDeltaY.length, chars.length - 1); i++) {
        totalHeight += mmtopx(expandedDeltaY[i]);
      }
      for (let i = expandedDeltaY.length; i < chars.length - 1; i++) {
        totalHeight += fontSize;
      }
    } else {
      totalHeight = chars.length * fontSize;
    }
  }

  let yOffset = topToBottom ? 0 : totalHeight;
  let xOffset = 0;

  for (let i = 0; i < chars.length; i++) {
    ctx.save();

    // For vertical text, determine per-character horizontal offset from DeltaX
    // DeltaX in vertical mode provides slight horizontal adjustments (e.g. for variable-width chars)
    if (expandedDeltaX && i < expandedDeltaX.length) {
      xOffset = mmtopx(expandedDeltaX[i]);
    }

    // Apply CharDirection rotation for individual character
    // In vertical layout (ReadDirection=90), CharDirection affects how each glyph is oriented
    applyCharRotation(ctx, charDir, xOffset, yOffset, fontSize);

    ctx.fillText(chars[i], xOffset, yOffset);
    ctx.restore();

    // Advance Y position for next character
    if (i < chars.length - 1) {
      const yStep = (expandedDeltaY && i < expandedDeltaY.length)
        ? mmtopx(expandedDeltaY[i])
        : fontSize;
      yOffset += topToBottom ? yStep : -yStep;
    }
  }
}

/**
 * Apply CharDirection rotation for individual characters.
 * CharDirection rotates the character's baseline clockwise:
 *   - 0: normal (no rotation)
 *   - 90: character rotated 90° clockwise (baseline vertical, top of char points right)
 *   - 180: character rotated 180° (upside down)
 *   - 270: character rotated 270° clockwise (baseline vertical, top of char points left)
 *
 * Implementation: rotate around the character's drawing point so it stays
 * within its allocated space. The rotation center is at (x + fontSize/2, y - fontSize/2)
 * which is roughly the center of the character's bounding box.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} charDir - 0, 90, 180, or 270
 * @param {number} x - character X position
 * @param {number} y - character Y position (baseline)
 * @param {number} fontSize - used to estimate rotation center
 */
function applyCharRotation(ctx, charDir, x, y, fontSize) {
  if (charDir === 0) return;

  // Convert degrees to radians
  const radians = (charDir * Math.PI) / 180;

  // Rotation center: offset to approximately center the character in its cell
  // For text drawn at baseline (x, y), the visual center is roughly
  // at (x + halfWidth, y - halfHeight) where halfHeight ≈ fontSize * 0.35 (above baseline)
  const cx = x + fontSize * 0.5;
  const cy = y - fontSize * 0.35;

  // Translate to rotation center, rotate, translate back
  ctx.translate(cx, cy);
  ctx.rotate(radians);
  ctx.translate(-cx, -cy);
}

/**
 * Expand OFD DeltaX/DeltaY "g N X" notation into numeric array.
 * Format: space-separated tokens. "g N X" means repeat value X N times.
 *         Plain numbers are used directly.
 *         "g" alone (without following N X) means glyph width (approximated by fontSize).
 *
 * Examples:
 *   "3.18 3.18 3.18" → [3.18, 3.18, 3.18]
 *   "g 18 2.54" → [2.54 repeated 18 times]
 *   "g 4 0" → [0 repeated 4 times]
 *   "3 g 3 1" → [3, 1, 1, 1]
 *
 * @param {string} deltaStr - raw DeltaX/DeltaY string from XML
 * @param {number} fontSize - approximate glyph width in mm (used when "g" appears alone)
 * @returns {number[]} expanded array of numeric deltas in mm
 */
export function expandDeltaNotation(deltaStr, fontSize) {
  const tokens = deltaStr.trim().split(/\s+/);
  const result = [];

  let i = 0;
  while (i < tokens.length) {
    if (tokens[i] === 'g') {
      // "g" notation: could be "g N X" (repeat X N times) or standalone "g" (glyph width)
      if (i + 2 < tokens.length) {
        const count = parseInt(tokens[i + 1], 10);
        const value = parseFloat(tokens[i + 2]);
        if (!isNaN(count) && !isNaN(value) && count > 0) {
          // Repeat value count times
          for (let j = 0; j < count; j++) {
            result.push(value);
          }
          i += 3;
        } else {
          // "g" followed by non-numeric — treat as glyph width
          result.push(fontSize);
          i += 1;
        }
      } else if (i + 1 < tokens.length) {
        // "g N" without X — incomplete, use glyph width
        result.push(fontSize);
        i += 1;
      } else {
        // Standalone "g" — glyph width
        result.push(fontSize);
        i += 1;
      }
    } else {
      // Plain numeric value
      const value = parseFloat(tokens[i]);
      if (!isNaN(value)) {
        result.push(value);
      }
      i += 1;
    }
  }

  return result;
}

/**
 * Render an ImageObject to Canvas2D context.
 * Images must be pre-loaded into ofd.images Map during readOfd phase.
 * CTM transformation is NOT applied (matching Rust TODO).
 * Only PNG format is supported (matching Rust limitation).
 *
 * @param {ImageObject} imageObj - the image object to render
 * @param {CanvasRenderingContext2D} ctx - Canvas2D context
 * @param {Object} ofd - the Ofd object (contains pre-loaded images)
 */
export async function renderImageObject(imageObj, ctx, ofd) {
  ctx.save();

  // Ensure CanvasImage is loaded for Node.js canvas environments
  if (!CanvasImage) {
    await loadCanvasImage();
  }

  const boundary = Box.from(imageObj.boundary).toPixel();

  // Get pre-loaded image from ofd.images Map by resourceId
  const img = ofd.images ? ofd.images.get(imageObj.resourceId) : null;

  if (img) {
    // Handle both browser Image element and Node.js raw buffer objects
    const isNativeImage = (typeof Image !== 'undefined' && img instanceof Image) || (img.tagName && img.tagName === 'IMG');

    if (isNativeImage) {
      // Browser: img is a loaded HTMLImageElement
      const scaleX = boundary.width / img.naturalWidth;
      const scaleY = boundary.height / img.naturalHeight;
      ctx.scale(scaleX, scaleY);
      ctx.drawImage(img, boundary.x / scaleX, boundary.y / scaleY);
    } else if (img.buffer) {
      // Node.js: img is a raw buffer object from preloadImages
      // For node-canvas, use Buffer.from for drawing
      const imgBuffer = Buffer.from(img.buffer);
      const canvasImg = new CanvasImage();
      canvasImg.src = imgBuffer;

      const scaleX = boundary.width / canvasImg.width;
      const scaleY = boundary.height / canvasImg.height;
      ctx.scale(scaleX, scaleY);
      ctx.drawImage(canvasImg, boundary.x / scaleX, boundary.y / scaleY);
    }
  }

  ctx.restore();
}

/**
 * Render a PageBlock to Canvas2D context.
 * PageBlock is a container — it just iterates and renders its events.
 * This is recursive (PageBlock can contain nested PageBlocks).
 *
 * @param {PageBlock} pageBlock - the page block to render
 * @param {CanvasRenderingContext2D} ctx - Canvas2D context
 * @param {Object} ofd - the Ofd object
 * @param {Object} document - the parsed Document
 */
export async function renderPageBlock(pageBlock, ctx, ofd, document) {
  await _renderPageBlock(pageBlock.events, ctx, ofd, document);
}

/**
 * Render a single event (polymorphic dispatch).
 * Dispatches based on object constructor/type.
 *
 * @param {Object} event - PathObject, TextObject, ImageObject, or PageBlock instance
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} ofd
 * @param {Object} document
 */
export async function renderEvent(event, ctx, ofd, document) {
  if (event instanceof PathObject) {
    renderPathObject(event, ctx);
  } else if (event instanceof TextObject) {
    renderTextObject(event, ctx, document);
  } else if (event instanceof ImageObject) {
    await renderImageObject(event, ctx, ofd);
  } else if (event instanceof PageBlock) {
    renderPageBlock(event, ctx, ofd, document);
  }
}

/**
 * Internal: render a list of events (matches Rust's _render_page_block).
 * Iterates each event, dispatches to the appropriate render function.
 * Stops on first error (in Rust it returns Result; in JS we just continue silently).
 *
 * @param {Array} events - array of event objects
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} ofd
 * @param {Object} document
 */
async function _renderPageBlock(events, ctx, ofd, document) {
  for (const event of events) {
    await renderEvent(event, ctx, ofd, document);
  }
}

/**
 * Render a Page to Canvas2D context.
 * Handles template references: renders Background templates first,
 * then page content, then Foreground templates.
 *
 * @param {Object} page - parsed Page object (may have templates)
 * @param {CanvasRenderingContext2D} ctx - Canvas2D context
 * @param {Object} ofd - the Ofd object (contains templates Map)
 * @param {Object} document - the parsed Document
 */
export async function renderPage(page, ctx, ofd, document) {
  // Render Background templates first (form layout, table lines, etc.)
  if (page.templates && ofd.templates) {
    for (const tplRef of page.templates) {
      if (tplRef.zOrder === 'Background' || !tplRef.zOrder) {
        const tplPage = ofd.templates.get(tplRef.templateId);
        if (tplPage && tplPage.content && tplPage.content.layer && tplPage.content.layer.events) {
          await _renderPageBlock(tplPage.content.layer.events, ctx, ofd, document);
        }
      }
    }
  }

  // Render page's own content
  if (page.content && page.content.layer && page.content.layer.events) {
    await _renderPageBlock(page.content.layer.events, ctx, ofd, document);
  }

  // Render Foreground templates last (overlays, stamps, etc.)
  if (page.templates && ofd.templates) {
    for (const tplRef of page.templates) {
      if (tplRef.zOrder === 'Foreground') {
        const tplPage = ofd.templates.get(tplRef.templateId);
        if (tplPage && tplPage.content && tplPage.content.layer && tplPage.content.layer.events) {
          await _renderPageBlock(tplPage.content.layer.events, ctx, ofd, document);
        }
      }
    }
  }
}