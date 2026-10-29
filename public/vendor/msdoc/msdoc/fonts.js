import { BinaryReader } from '../core/binary.js';
function decodeUtf16Z(bytes, offset) {
    let end = offset;
    while (end + 1 < bytes.length) {
        if (bytes[end] === 0 && bytes[end + 1] === 0)
            break;
        end += 2;
    }
    const text = new TextDecoder('utf-16le').decode(bytes.subarray(offset, end));
    return { value: text, nextOffset: Math.min(bytes.length, end + 2) };
}
function parseFfn(recordBytes, index) {
    if (!recordBytes.length)
        return null;
    const reader = new BinaryReader(recordBytes);
    const cbFfnM1 = reader.u8(0);
    const ffid = reader.u8(1);
    const wWeight = reader.u16(2);
    const chs = reader.u8(4);
    const ixchSzAlt = reader.u8(5);
    const panose = reader.slice(6, 10);
    const fontSignature = reader.slice(16, 24);
    const namesOffset = 40;
    let name = '';
    let altName = '';
    if (recordBytes.length > namesOffset) {
        const full = new TextDecoder('utf-16le').decode(recordBytes.subarray(namesOffset));
        const parts = full.split('\u0000').filter(Boolean);
        name = parts[0] || '';
        altName = parts[1] || '';
        if (!altName && ixchSzAlt) {
            const altOffset = namesOffset + ixchSzAlt * 2;
            if (altOffset + 2 <= recordBytes.length) {
                altName = decodeUtf16Z(recordBytes, altOffset).value;
            }
        }
    }
    return {
        index,
        cbFfnM1,
        ffid,
        weight: wWeight,
        charset: chs,
        ixchSzAlt,
        panose,
        fontSignature,
        name,
        altName,
    };
}
export function parseFonts(tableBytes, fibRgFcLcb) {
    const fcSttbfFfn = fibRgFcLcb.fcSttbfFfn;
    const lcbSttbfFfn = fibRgFcLcb.lcbSttbfFfn;
    if (fcSttbfFfn == null || lcbSttbfFfn == null || lcbSttbfFfn <= 0) {
        return {
            header: null,
            fonts: [],
            byIndex(index) {
                return index == null ? null : null;
            },
        };
    }
    const bytes = tableBytes.subarray(fcSttbfFfn, fcSttbfFfn + lcbSttbfFfn);
    const reader = new BinaryReader(bytes);
    const cData = reader.u16(0);
    const cbExtra = reader.u16(2);
    let offset = 4;
    const fonts = [];
    for (let i = 0; i < cData && offset < bytes.length; i += 1) {
        const cbFfnM1 = reader.u8(offset);
        const recordLength = cbFfnM1 + 1;
        const recordBytes = bytes.subarray(offset, Math.min(offset + recordLength, bytes.length));
        const font = parseFfn(recordBytes, i);
        if (font)
            fonts.push(font);
        offset += recordLength + cbExtra;
    }
    return {
        header: { cData, cbExtra },
        fonts,
        byIndex(index) {
            if (index == null || index < 0)
                return null;
            return fonts[index] || null;
        },
    };
}
