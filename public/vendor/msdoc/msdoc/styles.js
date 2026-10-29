import { BinaryReader } from '../core/binary.js';
import { alignEven } from '../core/utils.js';
import { decodeGrpprl } from './sprm.js';
const REPEATABLE_TABLE_PROPERTIES = new Set([
    'insertCells',
    'deleteCells',
    'columnWidth',
    'merge',
    'split',
    'textFlow',
    'vertMerge',
    'vertAlign',
    'setShading',
    'defaultShading',
    'setBorder',
    'cellPadding',
    'cellSpacing',
    'cellWidth',
    'fitText',
    'cellNoWrap',
]);
function mergePropertyArrays(...arrays) {
    const map = new Map();
    let sequence = 0;
    for (const array of arrays) {
        for (const prop of array || []) {
            const repeatable = prop.kind === 'table' && REPEATABLE_TABLE_PROPERTIES.has(prop.name);
            map.set(repeatable ? `${prop.kind}:${prop.name}:${sequence++}` : `${prop.kind}:${prop.name}`, prop);
        }
    }
    return Array.from(map.values());
}
function splitPropertiesByKind(properties) {
    const out = { para: [], char: [], table: [] };
    for (const prop of properties || []) {
        if (prop.kind === 'para')
            out.para.push(prop);
        else if (prop.kind === 'char')
            out.char.push(prop);
        else if (prop.kind === 'table')
            out.table.push(prop);
    }
    return out;
}
function parseXstz(bytes, offset) {
    const reader = new BinaryReader(bytes);
    const cch = reader.u16(offset);
    const charsOffset = offset + 2;
    const byteLength = cch * 2;
    const text = reader.utf16le(charsOffset, byteLength);
    const end = charsOffset + byteLength + 2;
    return { value: text.replace(/\u0000+$/, ''), nextOffset: end };
}
function parseStdfBase(bytes, offset) {
    const reader = new BinaryReader(bytes);
    const w1 = reader.u16(offset);
    const w2 = reader.u16(offset + 2);
    const w3 = reader.u16(offset + 4);
    return {
        sti: w1 & 0x0fff,
        flags1: w1 >> 12,
        stk: w2 & 0x000f,
        istdBase: (w2 >> 4) & 0x0fff,
        cupx: w3 & 0x000f,
        istdNext: (w3 >> 4) & 0x0fff,
        bchUpe: reader.u16(offset + 6),
        grfstd: reader.u16(offset + 8),
    };
}
function parseLpUpxPapx(bytes, offset) {
    const reader = new BinaryReader(bytes);
    const cbUpx = reader.u16(offset);
    const start = offset + 2;
    const end = start + cbUpx;
    const papx = bytes.subarray(start, Math.min(end, bytes.length));
    let styleId = 0;
    let properties = [];
    if (papx.length >= 2) {
        styleId = papx[0] | ((papx[1] ?? 0) << 8);
        properties = decodeGrpprl(papx, 2, papx.length);
    }
    return { cbUpx, styleId, properties, nextOffset: alignEven(end) };
}
function parseLpUpxChpx(bytes, offset) {
    const reader = new BinaryReader(bytes);
    const cbUpx = reader.u16(offset);
    const start = offset + 2;
    const end = start + cbUpx;
    const chpx = bytes.subarray(start, Math.min(end, bytes.length));
    const properties = decodeGrpprl(chpx, 0, chpx.length);
    return { cbUpx, properties, nextOffset: alignEven(end) };
}
function parseLpUpxTapx(bytes, offset) {
    const reader = new BinaryReader(bytes);
    const cbUpx = reader.u16(offset);
    const start = offset + 2;
    const end = start + cbUpx;
    const tapx = bytes.subarray(start, Math.min(end, bytes.length));
    const properties = decodeGrpprl(tapx, 0, tapx.length);
    return { cbUpx, properties, nextOffset: alignEven(end) };
}
function parseStyleStd(stdBytes, cbSTDBaseInFile, istd) {
    if (!stdBytes.length) {
        return {
            istd,
            empty: true,
            name: '',
            stdfBase: { istdBase: 0x0fff, istdNext: 0, stk: 1, cupx: 0 },
            paraProps: [],
            charProps: [],
            tableProps: [],
        };
    }
    const baseSize = Math.max(10, Math.min(cbSTDBaseInFile || 10, stdBytes.length));
    const stdfBase = parseStdfBase(stdBytes, 0);
    let offset = baseSize;
    const nameInfo = parseXstz(stdBytes, offset);
    offset = nameInfo.nextOffset;
    let paraProps = [];
    let charProps = [];
    let tableProps = [];
    try {
        if (stdfBase.stk === 1) {
            if (stdfBase.cupx >= 1 && offset + 2 <= stdBytes.length) {
                const papx = parseLpUpxPapx(stdBytes, offset);
                paraProps = papx.properties;
                offset = papx.nextOffset;
            }
            if (stdfBase.cupx >= 2 && offset + 2 <= stdBytes.length) {
                const chpx = parseLpUpxChpx(stdBytes, offset);
                charProps = chpx.properties;
            }
        }
        else if (stdfBase.stk === 2) {
            if (offset + 2 <= stdBytes.length) {
                const chpx = parseLpUpxChpx(stdBytes, offset);
                charProps = chpx.properties;
            }
        }
        else if (stdfBase.stk === 3) {
            if (stdfBase.cupx >= 1 && offset + 2 <= stdBytes.length) {
                const tapx = parseLpUpxTapx(stdBytes, offset);
                tableProps = tapx.properties;
                offset = tapx.nextOffset;
            }
            if (stdfBase.cupx >= 2 && offset + 2 <= stdBytes.length) {
                const papx = parseLpUpxPapx(stdBytes, offset);
                paraProps = papx.properties;
                offset = papx.nextOffset;
            }
            if (stdfBase.cupx >= 3 && offset + 2 <= stdBytes.length) {
                const chpx = parseLpUpxChpx(stdBytes, offset);
                charProps = chpx.properties;
            }
        }
    }
    catch {
    }
    return {
        istd,
        name: nameInfo.value,
        stdfBase,
        paraProps,
        charProps,
        tableProps,
        empty: false,
    };
}
export function parseStyles(tableBytes, fibRgFcLcb) {
    const fcStshf = fibRgFcLcb.fcStshf;
    const lcbStshf = fibRgFcLcb.lcbStshf;
    if (fcStshf == null || lcbStshf == null || lcbStshf <= 0) {
        return { styles: new Map(), header: null, resolveStyle(istd) { return resolveStyle(new Map(), istd); } };
    }
    const bytes = tableBytes.subarray(fcStshf, fcStshf + lcbStshf);
    const reader = new BinaryReader(bytes);
    const cbStshi = reader.u16(0);
    const stshiOffset = 2;
    const cstd = reader.u16(stshiOffset + 0);
    const cbSTDBaseInFile = reader.u16(stshiOffset + 2);
    const fontAt = (offset) => cbStshi >= offset + 2 && bytes.length >= stshiOffset + offset + 2
        ? reader.i16(stshiOffset + offset) : -1;
    const ftcAsci = fontAt(12);
    const ftcFE = fontAt(14);
    const ftcOther = fontAt(16);
    const header = { cbStshi, cstd, cbSTDBaseInFile, ftcAsci, ftcFE, ftcOther };
    let offset = 2 + cbStshi;
    const styles = new Map();
    for (let istd = 0; istd < cstd && offset + 2 <= bytes.length; istd += 1) {
        const cbStd = reader.u16(offset);
        const stdStart = offset + 2;
        const stdEnd = stdStart + cbStd;
        if (cbStd === 0) {
            styles.set(istd, {
                istd,
                empty: true,
                name: '',
                stdfBase: { istdBase: 0x0fff, istdNext: 0, stk: 1, cupx: 0 },
                paraProps: [],
                charProps: [],
                tableProps: [],
            });
            offset = alignEven(stdEnd);
            continue;
        }
        const stdBytes = bytes.subarray(stdStart, Math.min(stdEnd, bytes.length));
        const style = parseStyleStd(stdBytes, cbSTDBaseInFile, istd);
        styles.set(istd, style);
        offset = alignEven(stdEnd);
    }
    return {
        header,
        styles,
        resolveStyle(istd) {
            return resolveStyle(styles, istd);
        },
    };
}
export function resolveStyle(styleMap, istd, seen = new Set()) {
    if (istd == null || istd === 0x0fff || seen.has(istd)) {
        return { paraProps: [], charProps: [], tableProps: [], styleIds: [] };
    }
    const style = styleMap.get(istd);
    if (!style || style.empty)
        return { paraProps: [], charProps: [], tableProps: [], styleIds: [] };
    seen.add(istd);
    const baseResolved = resolveStyle(styleMap, style.stdfBase?.istdBase, seen);
    return {
        styleIds: [...baseResolved.styleIds, istd],
        paraProps: mergePropertyArrays(baseResolved.paraProps, style.paraProps),
        charProps: mergePropertyArrays(baseResolved.charProps, style.charProps),
        tableProps: mergePropertyArrays(baseResolved.tableProps, style.tableProps),
    };
}
export { mergePropertyArrays, splitPropertiesByKind };
