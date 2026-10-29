import { BinaryReader } from '../core/binary.js';
const OFFICEART_CONTAINER = 0x000f;
const OFFICEART_SP_CONTAINER = 0xf004;
const OFFICEART_SP = 0xf00a;
const OFFICEART_FOPT = 0xf00b;
const OFFICEART_SECONDARY_FOPT = 0xf121;
const OFFICEART_TERTIARY_FOPT = 0xf122;
const PROP_PIB = 0x0104;
const PROP_FILL_BLIP = 0x0186;
const PROP_PIB_NAME = 0x0105;
const PROP_SHAPE_NAME = 0x0380;
const PROP_ALT_TEXT = 0x0381;
function u16(bytes, offset) {
    if (offset + 2 > bytes.length)
        return 0;
    return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}
function u32(bytes, offset) {
    if (offset + 4 > bytes.length)
        return 0;
    return (((bytes[offset] ?? 0))
        | ((bytes[offset + 1] ?? 0) << 8)
        | ((bytes[offset + 2] ?? 0) << 16)
        | (((bytes[offset + 3] ?? 0) << 24) >>> 0)) >>> 0;
}
function decodeUtf16LeText(bytes) {
    if (!bytes?.length)
        return undefined;
    try {
        const value = new TextDecoder('utf-16le').decode(bytes).replace(/\0+$/g, '').trim();
        return value || undefined;
    }
    catch {
        return undefined;
    }
}
function decodeAnsiText(bytes) {
    if (!bytes?.length)
        return undefined;
    try {
        const value = new TextDecoder('windows-1252').decode(bytes).replace(/\0+$/g, '').trim();
        return value || undefined;
    }
    catch {
        return undefined;
    }
}
function decodeComplexText(bytes) {
    return decodeUtf16LeText(bytes) || decodeAnsiText(bytes);
}
export function detectMimeFromBlipType(blipType) {
    switch (blipType) {
        case 0x02: return 'image/emf';
        case 0x03: return 'image/wmf';
        case 0x04: return 'image/pict';
        case 0x05: return 'image/jpeg';
        case 0x06: return 'image/png';
        case 0x07: return 'image/dib';
        case 0x11: return 'image/tiff';
        case 0x12: return 'image/jpeg';
        default: return null;
    }
}
function parseOfficeArtRecordHeader(bytes, offset) {
    if (offset < 0 || offset + 8 > bytes.length)
        return null;
    const reader = new BinaryReader(bytes);
    const versionAndInstance = reader.u16(offset);
    const recType = reader.u16(offset + 2);
    const recLen = reader.u32(offset + 4);
    const size = 8 + recLen;
    if (recType < 0xf000 || recType > 0xffff)
        return null;
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
function parseOfficeArtFopt(bytes, offset, propertyCount) {
    const payloadOffset = offset + 8;
    if (payloadOffset + propertyCount * 6 > bytes.length)
        return [];
    const properties = [];
    let propOffset = payloadOffset;
    let complexOffset = payloadOffset + propertyCount * 6;
    for (let index = 0; index < propertyCount; index += 1) {
        const opid = u16(bytes, propOffset);
        const value = u32(bytes, propOffset + 2);
        propOffset += 6;
        const propertyId = opid & 0x3fff;
        const isBlipId = Boolean((opid >> 14) & 0x1);
        const isComplex = Boolean((opid >> 15) & 0x1);
        let complexData;
        if (isComplex) {
            if (complexOffset + value > bytes.length)
                break;
            complexData = bytes.subarray(complexOffset, complexOffset + value);
            complexOffset += value;
        }
        properties.push({ propertyId, isBlipId, isComplex, value, complexData });
    }
    return properties;
}
function scanRecords(bytes, start, end, visitor) {
    let cursor = Math.max(0, start);
    const limit = Math.min(end, bytes.length);
    while (cursor + 8 <= limit) {
        const header = parseOfficeArtRecordHeader(bytes, cursor);
        if (!header || cursor + header.size > limit) {
            cursor += 1;
            continue;
        }
        if (visitor(cursor, header) === true)
            return true;
        if (header.recVer === OFFICEART_CONTAINER) {
            if (scanRecords(bytes, cursor + 8, cursor + header.size, visitor))
                return true;
        }
        cursor += header.size;
    }
    return false;
}
export function parseInlineOfficeArtShape(bytes, startOffset = 0) {
    let result = null;
    scanRecords(bytes, startOffset, bytes.length, (offset, header) => {
        if (header.recType !== OFFICEART_SP_CONTAINER || header.recVer !== OFFICEART_CONTAINER)
            return false;
        const end = offset + header.size;
        let cursor = offset + 8;
        let shapeId = 0;
        let blipIndex;
        let name;
        let description;
        while (cursor + 8 <= end) {
            const child = parseOfficeArtRecordHeader(bytes, cursor);
            if (!child || cursor + child.size > end)
                break;
            if (child.recType === OFFICEART_SP && child.recLen >= 8) {
                shapeId = u32(bytes, cursor + 8);
            }
            else if (child.recType === OFFICEART_FOPT || child.recType === OFFICEART_SECONDARY_FOPT || child.recType === OFFICEART_TERTIARY_FOPT) {
                const properties = parseOfficeArtFopt(bytes, cursor, child.recInstance);
                for (const property of properties) {
                    if ((property.isBlipId || property.propertyId === PROP_PIB || property.propertyId === PROP_FILL_BLIP) && property.value > 0) {
                        blipIndex = property.value;
                    }
                    else if (property.propertyId === PROP_SHAPE_NAME) {
                        name = decodeComplexText(property.complexData) || name;
                    }
                    else if (property.propertyId === PROP_ALT_TEXT || property.propertyId === PROP_PIB_NAME) {
                        description = decodeComplexText(property.complexData) || description;
                    }
                }
            }
            cursor += child.size;
        }
        if (!shapeId)
            return false;
        result = { shapeId, blipIndex, name, description };
        return true;
    });
    return result;
}
