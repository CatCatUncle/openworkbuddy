// ZIP path resolution utilities — mirrors the path logic in src/lib.rs
// All paths inside the OFD ZIP archive are relative to the ZIP root (no leading "/").
// Resource paths are resolved relative to the DocRoot's parent directory.

/**
 * Get the parent directory of a path inside the ZIP.
 * e.g. "Doc_0/Document.xml" → "Doc_0"
 * e.g. "Doc_0/Sub/Document.xml" → "Doc_0/Sub"
 * @param {string} path - path within ZIP (forward slashes)
 * @returns {string} parent directory portion
 */
export function parentDir(path) {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.substring(0, idx) : '';
}

/**
 * Resolve a relative path against a base path's parent directory.
 * e.g. resolvePath("Doc_0/Document.xml", "PublicRes.xml") → "Doc_0/PublicRes.xml"
 * e.g. resolvePath("Doc_0/Document.xml", "Annots/Annotations.xml") → "Doc_0/Annots/Annotations.xml"
 * @param {string} basePath - base file path (e.g. DocRoot "Doc_0/Document.xml")
 * @param {string} relativePath - relative path to resolve (e.g. "PublicRes.xml")
 * @returns {string} resolved path within ZIP
 */
export function resolvePath(basePath, relativePath) {
  // Strip leading slashes from both paths (ZIP paths don't use leading /)
  const cleanBase = basePath.startsWith('/') ? basePath.slice(1) : basePath;
  const cleanRelative = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;

  const dir = parentDir(cleanBase);
  if (dir === '') {
    return cleanRelative;
  }
  return dir + '/' + cleanRelative;
}

/**
 * Resolve an image resource path.
 * Constructs the full ZIP path for a media resource file.
 * e.g. resolveResourcePath("Doc_0/Document.xml", "Res", "image.png") → "Doc_0/Res/image.png"
 *
 * @param {string} docRoot - DocRoot path (e.g. "Doc_0/Document.xml")
 * @param {string} resBaseLoc - Resource base location (e.g. "Res")
 * @param {string} mediaFile - Media file name (e.g. "signature.png")
 * @returns {string} full path within ZIP
 */
export function resolveResourcePath(docRoot, resBaseLoc, mediaFile) {
  const cleanDocRoot = docRoot.startsWith('/') ? docRoot.slice(1) : docRoot;
  const dir = parentDir(cleanDocRoot);
  if (dir === '') {
    return resBaseLoc + '/' + mediaFile;
  }
  return dir + '/' + resBaseLoc + '/' + mediaFile;
}

/**
 * Resolve an annotation file path.
 * Annotations are stored in the "Annots" subdirectory relative to DocRoot's parent.
 * e.g. resolveAnnotPath("Doc_0/Document.xml", "Page_0/Annot_0.xml") → "Doc_0/Annots/Page_0/Annot_0.xml"
 * Matches the Rust hardcoded join("Annots") pattern.
 *
 * @param {string} docRoot - DocRoot path
 * @param {string} annotFileLoc - annotation file location from Annotations.xml
 * @returns {string} full path within ZIP
 */
export function resolveAnnotPath(docRoot, annotFileLoc) {
  const cleanDocRoot = docRoot.startsWith('/') ? docRoot.slice(1) : docRoot;
  const dir = parentDir(cleanDocRoot);
  if (dir === '') {
    return 'Annots/' + annotFileLoc;
  }
  return dir + '/Annots/' + annotFileLoc;
}

/**
 * Resolve a page content file path.
 * e.g. resolvePagePath("Doc_0/Document.xml", "Pages/Page_0/Content.xml") → "Doc_0/Pages/Page_0/Content.xml"
 *
 * @param {string} docRoot - DocRoot path
 * @param {string} pageBaseLoc - page BaseLoc value
 * @returns {string} full path within ZIP
 */
export function resolvePagePath(docRoot, pageBaseLoc) {
  return resolvePath(docRoot, pageBaseLoc);
}