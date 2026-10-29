import { BinaryReader } from '../core/binary.js';
const REPLACEMENTS = {
    '\x82': '\u201A', '\x83': '\u0192', '\x84': '\u201E', '\x85': '\u2026', '\x86': '\u2020', '\x87': '\u2021',
    '\x88': '\u02C6', '\x89': '\u2030', '\x8A': '\u0160', '\x8B': '\u2039', '\x8C': '\u0152', '\x91': '\u2018',
    '\x92': '\u2019', '\x93': '\u201C', '\x94': '\u201D', '\x95': '\u2022', '\x96': '\u2013', '\x97': '\u2014',
    '\x98': '\u02DC', '\x99': '\u2122', '\x9A': '\u0161', '\x9B': '\u203A', '\x9C': '\u0153', '\x9F': '\u0178',
};
function fixCompressedText(str) {
    return str.replace(/[\x82-\x8C\x91-\x9C\x9F]/g, (ch) => REPLACEMENTS[ch] || ch);
}
function decodeCompressed(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 1)
        text += String.fromCharCode(bytes[i] ?? 0);
    return fixCompressedText(text);
}
function decodeUnicode(bytes) {
    return new TextDecoder('utf-16le').decode(bytes);
}
export function parseClx(tableBytes, fibRgFcLcb) {
    const fcClx = fibRgFcLcb.fcClx;
    const lcbClx = fibRgFcLcb.lcbClx;
    if (fcClx == null || lcbClx == null || lcbClx <= 0) {
        throw new Error('FIB does not point to a CLX structure');
    }
    const clxBytes = tableBytes.subarray(fcClx, fcClx + lcbClx);
    const reader = new BinaryReader(clxBytes);
    let offset = 0;
    const prcs = [];
    while (offset < clxBytes.length && reader.u8(offset) === 0x01) {
        const cbGrpprl = reader.u16(offset + 1);
        prcs.push({ type: 1, cbGrpprl, bytes: reader.slice(offset + 3, cbGrpprl) });
        offset += 3 + cbGrpprl;
    }
    if (reader.u8(offset) !== 0x02) {
        throw new Error('CLX does not contain a Pcdt marker');
    }
    const lcb = reader.u32(offset + 1);
    const plcPcdBytes = reader.slice(offset + 5, lcb);
    const pieceTable = parsePlcPcd(plcPcdBytes);
    return { prcs, pcdt: { lcb, pieceTable } };
}
export function parsePlcPcd(bytes) {
    if (!bytes.length)
        throw new Error('Empty PlcPcd');
    const reader = new BinaryReader(bytes);
    const pcdCount = (bytes.length - 4) / 12;
    if (!Number.isInteger(pcdCount) || pcdCount < 0) {
        throw new Error('Invalid PlcPcd size');
    }
    const cps = [];
    for (let i = 0; i < pcdCount + 1; i += 1)
        cps.push(reader.u32(i * 4));
    const pieces = [];
    let offset = (pcdCount + 1) * 4;
    for (let i = 0; i < pcdCount; i += 1) {
        const descriptor = reader.u16(offset);
        const fcRaw = reader.u32(offset + 2) >>> 0;
        const prm = reader.u16(offset + 6);
        const compressed = Boolean(fcRaw & 0x40000000);
        const fc = fcRaw & 0x3fffffff;
        const cpStart = cps[i] ?? 0;
        const cpEnd = cps[i + 1] ?? cpStart;
        const actualByteStart = compressed ? Math.floor(fc / 2) : fc;
        const byteLength = compressed ? (cpEnd - cpStart) : (cpEnd - cpStart) * 2;
        pieces.push({
            index: i,
            descriptor,
            fNoParaLast: Boolean(descriptor & 0x0001),
            fRaw: Boolean(descriptor & 0x0002),
            prm,
            compressed,
            fcRaw,
            fc,
            cpStart,
            cpEnd,
            actualByteStart,
            byteLength,
            actualByteEnd: actualByteStart + byteLength,
        });
        offset += 8;
    }
    return { cps, pieces };
}
export function extractDocumentText(wordBytes, clx) {
    return clx.pcdt.pieceTable.pieces.map((piece) => extractPieceText(wordBytes, piece)).join('');
}
export function extractPieceText(wordBytes, piece) {
    const bytes = wordBytes.subarray(piece.actualByteStart, piece.actualByteEnd);
    return piece.compressed ? decodeCompressed(bytes) : decodeUnicode(bytes);
}
export function buildPieceTextCache(wordBytes, clx) {
    return clx.pcdt.pieceTable.pieces.map((piece) => extractPieceText(wordBytes, piece));
}
export function cpToFileOffset(clx, cp) {
    const pieces = clx.pcdt.pieceTable.pieces;
    let lo = 0;
    let hi = pieces.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const piece = pieces[mid];
        if (cp < piece.cpStart)
            hi = mid - 1;
        else if (cp >= piece.cpEnd)
            lo = mid + 1;
        else {
            return {
                piece,
                offset: piece.actualByteStart + (cp - piece.cpStart) * (piece.compressed ? 1 : 2),
                compressed: piece.compressed,
            };
        }
    }
    return null;
}
export function fcToCp(clx, fcRawOrActual, explicitCompressed = null) {
    const pieces = clx.pcdt.pieceTable.pieces;
    const hintedCompressed = explicitCompressed == null ? Boolean(fcRawOrActual & 0x40000000) : explicitCompressed;
    const fc = explicitCompressed == null ? (fcRawOrActual & 0x3fffffff) : fcRawOrActual;
    const actual = hintedCompressed ? Math.floor(fc / 2) : fc;
    for (const piece of pieces) {
        if (actual < piece.actualByteStart)
            continue;
        if (actual > piece.actualByteEnd)
            continue;
        const delta = actual - piece.actualByteStart;
        const cp = piece.cpStart + Math.floor(delta / (piece.compressed ? 1 : 2));
        if (cp >= piece.cpStart && cp <= piece.cpEnd)
            return cp;
    }
    for (const piece of pieces) {
        if (fcRawOrActual < piece.actualByteStart)
            continue;
        if (fcRawOrActual > piece.actualByteEnd)
            continue;
        const delta = fcRawOrActual - piece.actualByteStart;
        const cp = piece.cpStart + Math.floor(delta / (piece.compressed ? 1 : 2));
        if (cp >= piece.cpStart && cp <= piece.cpEnd)
            return cp;
    }
    return null;
}
export function getTextByCp(_wordBytes, clx, pieceTexts, cpStart, cpEnd) {
    if (cpEnd <= cpStart)
        return '';
    const out = [];
    for (let i = 0; i < clx.pcdt.pieceTable.pieces.length; i += 1) {
        const piece = clx.pcdt.pieceTable.pieces[i];
        if (piece.cpEnd <= cpStart)
            continue;
        if (piece.cpStart >= cpEnd)
            break;
        const localStart = Math.max(cpStart, piece.cpStart) - piece.cpStart;
        const localEnd = Math.min(cpEnd, piece.cpEnd) - piece.cpStart;
        out.push((pieceTexts[i] ?? '').slice(localStart, localEnd));
    }
    return out.join('');
}
export function splitParagraphRanges(documentText) {
    const ranges = [];
    let start = 0;
    for (let i = 0; i < documentText.length; i += 1) {
        const ch = documentText[i];
        if (ch === '\r' || ch === '\u0007') {
            ranges.push({ cpStart: start, cpEnd: i + 1, terminator: ch });
            start = i + 1;
        }
    }
    if (start < documentText.length)
        ranges.push({ cpStart: start, cpEnd: documentText.length, terminator: '' });
    return ranges;
}
