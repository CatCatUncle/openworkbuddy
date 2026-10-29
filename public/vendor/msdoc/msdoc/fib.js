import { BinaryReader } from '../core/binary.js';
const FIB_FC_LCB_NAMES = [
    'StshfOrig', 'Stshf', 'PlcffndRef', 'PlcffndTxt', 'PlcfandRef', 'PlcfandTxt',
    'PlcfSed', 'PlcPad', 'PlcfPhe', 'SttbfGlsy', 'PlcfGlsy', 'PlcfHdd', 'PlcfBteChpx',
    'PlcfBtePapx', 'PlcfSea', 'SttbfFfn', 'PlcfFldMom', 'PlcfFldHdr', 'PlcfFldFtn',
    'PlcfFldAtn', 'PlcfFldMcr', 'SttbfBkmk', 'PlcfBkf', 'PlcfBkl', 'Cmds', 'Unused1',
    'SttbfMcr', 'PrDrvr', 'PrEnvPort', 'PrEnvLand', 'Wss', 'Dop', 'SttbfAssoc', 'Clx',
    'PlcfPgdFtn', 'AutosaveSource', 'GrpXstAtnOwners', 'SttbfAtnBkmk', 'Unused2',
    'Unused3', 'PlcSpaMom', 'PlcSpaHdr', 'PlcfAtnBkf', 'PlcfAtnBkl', 'Pms',
    'FormFldSttbs', 'PlcfendRef', 'PlcfendTxt', 'PlcfFldEdn', 'Unused4', 'DggInfo',
    'SttbfRMark', 'SttbfCaption', 'SttbfAutoCaption', 'PlcfWkb', 'PlcfSpl',
    'PlcftxbxTxt', 'PlcfFldTxbx', 'PlcfHdrtxbxTxt', 'PlcffldHdrTxbx', 'StwUser',
    'SttbTtmbd', 'CookieData', 'PgdMotherOldOld', 'BkdMotherOldOld', 'PgdFtnOldOld',
    'BkdFtnOldOld', 'PgdEdnOldOld', 'BkdEdnOldOld', 'SttbfIntlFld', 'RouteSlip',
    'SttbSavedBy', 'SttbFnm', 'PlfLst', 'PlfLfo', 'PlcfTxbxBkd', 'PlcfTxbxHdrBkd',
    'DocUndoWord9', 'RgbUse', 'Usp', 'Uskf', 'PlcupcRgbUse', 'PlcupcUsp', 'SttbGlsyStyle',
    'Plgosl', 'Plcocx', 'PlcfBteLvc', 'dwLowDateTime', 'dwHighDateTime', 'PlcfLvcPre10',
    'PlcfAsumy', 'PlcfGram', 'SttbListNames', 'SttbfUssr',
];
export function parseFib(wordBytes) {
    const reader = new BinaryReader(wordBytes);
    const base = parseFibBase(reader);
    let offset = 32;
    const csw = reader.u16(offset);
    offset += 2;
    const fibRgWBytes = reader.slice(offset, csw * 2);
    offset += csw * 2;
    const cslw = reader.u16(offset);
    offset += 2;
    const fibRgLwBytes = reader.slice(offset, cslw * 4);
    offset += cslw * 4;
    const cbRgFcLcb = reader.u16(offset);
    offset += 2;
    const fibRgFcLcbBytes = reader.slice(offset, cbRgFcLcb * 8);
    offset += cbRgFcLcb * 8;
    const cswNew = reader.ensure(offset, 2) ? reader.u16(offset) : 0;
    if (reader.ensure(offset, 2))
        offset += 2;
    const fibRgCswNewBytes = cswNew ? reader.slice(offset, cswNew * 2) : new Uint8Array(0);
    const fibRgLw = parseFibRgLw(fibRgLwBytes);
    const fibRgFcLcb = parseFibRgFcLcb(fibRgFcLcbBytes, cbRgFcLcb);
    const nFibNew = cswNew ? new BinaryReader(fibRgCswNewBytes).u16(0) : 0;
    return {
        base,
        csw,
        cslw,
        cbRgFcLcb,
        cswNew,
        nFibNew,
        fibRgWBytes,
        fibRgLwBytes,
        fibRgFcLcbBytes,
        fibRgCswNewBytes,
        fibRgLw,
        fibRgFcLcb,
    };
}
export function parseFibBase(reader) {
    const wIdent = reader.u16(0);
    const nFib = reader.u16(2);
    const lid = reader.u16(6);
    const pnNext = reader.u16(8);
    const flags = reader.u16(10);
    const envFlags = reader.u16(18);
    return {
        wIdent,
        nFib,
        lid,
        pnNext,
        flags,
        envFlags,
        fDot: Boolean(flags & 0x0001),
        fGlsy: Boolean(flags & 0x0002),
        fComplex: Boolean(flags & 0x0004),
        fHasPic: Boolean(flags & 0x0008),
        cQuickSaves: (flags >> 4) & 0x0f,
        fEncrypted: Boolean(flags & 0x0100),
        fWhichTblStm: flags & 0x0200 ? 1 : 0,
        fReadOnlyRecommended: Boolean(flags & 0x0400),
        fWriteReservation: Boolean(flags & 0x0800),
        fExtChar: Boolean(flags & 0x1000),
        fLoadOverride: Boolean(flags & 0x2000),
        fFarEast: Boolean(flags & 0x4000),
        fObfuscated: Boolean(flags & 0x8000),
        nFibBack: reader.u16(12),
        lKey: reader.u32(14),
        envr: reader.u8(18),
        fMac: Boolean(envFlags & 0x0001),
        fEmptySpecial: Boolean(envFlags & 0x0002),
        fLoadOverridePage: Boolean(envFlags & 0x0004),
    };
}
function parseFibRgLw(bytes) {
    const reader = new BinaryReader(bytes);
    const dwords = [];
    for (let i = 0; i + 4 <= bytes.length; i += 4)
        dwords.push(reader.i32(i));
    return {
        raw: dwords,
        cbMac: dwords[0] ?? 0,
        ccpText: dwords[3] ?? 0,
        ccpFtn: dwords[4] ?? 0,
        ccpHdd: dwords[5] ?? 0,
        ccpMcr: dwords[6] ?? 0,
        ccpAtn: dwords[7] ?? 0,
        ccpEdn: dwords[8] ?? 0,
        ccpTxbx: dwords[9] ?? 0,
        ccpHdrTxbx: dwords[10] ?? 0,
    };
}
function parseFibRgFcLcb(bytes, count) {
    const reader = new BinaryReader(bytes);
    const fields = { _pairs: [] };
    const pairs = [];
    for (let i = 0; i < count && i * 8 + 8 <= bytes.length; i += 1) {
        const fc = reader.u32(i * 8);
        const lcb = reader.u32(i * 8 + 4);
        const name = FIB_FC_LCB_NAMES[i] || `Field${i}`;
        fields[`fc${name}`] = fc;
        fields[`lcb${name}`] = lcb;
        pairs.push({ name, fc, lcb, index: i });
    }
    fields._pairs = pairs;
    return fields;
}
