import { BinaryReader } from '../core/binary.js';
import { inflateZlib } from '../core/inflate.js';
import { dataUrlFromBytes, slugify, uniqueId } from '../core/utils.js';
import { detectMimeFromBlipType, parseInlineOfficeArtShape } from './officeart.js';
import { convertMetafileToSvg } from './vector.js';
const DEFAULT_MAX_PICTURE_BYTES = 8 * 1024 * 1024;
const PICF_HEADER_SIZE = 68;
const MM_SHAPE = 0x0064;
const MM_SHAPEFILE = 0x0066;
const OFFICEART_CONTAINER = 0xf;
const OFFICEART_FBSE = 0xf007;
const OFFICEART_BLIP_EMF = 0xf01a;
const OFFICEART_BLIP_WMF = 0xf01b;
const OFFICEART_BLIP_PICT = 0xf01c;
const OFFICEART_BLIP_JPEG = 0xf01d;
const OFFICEART_BLIP_PNG = 0xf01e;
const OFFICEART_BLIP_DIB = 0xf01f;
const OFFICEART_BLIP_TIFF = 0xf029;
const OFFICEART_BLIP_JPEG_ALT = 0xf02a;
function startsWith(bytes, signature, offset = 0) {
    if (offset + signature.length > bytes.length)
        return false;
    for (let i = 0; i < signature.length; i += 1) {
        if (bytes[offset + i] !== signature[i])
            return false;
    }
    return true;
}
function isPrintableAnsi(bytes) {
    for (let i = 0; i < bytes.length; i += 1) {
        const value = bytes[i] ?? 0;
        if (value === 0 || value === 9 || value === 10 || value === 13)
            continue;
        if (value < 0x20 || value === 0x7f)
            return false;
    }
    return true;
}
export function trimTrailingNullCharacters(value) {
    let end = value.length;
    while (end > 0 && value.charCodeAt(end - 1) === 0) {
        end -= 1;
    }
    return end === value.length ? value : value.slice(0, end);
}
function isProbablyPicturePath(value) {
    const normalized = value.trim();
    if (!normalized)
        return false;
    if (/^(?:file|https?|data|blob):/i.test(normalized))
        return true;
    if (/^(?:\\\\|[a-zA-Z]:[\\/]|\/)/.test(normalized))
        return true;
    return /\.(?:png|apng|jpe?g|gif|bmp|dib|tiff?|emf|wmf|pict|svg)(?:$|[?#])/i.test(normalized);
}
function isLocalExternalPath(value) {
    return /^file:/i.test(value) || /^(?:\\\\|[a-zA-Z]:[\\/]|\/)/.test(value);
}
function detectMimeFromPath(path) {
    const normalized = path.toLowerCase();
    if (normalized.includes('.png'))
        return 'image/png';
    if (normalized.includes('.jpg') || normalized.includes('.jpeg'))
        return 'image/jpeg';
    if (normalized.includes('.gif'))
        return 'image/gif';
    if (normalized.includes('.bmp'))
        return 'image/bmp';
    if (normalized.includes('.dib'))
        return 'image/bmp';
    if (normalized.includes('.tif'))
        return 'image/tiff';
    if (normalized.includes('.emf'))
        return 'image/emf';
    if (normalized.includes('.wmf'))
        return 'image/wmf';
    if (normalized.includes('.pict') || normalized.includes('.pct') || normalized.includes('.pic'))
        return 'image/pict';
    if (normalized.includes('.svg'))
        return 'image/svg+xml';
    return null;
}
function isBrowserDisplayableMime(mime) {
    return /^(?:image\/png|image\/jpeg|image\/gif|image\/bmp|image\/webp|image\/svg\+xml|image\/tiff)$/i.test(mime);
}
function detectAttachmentMime(name) {
    const normalized = name.toLowerCase();
    if (normalized.endsWith('.doc'))
        return 'application/msword';
    if (normalized.endsWith('.docx'))
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (normalized.endsWith('.xls'))
        return 'application/vnd.ms-excel';
    if (normalized.endsWith('.xlsx'))
        return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (normalized.endsWith('.ppt'))
        return 'application/vnd.ms-powerpoint';
    if (normalized.endsWith('.pptx'))
        return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    if (normalized.endsWith('.pdf'))
        return 'application/pdf';
    if (normalized.endsWith('.png'))
        return 'image/png';
    if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg'))
        return 'image/jpeg';
    if (normalized.endsWith('.gif'))
        return 'image/gif';
    if (normalized.endsWith('.bmp'))
        return 'image/bmp';
    if (normalized.endsWith('.zip'))
        return 'application/zip';
    if (normalized.endsWith('.txt'))
        return 'text/plain';
    return 'application/octet-stream';
}
export function detectImageSegment(bytes) {
    const sigs = [
        { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47], end: findPngEnd },
        { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff], end: findJpegEnd },
        { mime: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38], end: findGifEnd },
        { mime: 'image/bmp', magic: [0x42, 0x4d], end: findBmpEnd },
        { mime: 'image/tiff', magic: [0x49, 0x49, 0x2a, 0x00], end: null },
        { mime: 'image/tiff', magic: [0x4d, 0x4d, 0x00, 0x2a], end: null },
        { mime: 'image/emf', magic: [0x01, 0x00, 0x00, 0x00], end: findEmfEnd },
        { mime: 'image/wmf', magic: [0xd7, 0xcd, 0xc6, 0x9a], end: null },
    ];
    for (let i = 0; i < bytes.length - 4; i += 1) {
        for (const sig of sigs) {
            if (startsWith(bytes, sig.magic, i)) {
                if (sig.mime === 'image/emf' && findEmfEnd(bytes, i) === bytes.length)
                    continue;
                const end = sig.end ? sig.end(bytes, i) : bytes.length;
                return { mime: sig.mime, start: i, end: end || bytes.length };
            }
        }
    }
    return null;
}
function findPngEnd(bytes, start) {
    for (let i = start + 8; i + 8 < bytes.length; i += 1) {
        if (startsWith(bytes, [0x49, 0x45, 0x4e, 0x44], i))
            return i + 8;
    }
    return bytes.length;
}
function findJpegEnd(bytes, start) {
    for (let i = start + 2; i + 1 < bytes.length; i += 1) {
        if (bytes[i] === 0xff && bytes[i + 1] === 0xd9)
            return i + 2;
    }
    return bytes.length;
}
function findGifEnd(bytes, start) {
    for (let i = start + 6; i < bytes.length; i += 1) {
        if (bytes[i] === 0x3b)
            return i + 1;
    }
    return bytes.length;
}
function findBmpEnd(bytes, start) {
    if (start + 6 <= bytes.length) {
        const size = new BinaryReader(bytes.subarray(start)).u32(2);
        if (size > 0 && start + size <= bytes.length)
            return start + size;
    }
    return bytes.length;
}
function findEmfEnd(bytes, start) {
    if (start + 52 > bytes.length)
        return bytes.length;
    const reader = new BinaryReader(bytes.subarray(start));
    const iType = reader.u32(0);
    const signature = reader.u32(40);
    const nBytes = reader.u32(48);
    if (iType !== 0x00000001 || signature !== 0x464d4520)
        return bytes.length;
    if (nBytes > 0 && start + nBytes <= bytes.length)
        return start + nBytes;
    return bytes.length;
}
function parsePicfHeader(bytes) {
    if (bytes.length < PICF_HEADER_SIZE)
        return null;
    const reader = new BinaryReader(bytes);
    const dxaGoalTwips = reader.i16(28);
    const dyaGoalTwips = reader.i16(30);
    const scaleXPermille = reader.u16(32);
    const scaleYPermille = reader.u16(34);
    const displayWidthTwips = dxaGoalTwips > 0 && scaleXPermille > 0
        ? Math.max(15, Math.min(31680, Math.round((dxaGoalTwips * scaleXPermille) / 1000)))
        : undefined;
    const displayHeightTwips = dyaGoalTwips > 0 && scaleYPermille > 0
        ? Math.max(15, Math.min(31680, Math.round((dyaGoalTwips * scaleYPermille) / 1000)))
        : undefined;
    return {
        lcb: reader.i32(0),
        cbHeader: reader.u16(4),
        mm: reader.u16(6),
        xExt: reader.i16(8),
        yExt: reader.i16(10),
        dxaGoalTwips: dxaGoalTwips > 0 ? dxaGoalTwips : undefined,
        dyaGoalTwips: dyaGoalTwips > 0 ? dyaGoalTwips : undefined,
        scaleXPermille: scaleXPermille || undefined,
        scaleYPermille: scaleYPermille || undefined,
        displayWidthTwips,
        displayHeightTwips,
    };
}
function readOptionalPictureName(pictureChunk, picf) {
    const offset = Math.min(picf.cbHeader || PICF_HEADER_SIZE, pictureChunk.length);
    if (offset >= pictureChunk.length)
        return null;
    const length = pictureChunk[offset] ?? 0;
    if (!length || offset + 1 + length > pictureChunk.length)
        return null;
    const raw = pictureChunk.subarray(offset + 1, offset + 1 + length);
    if (!isPrintableAnsi(raw))
        return null;
    const value = trimTrailingNullCharacters(new TextDecoder('windows-1252').decode(raw));
    if (!isProbablyPicturePath(value)) {
        if (picf.mm !== MM_SHAPEFILE)
            return null;
    }
    return { value, nextOffset: offset + 1 + length };
}
export function parseOfficeArtRecordHeader(bytes, offset) {
    if (offset < 0 || offset + 8 > bytes.length)
        return null;
    const reader = new BinaryReader(bytes);
    const versionAndInstance = reader.u16(offset);
    const recType = reader.u16(offset + 2);
    const recLen = reader.u32(offset + 4);
    if (recType < 0xf000 || recType > 0xffff)
        return null;
    const size = 8 + recLen;
    if (recLen > bytes.length || offset + size > bytes.length)
        return null;
    return {
        recVer: versionAndInstance & 0x000f,
        recInstance: versionAndInstance >>> 4,
        recType,
        recLen,
        size,
    };
}
function createBitmapFileHeader(pixelOffset, totalSize) {
    const header = new Uint8Array(14);
    const view = new DataView(header.buffer);
    view.setUint8(0, 0x42);
    view.setUint8(1, 0x4d);
    view.setUint32(2, totalSize, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, 0, true);
    view.setUint32(10, pixelOffset, true);
    return header;
}
function dibToBmp(dibBytes) {
    if (dibBytes.length < 12)
        return null;
    const reader = new BinaryReader(dibBytes);
    const headerSize = reader.u32(0);
    if (headerSize < 12 || headerSize > dibBytes.length)
        return null;
    let bitsPerPixel = 0;
    let compression = 0;
    let colorsUsed = 0;
    let paletteEntrySize = 4;
    if (headerSize === 12) {
        bitsPerPixel = reader.u16(10);
        paletteEntrySize = 3;
    }
    else {
        bitsPerPixel = reader.u16(14);
        compression = reader.u32(16);
        colorsUsed = reader.u32(32);
    }
    const colorCount = colorsUsed || (bitsPerPixel > 0 && bitsPerPixel <= 8 ? 1 << bitsPerPixel : 0);
    let paletteSize = colorCount * paletteEntrySize;
    if (compression === 3 && headerSize >= 40)
        paletteSize += 12;
    const pixelOffset = 14 + headerSize + paletteSize;
    if (pixelOffset > 14 + dibBytes.length)
        return null;
    const bmpHeader = createBitmapFileHeader(pixelOffset, 14 + dibBytes.length);
    const out = new Uint8Array(14 + dibBytes.length);
    out.set(bmpHeader, 0);
    out.set(dibBytes, 14);
    return out;
}
function extractEmbeddedBlipFromFbse(bytes, offset, header) {
    const payloadOffset = offset + 8;
    const payloadEnd = payloadOffset + header.recLen;
    if (payloadEnd > bytes.length || header.recLen < 36)
        return null;
    const reader = new BinaryReader(bytes);
    const btWin32 = reader.u8(payloadOffset);
    const btMacOS = reader.u8(payloadOffset + 1);
    const tag = reader.u16(payloadOffset + 18);
    const size = reader.u32(payloadOffset + 20);
    const cRef = reader.u32(payloadOffset + 24);
    const foDelay = reader.u32(payloadOffset + 28);
    const cbName = reader.u8(payloadOffset + 33);
    const nameOffset = payloadOffset + 36;
    const embeddedBlipOffset = nameOffset + cbName;
    if (embeddedBlipOffset + 8 > payloadEnd)
        return null;
    const embeddedHeader = parseOfficeArtRecordHeader(bytes, embeddedBlipOffset);
    if (!embeddedHeader)
        return null;
    const candidate = extractBlipPayload(bytes, embeddedBlipOffset, embeddedHeader);
    if (!candidate)
        return null;
    const fbseName = cbName > 0 && nameOffset + cbName <= payloadEnd
        ? trimTrailingNullCharacters(new TextDecoder('utf-16le').decode(bytes.subarray(nameOffset, nameOffset + Math.max(0, cbName - 2))))
        : '';
    return {
        ...candidate,
        meta: {
            ...(candidate.meta || {}),
            fbseBlipType: btWin32 || btMacOS,
            fbseMime: detectMimeFromBlipType(btWin32 || btMacOS),
            fbseTag: tag,
            fbseSize: size,
            fbseRefCount: cRef,
            fbseDelayOffset: foDelay,
            fbseName,
        },
    };
}
function extractBlipPayload(bytes, offset, header) {
    const payloadOffset = offset + 8;
    const uidCount = (header.recInstance & 0x1) === 1 ? 2 : 1;
    const uidBytes = uidCount * 16;
    const atom = bytes.subarray(payloadOffset, payloadOffset + header.recLen);
    if (header.recType === OFFICEART_BLIP_PNG || header.recType === OFFICEART_BLIP_JPEG || header.recType === OFFICEART_BLIP_JPEG_ALT || header.recType === OFFICEART_BLIP_DIB || header.recType === OFFICEART_BLIP_TIFF) {
        const infoSize = uidBytes + 1;
        if (atom.length < infoSize)
            return null;
        let mime = 'application/octet-stream';
        let payload = atom.subarray(infoSize);
        if (header.recType === OFFICEART_BLIP_PNG)
            mime = 'image/png';
        else if (header.recType === OFFICEART_BLIP_JPEG || header.recType === OFFICEART_BLIP_JPEG_ALT)
            mime = 'image/jpeg';
        else if (header.recType === OFFICEART_BLIP_TIFF)
            mime = 'image/tiff';
        else if (header.recType === OFFICEART_BLIP_DIB) {
            const bmp = dibToBmp(payload);
            if (bmp) {
                payload = bmp;
                mime = 'image/bmp';
            }
            else {
                mime = 'image/dib';
            }
        }
        return {
            mime,
            bytes: payload,
            displayable: isBrowserDisplayableMime(mime),
            kind: 'officeArt',
            meta: { recType: header.recType, recInstance: header.recInstance },
        };
    }
    if (header.recType === OFFICEART_BLIP_EMF || header.recType === OFFICEART_BLIP_WMF || header.recType === OFFICEART_BLIP_PICT) {
        const infoSize = uidBytes + 34;
        if (atom.length < infoSize)
            return null;
        const metaReader = new BinaryReader(atom);
        const metafileUncompressedSize = metaReader.u32(uidBytes);
        const metafileCompressedSize = metaReader.u32(uidBytes + 28);
        const metafileCompression = atom[uidBytes + 32] ?? 0xff;
        const metafileFilter = atom[uidBytes + 33] ?? 0xff;
        const rawPayload = atom.subarray(infoSize);
        let payload = rawPayload;
        let metafileDecompressed = false;
        let metafileCompressed = metafileCompression !== 0xfe;
        if (metafileCompression === 0x00) {
            const inflated = inflateZlib(rawPayload, metafileUncompressedSize || undefined);
            if (inflated) {
                payload = inflated;
                metafileDecompressed = true;
                metafileCompressed = false;
            }
        }
        const mime = header.recType === OFFICEART_BLIP_EMF ? 'image/emf' : header.recType === OFFICEART_BLIP_WMF ? 'image/wmf' : 'image/pict';
        return {
            mime,
            bytes: payload,
            displayable: isBrowserDisplayableMime(mime),
            kind: 'officeArt',
            meta: {
                recType: header.recType,
                recInstance: header.recInstance,
                metafileUncompressedSize,
                metafileCompressedSize,
                metafileCompression,
                metafileFilter,
                metafileCompressed,
                metafileDecompressed,
                metafileOriginalByteLength: rawPayload.length,
                fbseSize: metafileCompressedSize,
            },
        };
    }
    return null;
}
function collectOfficeArtCandidates(bytes, offset, end, out) {
    let cursor = offset;
    while (cursor + 8 <= end) {
        const header = parseOfficeArtRecordHeader(bytes, cursor);
        if (!header)
            break;
        const next = cursor + header.size;
        if (next > end)
            break;
        if (header.recVer === OFFICEART_CONTAINER) {
            collectOfficeArtCandidates(bytes, cursor + 8, next, out);
        }
        else if (header.recType === OFFICEART_FBSE) {
            const candidate = extractEmbeddedBlipFromFbse(bytes, cursor, header);
            if (candidate)
                out.push(candidate);
        }
        else {
            const candidate = extractBlipPayload(bytes, cursor, header);
            if (candidate)
                out.push(candidate);
        }
        cursor = next;
    }
}
function findOfficeArtCandidates(pictureChunk, startOffset) {
    if (startOffset < 0 || startOffset + 8 > pictureChunk.length)
        return [];
    const candidates = [];
    collectOfficeArtCandidates(pictureChunk, startOffset, pictureChunk.length, candidates);
    return candidates;
}
function rankPictureCandidate(candidate) {
    switch (candidate.mime) {
        case 'image/png': return 100;
        case 'image/jpeg': return 90;
        case 'image/gif': return 80;
        case 'image/bmp': return 70;
        case 'image/tiff': return 60;
        case 'image/svg+xml': return 50;
        case 'image/emf': return 40;
        case 'image/wmf': return 30;
        case 'image/pict': return 20;
        default: return 0;
    }
}
function pickBestPictureCandidate(candidates) {
    let best = null;
    for (const candidate of candidates) {
        if (!best || rankPictureCandidate(candidate) > rankPictureCandidate(best))
            best = candidate;
    }
    return best;
}
function maybeConvertVectorCandidate(candidate) {
    if (!/^(?:image\/emf|image\/wmf)$/i.test(candidate.mime))
        return candidate;
    if (!candidate.bytes.length)
        return candidate;
    if (candidate.meta?.metafileCompressed)
        return candidate;
    const converted = convertMetafileToSvg(candidate.mime, candidate.bytes);
    if (!converted)
        return candidate;
    return {
        ...candidate,
        mime: converted.mime,
        bytes: converted.bytes,
        displayable: true,
        meta: {
            ...(candidate.meta || {}),
            vectorConverted: true,
            vectorSourceMime: converted.sourceMime,
            vectorWidth: converted.width,
            vectorHeight: converted.height,
            vectorRecordCount: converted.recordCount,
        },
    };
}
function createImageAsset(candidate, pictureOffset, picf, linkedPath, inlineShape) {
    const sourceUrl = candidate.sourceUrl;
    const localExternal = sourceUrl ? isLocalExternalPath(sourceUrl) : false;
    const meta = {
        pictureOffset,
        lcb: picf.lcb,
        cbHeader: picf.cbHeader,
        mm: picf.mm,
        xExt: picf.xExt,
        yExt: picf.yExt,
        dxaGoalTwips: picf.dxaGoalTwips,
        dyaGoalTwips: picf.dyaGoalTwips,
        scaleXPermille: picf.scaleXPermille,
        scaleYPermille: picf.scaleYPermille,
        displayWidthTwips: picf.displayWidthTwips,
        displayHeightTwips: picf.displayHeightTwips,
        linkedPath,
        sourceKind: candidate.kind === 'officeArt' ? 'embedded' : candidate.kind,
        localExternal,
        browserRenderable: candidate.displayable,
        blipIndex: inlineShape?.blipIndex,
        sourceShapeId: inlineShape?.shapeId,
        ...(candidate.meta || {}),
    };
    return {
        id: uniqueId('asset-img'),
        type: 'image',
        mime: candidate.mime,
        bytes: candidate.bytes,
        dataUrl: sourceUrl ? '' : dataUrlFromBytes(candidate.bytes, candidate.mime),
        sourceUrl,
        displayable: candidate.displayable && !localExternal,
        meta,
    };
}
export function extractPictureAsset(dataStreamBytes, pictureOffset, options = {}) {
    if (!dataStreamBytes || pictureOffset == null || pictureOffset < 0 || pictureOffset + PICF_HEADER_SIZE > dataStreamBytes.length)
        return null;
    const reader = new BinaryReader(dataStreamBytes);
    const lcb = reader.i32(pictureOffset);
    const total = lcb > 0 && pictureOffset + lcb <= dataStreamBytes.length
        ? lcb
        : Math.min(dataStreamBytes.length - pictureOffset, options.maxPictureBytes || DEFAULT_MAX_PICTURE_BYTES);
    const pictureChunk = dataStreamBytes.subarray(pictureOffset, pictureOffset + total);
    const picf = parsePicfHeader(pictureChunk);
    if (!picf)
        return null;
    let pictureDataOffset = Math.min(picf.cbHeader || PICF_HEADER_SIZE, pictureChunk.length);
    const pictureName = readOptionalPictureName(pictureChunk, picf);
    const linkedPath = pictureName?.value;
    if (pictureName)
        pictureDataOffset = pictureName.nextOffset;
    const inlineShape = parseInlineOfficeArtShape(pictureChunk, pictureDataOffset);
    const officeArtCandidates = findOfficeArtCandidates(pictureChunk, pictureDataOffset);
    const officeArtCandidate = pickBestPictureCandidate(officeArtCandidates);
    if (officeArtCandidate) {
        return createImageAsset(maybeConvertVectorCandidate(officeArtCandidate), pictureOffset, picf, linkedPath, inlineShape);
    }
    if (linkedPath) {
        const mime = detectMimeFromPath(linkedPath) || 'application/octet-stream';
        const isLocalFileReference = isLocalExternalPath(linkedPath);
        const linkedCandidate = {
            mime,
            bytes: new Uint8Array(0),
            sourceUrl: linkedPath,
            displayable: isBrowserDisplayableMime(mime) && !isLocalFileReference,
            kind: 'linked',
            meta: { linkedPath },
        };
        return createImageAsset(linkedCandidate, pictureOffset, picf, linkedPath, inlineShape);
    }
    const bodyStart = Math.min(picf.cbHeader || PICF_HEADER_SIZE, pictureChunk.length);
    const segment = detectImageSegment(pictureChunk.subarray(bodyStart));
    if (!segment) {
        return {
            id: uniqueId('asset-img'),
            type: 'image',
            mime: 'application/octet-stream',
            bytes: pictureChunk,
            dataUrl: dataUrlFromBytes(pictureChunk, 'application/octet-stream'),
            displayable: false,
            meta: {
                pictureOffset,
                lcb: picf.lcb,
                cbHeader: picf.cbHeader,
                mm: picf.mm,
                xExt: picf.xExt,
                yExt: picf.yExt,
                dxaGoalTwips: picf.dxaGoalTwips,
                dyaGoalTwips: picf.dyaGoalTwips,
                scaleXPermille: picf.scaleXPermille,
                scaleYPermille: picf.scaleYPermille,
                displayWidthTwips: picf.displayWidthTwips,
                displayHeightTwips: picf.displayHeightTwips,
                sourceKind: 'fallback',
                browserRenderable: false,
                blipIndex: inlineShape?.blipIndex,
                sourceShapeId: inlineShape?.shapeId,
            },
        };
    }
    const start = bodyStart + segment.start;
    const end = Math.min(bodyStart + segment.end, pictureChunk.length);
    const imageBytes = pictureChunk.subarray(start, end);
    const fallbackCandidate = maybeConvertVectorCandidate({
        mime: segment.mime,
        bytes: imageBytes,
        displayable: isBrowserDisplayableMime(segment.mime),
        kind: 'fallback',
        meta: {
            pictureOffset,
            lcb: picf.lcb,
            cbHeader: picf.cbHeader,
            mm: picf.mm,
            xExt: picf.xExt,
            yExt: picf.yExt,
            dxaGoalTwips: picf.dxaGoalTwips,
            dyaGoalTwips: picf.dyaGoalTwips,
            scaleXPermille: picf.scaleXPermille,
            scaleYPermille: picf.scaleYPermille,
            displayWidthTwips: picf.displayWidthTwips,
            displayHeightTwips: picf.displayHeightTwips,
            sourceKind: 'fallback',
            browserRenderable: isBrowserDisplayableMime(segment.mime),
        },
    });
    return {
        id: uniqueId('asset-img'),
        type: 'image',
        mime: fallbackCandidate.mime,
        bytes: fallbackCandidate.bytes,
        dataUrl: dataUrlFromBytes(fallbackCandidate.bytes, fallbackCandidate.mime),
        displayable: fallbackCandidate.displayable,
        meta: {
            pictureOffset,
            lcb: picf.lcb,
            cbHeader: picf.cbHeader,
            mm: picf.mm,
            xExt: picf.xExt,
            yExt: picf.yExt,
            dxaGoalTwips: picf.dxaGoalTwips,
            dyaGoalTwips: picf.dyaGoalTwips,
            scaleXPermille: picf.scaleXPermille,
            scaleYPermille: picf.scaleYPermille,
            displayWidthTwips: picf.displayWidthTwips,
            displayHeightTwips: picf.displayHeightTwips,
            sourceKind: 'fallback',
            browserRenderable: Boolean(fallbackCandidate.displayable),
            blipIndex: inlineShape?.blipIndex,
            sourceShapeId: inlineShape?.shapeId,
            ...(fallbackCandidate.meta || {}),
        },
    };
}
export function extractFbseImageAsset(drawingBytes, offset, header = parseOfficeArtRecordHeader(drawingBytes, offset)) {
    if (!header || header.recType !== OFFICEART_FBSE)
        return null;
    const candidate = extractEmbeddedBlipFromFbse(drawingBytes, offset, header);
    if (!candidate)
        return null;
    const normalized = maybeConvertVectorCandidate(candidate);
    return createImageAsset(normalized, -1, {
        lcb: normalized.bytes.length,
        cbHeader: 0,
        mm: MM_SHAPE,
        xExt: 0,
        yExt: 0,
    });
}
function readCString(bytes, offset) {
    let end = offset;
    while (end < bytes.length && bytes[end] !== 0)
        end += 1;
    const value = new TextDecoder('windows-1252').decode(bytes.subarray(offset, end));
    return { value, nextOffset: end + 1 };
}
export function parseOle10Native(streamBytes) {
    const reader = new BinaryReader(streamBytes);
    const variants = [4, 6];
    for (const start of variants) {
        try {
            let offset = start;
            const label = readCString(streamBytes, offset);
            offset = label.nextOffset;
            const originalPath = readCString(streamBytes, offset);
            offset = originalPath.nextOffset;
            const tempPath = readCString(streamBytes, offset);
            offset = tempPath.nextOffset;
            if (offset + 4 > streamBytes.length)
                continue;
            const dataSize = reader.u32(offset);
            offset += 4;
            if (dataSize > 0 && offset + dataSize <= streamBytes.length) {
                const bytes = streamBytes.subarray(offset, offset + dataSize);
                return { label: label.value, originalPath: originalPath.value, tempPath: tempPath.value, dataSize, bytes };
            }
        }
        catch {
        }
    }
    return null;
}
function readObjectStorage(cfb, entry) {
    const streams = cfb.listChildren(entry).filter((child) => child.objectType === 2 || child.objectType === 5);
    const lower = new Map(streams.map((child) => [child.name.toLowerCase(), child]));
    const objInfo = lower.get('\u0003objinfo') || lower.get('\x03objinfo') || lower.get(String.fromCharCode(3) + 'objinfo');
    const ole10 = lower.get('\u0001ole10native') || lower.get('\x01ole10native') || lower.get(String.fromCharCode(1) + 'ole10native');
    const packageStream = lower.get('package') || lower.get('contents') || lower.get('content');
    const info = { entry, streams, displayName: entry.name, attachment: null, objectData: null };
    if (ole10) {
        const bytes = cfb.getStream(ole10) || new Uint8Array(0);
        const nativeInfo = parseOle10Native(bytes);
        if (nativeInfo) {
            const name = nativeInfo.label || nativeInfo.originalPath.split(/[\\/]/).pop() || `${entry.name}.bin`;
            const mime = detectAttachmentMime(name);
            const attachmentMeta = { ...nativeInfo, sourceKind: 'ole10-native' };
            const attachment = {
                id: uniqueId('asset-ole'),
                type: 'attachment',
                name,
                mime,
                bytes: nativeInfo.bytes,
                dataUrl: dataUrlFromBytes(nativeInfo.bytes, mime),
                meta: attachmentMeta,
            };
            info.attachment = attachment;
            return info;
        }
    }
    if (packageStream) {
        const bytes = cfb.getStream(packageStream) || new Uint8Array(0);
        const name = `${slugify(entry.name)}.bin`;
        const mime = detectAttachmentMime(name);
        const attachment = {
            id: uniqueId('asset-pkg'),
            type: 'attachment',
            name,
            mime,
            bytes,
            dataUrl: dataUrlFromBytes(bytes, mime),
            meta: { stream: packageStream.name, sourceKind: 'package' },
        };
        info.attachment = attachment;
    }
    if (objInfo) {
        info.objectData = cfb.getStream(objInfo) || new Uint8Array(0);
    }
    return info;
}
export function extractObjectPool(cfb) {
    const objectPoolEntry = cfb.getEntry('/ObjectPool');
    if (!objectPoolEntry)
        return new Map();
    const storages = cfb.listChildren(objectPoolEntry).filter((entry) => entry.objectType === 1);
    const map = new Map();
    for (const storage of storages) {
        map.set(storage.name, readObjectStorage(cfb, storage));
    }
    return map;
}
