import { BinaryReader } from '../core/binary.js';
import { decodeGrpprl, SprmCodes } from './sprm.js';
import { fcToCp } from './clx.js';
function u32(bytes, offset = 0) {
    if (offset + 4 > bytes.length)
        return 0;
    return ((bytes[offset] ?? 0)
        | ((bytes[offset + 1] ?? 0) << 8)
        | ((bytes[offset + 2] ?? 0) << 16)
        | (((bytes[offset + 3] ?? 0) << 24) >>> 0)) >>> 0;
}
function readPlcBte(tableBytes, fc, lcb) {
    if (fc == null || lcb == null || lcb <= 0)
        return { aFC: [], pages: [] };
    const bytes = tableBytes.subarray(fc, fc + lcb);
    const reader = new BinaryReader(bytes);
    const count = Math.floor((lcb - 4) / 8);
    if (count <= 0)
        return { aFC: [], pages: [] };
    const aFC = [];
    for (let i = 0; i <= count; i += 1)
        aFC.push(reader.u32(i * 4) >>> 0);
    const pages = [];
    const pnOffset = (count + 1) * 4;
    for (let i = 0; i < count; i += 1)
        pages.push(reader.u32(pnOffset + i * 4) & 0x3fffff);
    return { aFC, pages };
}
function readChpxFkp(wordBytes, pn) {
    const offset = pn * 512;
    const page = wordBytes.subarray(offset, offset + 512);
    if (page.length < 512)
        return null;
    const reader = new BinaryReader(page);
    const crun = reader.u8(511);
    if (!crun || crun > 100)
        return null;
    const rgfc = [];
    for (let i = 0; i <= crun; i += 1)
        rgfc.push(reader.u32(i * 4) >>> 0);
    const rgb = [];
    const chpxOffsets = [];
    const rgbStart = (crun + 1) * 4;
    for (let i = 0; i < crun; i += 1) {
        const b = reader.u8(rgbStart + i);
        rgb.push(b);
        chpxOffsets.push(b ? offset + b * 2 : 0);
    }
    return { crun, rgfc, rgb, chpxOffsets };
}
function readPapxFkp(wordBytes, pn) {
    const offset = pn * 512;
    const page = wordBytes.subarray(offset, offset + 512);
    if (page.length < 512)
        return null;
    const reader = new BinaryReader(page);
    const cpara = reader.u8(511);
    if (cpara > 0x1d)
        return null;
    const rgfc = [];
    for (let i = 0; i <= cpara; i += 1)
        rgfc.push(reader.u32(i * 4) >>> 0);
    const bxStart = (cpara + 1) * 4;
    const bOffsets = [];
    const papxOffsets = [];
    for (let i = 0; i < cpara; i += 1) {
        const bOffset = reader.u8(bxStart + i * 13);
        bOffsets.push(bOffset);
        papxOffsets.push(bOffset ? offset + bOffset * 2 : 0);
    }
    return { cpara, rgfc, bOffsets, papxOffsets };
}
export function readChpxRuns(wordBytes, tableBytes, fib, clx) {
    const fcPlcfBteChpx = fib.fibRgFcLcb.fcPlcfBteChpx;
    const lcbPlcfBteChpx = fib.fibRgFcLcb.lcbPlcfBteChpx;
    const plc = readPlcBte(tableBytes, fcPlcfBteChpx, lcbPlcfBteChpx);
    const runs = [];
    for (const pn of plc.pages) {
        const fkp = readChpxFkp(wordBytes, pn);
        if (!fkp)
            continue;
        for (let i = 0; i < fkp.crun; i += 1) {
            const fcStart = fkp.rgfc[i] ?? 0;
            const fcEnd = fkp.rgfc[i + 1] ?? fcStart;
            const cpStart = fcToCp(clx, fcStart);
            const cpEnd = fcToCp(clx, fcEnd);
            if (cpStart == null || cpEnd == null || cpEnd <= cpStart)
                continue;
            const properties = fkp.chpxOffsets[i] ? readChpxProperties(wordBytes, fkp.chpxOffsets[i]) : [];
            runs.push({ cpStart, cpEnd, fcStart, fcEnd, properties });
        }
    }
    runs.sort((a, b) => a.cpStart - b.cpStart || a.cpEnd - b.cpEnd);
    return runs;
}
export function readPapxRuns(wordBytes, tableBytes, fib, clx, dataBytes) {
    const fcPlcfBtePapx = fib.fibRgFcLcb.fcPlcfBtePapx;
    const lcbPlcfBtePapx = fib.fibRgFcLcb.lcbPlcfBtePapx;
    const plc = readPlcBte(tableBytes, fcPlcfBtePapx, lcbPlcfBtePapx);
    const runs = [];
    for (const pn of plc.pages) {
        const fkp = readPapxFkp(wordBytes, pn);
        if (!fkp)
            continue;
        for (let i = 0; i < fkp.cpara; i += 1) {
            const fcStart = fkp.rgfc[i] ?? 0;
            const fcEnd = fkp.rgfc[i + 1] ?? fcStart;
            const cpStart = fcToCp(clx, fcStart);
            const cpEnd = fcToCp(clx, fcEnd);
            if (cpStart == null || cpEnd == null || cpEnd < cpStart)
                continue;
            const papx = fkp.papxOffsets[i]
                ? readPapxProperties(wordBytes, fkp.papxOffsets[i], dataBytes)
                : { styleId: 0, properties: [] };
            runs.push({ cpStart, cpEnd, fcStart, fcEnd, styleId: papx.styleId, properties: papx.properties, rawOffset: fkp.papxOffsets[i] ?? 0 });
        }
    }
    runs.sort((a, b) => a.cpStart - b.cpStart || a.cpEnd - b.cpEnd);
    return runs;
}
export function readChpxProperties(wordBytes, offset) {
    if (offset == null || offset < 0 || offset >= wordBytes.length)
        return [];
    const cb = wordBytes[offset] ?? 0;
    if (!cb)
        return [];
    const start = offset + 1;
    const end = Math.min(wordBytes.length, start + cb);
    return decodeGrpprl(wordBytes, start, end);
}
function readHugePapxProperties(dataBytes, offset) {
    if (offset < 0 || offset + 2 > dataBytes.length)
        return [];
    const cb = (dataBytes[offset] ?? 0) | ((dataBytes[offset + 1] ?? 0) << 8);
    if (!cb || offset + 2 + cb > dataBytes.length)
        return [];
    return decodeGrpprl(dataBytes, offset + 2, offset + 2 + cb);
}
function expandHugePapxProperties(properties, dataBytes) {
    if (!dataBytes?.length)
        return properties;
    const expanded = [];
    for (const property of properties) {
        if (property.raw !== SprmCodes.sprmPHugePapx) {
            expanded.push(property);
            continue;
        }
        const operandBytes = property.operandBytes || (property.value instanceof Uint8Array ? property.value : null);
        if (!operandBytes || operandBytes.length < 4) {
            expanded.push(property);
            continue;
        }
        const hugeOffset = u32(operandBytes);
        const hugeProperties = readHugePapxProperties(dataBytes, hugeOffset);
        expanded.push(...(hugeProperties.length ? hugeProperties : [property]));
    }
    return expanded;
}
export function readPapxProperties(wordBytes, offset, dataBytes) {
    if (offset == null || offset < 0 || offset >= wordBytes.length)
        return { styleId: 0, properties: [] };
    const reader = new BinaryReader(wordBytes);
    const cb = reader.u8(offset);
    if (cb === 0 && !reader.ensure(offset + 1, 1))
        return { styleId: 0, properties: [] };
    let bodyStart;
    let bodySize;
    if (cb === 0) {
        bodySize = reader.u8(offset + 1) * 2;
        bodyStart = offset + 2;
    }
    else {
        bodySize = cb * 2 - 1;
        bodyStart = offset + 1;
    }
    if (bodySize < 2 || !reader.ensure(bodyStart, Math.max(2, bodySize))) {
        return { styleId: 0, properties: [] };
    }
    const styleId = reader.u16(bodyStart);
    const propsStart = bodyStart + 2;
    const propsEnd = Math.min(wordBytes.length, bodyStart + bodySize);
    const properties = expandHugePapxProperties(decodeGrpprl(wordBytes, propsStart, propsEnd), dataBytes);
    return { styleId, properties };
}
