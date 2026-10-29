// Coordinate helpers and computed types — mirrors src/types.rs
// These are NOT XML deserialization types (those are in elements.js/document.js).
// They convert raw string values into numeric types for rendering.

const DEFAULT_DPI = 97.0;

/**
 * Convert millimeters to pixels.
 * @param {number} mm - value in millimeters
 * @param {number} dpi - dots per inch (default 97.0, matching Rust hardcoded value)
 * @returns {number} value in pixels
 */
export function mmtopx(mm, dpi = DEFAULT_DPI) {
  return mm * dpi / 25.4;
}

/**
 * Represents a bounding box with position and dimensions.
 * Parsed from strings like "10.30 30.30 0.30 22" (x y width height in mm).
 */
export class Box {
  constructor(x = 0, y = 0, width = 0, height = 0) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }

  /**
   * Parse a whitespace-separated "x y width height" string.
   * @param {string} str - e.g. "10.30 30.30 0.30 22"
   * @returns {Box}
   */
  static from(str) {
    const parts = str.trim().split(/\s+/).map(Number);
    return new Box(parts[0], parts[1], parts[2], parts[3]);
  }

  /**
   * Convert all fields from mm to pixels using mmtopx.
   * @param {number} dpi
   * @returns {Box} new Box in pixel coordinates
   */
  toPixel(dpi = DEFAULT_DPI) {
    return new Box(
      mmtopx(this.x, dpi),
      mmtopx(this.y, dpi),
      mmtopx(this.width, dpi),
      mmtopx(this.height, dpi)
    );
  }
}

/**
 * Represents a computed color with RGB integer values.
 * Parsed from strings like "128 0 0" (space-separated RGB).
 * This is the rendering-time computed type; the raw XML deserialization
 * Color type lives in elements.js.
 */
export class Color {
  constructor(value = [0, 0, 0], alpha = 255) {
    this.value = value;  // [r, g, b] integers
    this.alpha = alpha;  // integer, default 255
  }

  /**
   * Parse a whitespace-separated RGB string.
   * Supports both integer format ("128 0 0") and hex format ("#ee #20 #25").
   * @param {string} str - e.g. "128 0 0" or "#ee #20 #25"
   * @returns {Color}
   */
  static from(str) {
    const parts = str.trim().split(/\s+/).map(s => {
      if (s.startsWith('#')) {
        // Hex color: "#ee" → parseInt("ee", 16) = 238
        return parseInt(s.slice(1), 16);
      }
      return parseInt(s, 10);
    });
    return new Color(parts, 255);
  }

  /**
   * Return RGB as normalized fractions (0-1 range) for Canvas2D.
   * @returns {number[]} [r/255, g/255, b/255]
   */
  toRgb() {
    return [
      this.value[0] / 255.0,
      this.value[1] / 255.0,
      this.value[2] / 255.0
    ];
  }

  /**
   * Return a CSS rgb() string for Canvas2D fill/stroke style.
   * @returns {string} e.g. "rgb(128,0,0)"
   */
  toRgbString() {
    return `rgb(${this.value[0]},${this.value[1]},${this.value[2]})`;
  }
}

/**
 * Represents a 2D affine transformation matrix (CTM).
 * Parsed from strings like "a b c d e f" (6 whitespace-separated floats).
 *
 * OFD matrix format:
 *   | a  c  0 |
 *   | b  d  0 |
 *   | e  f  1 |
 *
 * Coordinate mapping: x' = a*x + c*y + e,  y' = b*x + d*y + f
 *
 * This maps directly to Canvas2D ctx.transform(a, b, c, d, e, f)
 * and Cairo's Matrix(xx=a, yx=b, xy=c, yy=d, x0=e, y0=f).
 */
export class Matrix {
  constructor(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) {
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.e = e;
    this.f = f;
  }

  /**
   * Parse a whitespace-separated 6-float CTM string.
   * @param {string} str - e.g. "0 1 -1 0 0.50 -2"
   * @returns {Matrix}
   */
  static from(str) {
    const parts = str.trim().split(/\s+/).map(Number);
    if (parts.length !== 6) {
      throw new Error(`Matrix CTM must have exactly 6 elements, got ${parts.length}: "${str}"`);
    }
    return new Matrix(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]);
  }

  /**
   * Return the 6 values as an array for Canvas2D ctx.transform().
   * Canvas2D transform(a,b,c,d,e,f) uses the same convention as Cairo:
   * a=horizontal scale, b=horizontal skew, c=vertical skew,
   * d=vertical scale, e=horizontal move, f=vertical move.
   * @returns {number[]} [a, b, c, d, e, f]
   */
  toCanvasTransform() {
    return [this.a, this.b, this.c, this.d, this.e, this.f];
  }
}

/**
 * Represents a page area with position and dimensions.
 * Same structure as Box but named PageArea for clarity
 * (mirrors the separate ct::PageArea type in types.rs).
 */
export class PageArea {
  constructor(x = 0, y = 0, width = 0, height = 0) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }

  /**
   * Parse a whitespace-separated "x y width height" string.
   * @param {string} str - e.g. "0 0 210 297"
   * @returns {PageArea}
   */
  static from(str) {
    const parts = str.trim().split(/\s+/).map(Number);
    return new PageArea(parts[0], parts[1], parts[2], parts[3]);
  }

  /**
   * Convert all fields from mm to pixels using mmtopx.
   * @param {number} dpi
   * @returns {PageArea} new PageArea in pixel coordinates
   */
  toPixel(dpi = DEFAULT_DPI) {
    return new PageArea(
      mmtopx(this.x, dpi),
      mmtopx(this.y, dpi),
      mmtopx(this.width, dpi),
      mmtopx(this.height, dpi)
    );
  }
}