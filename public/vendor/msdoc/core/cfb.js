import { BinaryReader, toUint8Array } from './binary.js';
import { pushWarning } from './utils.js';
const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const DIFSECT = 0xfffffffc;
const MAX_CHAIN_SECTORS = 1 << 20;
const MINI_STREAM_CUTOFF = 4096;
function isSpecialSectorId(sid) {
    return sid === FREESECT || sid === ENDOFCHAIN || sid === FATSECT || sid === DIFSECT;
}
function readSectorAbsolute(bytes, sectorSize, sid) {
    const start = 512 + sid * sectorSize;
    const end = start + sectorSize;
    if (start < 0 || start >= bytes.length) {
        throw new Error(`Sector ${sid} is out of bounds`);
    }
    if (end <= bytes.length)
        return bytes.subarray(start, end);
    const sector = new Uint8Array(sectorSize);
    sector.set(bytes.subarray(start));
    return sector;
}
function collectChain(startSid, nextSectorFn, limit = MAX_CHAIN_SECTORS) {
    const chain = [];
    const seen = new Set();
    let sid = startSid;
    let guard = 0;
    while (sid !== ENDOFCHAIN && sid !== FREESECT && sid >= 0) {
        if (seen.has(sid))
            throw new Error(`Detected sector loop at ${sid}`);
        seen.add(sid);
        chain.push(sid);
        sid = nextSectorFn(sid);
        guard += 1;
        if (guard > limit)
            throw new Error('Sector chain exceeds safe limit');
    }
    return chain;
}
function readChainBytes(bytes, sectorSize, startSid, fat, expectedSize = null) {
    if (startSid === ENDOFCHAIN || startSid === FREESECT || startSid < 0) {
        return new Uint8Array(0);
    }
    const chain = collectChain(startSid, (sid) => fat[sid] ?? ENDOFCHAIN);
    const out = new Uint8Array(chain.length * sectorSize);
    let offset = 0;
    for (const sid of chain) {
        out.set(readSectorAbsolute(bytes, sectorSize, sid), offset);
        offset += sectorSize;
    }
    return expectedSize == null ? out : out.subarray(0, Math.min(expectedSize, out.length));
}
function parseDirectoryTree(entries) {
    function walkSiblings(entryId, out) {
        if (entryId < 0 || entryId >= entries.length)
            return;
        const entry = entries[entryId];
        if (!entry)
            return;
        walkSiblings(entry.leftSiblingId, out);
        out.push(entryId);
        walkSiblings(entry.rightSiblingId, out);
    }
    function attachChildren(storageId) {
        const storage = entries[storageId];
        if (!storage || storage.childId < 0)
            return;
        const childIds = [];
        walkSiblings(storage.childId, childIds);
        storage.children = childIds;
        for (const childId of childIds) {
            const child = entries[childId];
            if (!child)
                continue;
            child.parentId = storageId;
            attachChildren(childId);
        }
    }
    const root = entries.find((entry) => entry.objectType === 5);
    if (!root)
        throw new Error('CFB root storage not found');
    attachChildren(root.id);
    return root;
}
function buildPathMap(entries) {
    const map = new Map();
    for (const entry of entries) {
        if (!entry || !entry.name)
            continue;
        const parts = [];
        let current = entry;
        while (current) {
            if (current.objectType !== 5)
                parts.push(current.name);
            current = current.parentId != null ? entries[current.parentId] ?? null : null;
        }
        const path = `/${parts.reverse().join('/')}`;
        entry.path = path === '/' ? `/${entry.name}` : path;
        map.set(entry.path, entry);
    }
    return map;
}
function normalizeName(name) {
    return name.replace(/\u0000+$/, '');
}
export function parseCFB(input, _options = {}) {
    const bytes = toUint8Array(input);
    const reader = new BinaryReader(bytes);
    const warnings = [];
    for (let i = 0; i < CFB_SIGNATURE.length; i += 1) {
        if (reader.u8(i) !== CFB_SIGNATURE[i]) {
            throw new Error('Not a Compound File Binary document');
        }
    }
    const majorVersion = reader.u16(26);
    const sectorShift = reader.u16(30);
    const miniSectorShift = reader.u16(32);
    const sectorSize = 1 << sectorShift;
    const miniSectorSize = 1 << miniSectorShift;
    const numDirSectors = reader.u32(40);
    const numFatSectors = reader.u32(44);
    const firstDirSector = reader.i32(48);
    const transactionSignature = reader.u32(52);
    const miniStreamCutoffSize = reader.u32(56);
    const firstMiniFatSector = reader.i32(60);
    const numMiniFatSectors = reader.u32(64);
    const firstDifatSector = reader.i32(68);
    const numDifatSectors = reader.u32(72);
    if (miniStreamCutoffSize !== MINI_STREAM_CUTOFF) {
        pushWarning(warnings, `Unexpected mini stream cutoff size ${miniStreamCutoffSize}`);
    }
    const headerDifat = [];
    for (let i = 0; i < 109; i += 1) {
        const sid = reader.i32(76 + i * 4);
        if (!isSpecialSectorId(sid) && sid >= 0)
            headerDifat.push(sid);
    }
    const difat = [...headerDifat];
    let difatSid = firstDifatSector;
    let difatCount = 0;
    while (difatSid !== ENDOFCHAIN && difatSid !== FREESECT && difatSid >= 0) {
        const sector = readSectorAbsolute(bytes, sectorSize, difatSid);
        const sectorReader = new BinaryReader(sector);
        const entriesPerDifatSector = sectorSize / 4 - 1;
        for (let i = 0; i < entriesPerDifatSector; i += 1) {
            const sid = sectorReader.i32(i * 4);
            if (!isSpecialSectorId(sid) && sid >= 0)
                difat.push(sid);
        }
        difatSid = sectorReader.i32(sectorSize - 4);
        difatCount += 1;
        if (difatCount > numDifatSectors + 4) {
            pushWarning(warnings, 'DIFAT chain exceeded declared sector count; stopping early');
            break;
        }
    }
    if (numFatSectors && difat.length < numFatSectors) {
        pushWarning(warnings, `FAT sector count mismatch: header says ${numFatSectors}, found ${difat.length}`);
    }
    const fat = [];
    for (const fatSid of difat) {
        const fatSector = readSectorAbsolute(bytes, sectorSize, fatSid);
        const fatReader = new BinaryReader(fatSector);
        for (let i = 0; i < sectorSize / 4; i += 1) {
            fat.push(fatReader.i32(i * 4));
        }
    }
    const directoryBytes = readChainBytes(bytes, sectorSize, firstDirSector, fat);
    const directoryReader = new BinaryReader(directoryBytes);
    const entries = [];
    for (let offset = 0, id = 0; offset + 128 <= directoryBytes.length; offset += 128, id += 1) {
        const nameLength = directoryReader.u16(offset + 64);
        const name = normalizeName(directoryReader.utf16le(offset, Math.max(0, nameLength - 2)));
        if (!name && directoryReader.u8(offset + 66) === 0)
            continue;
        entries.push({
            id,
            name,
            objectType: directoryReader.u8(offset + 66),
            colorFlag: directoryReader.u8(offset + 67),
            leftSiblingId: directoryReader.i32(offset + 68),
            rightSiblingId: directoryReader.i32(offset + 72),
            childId: directoryReader.i32(offset + 76),
            clsid: directoryReader.slice(offset + 80, 16),
            stateBits: directoryReader.u32(offset + 96),
            creationTime: directoryReader.u64(offset + 100),
            modifiedTime: directoryReader.u64(offset + 108),
            startSector: directoryReader.i32(offset + 116),
            streamSize: majorVersion === 3 ? directoryReader.u32(offset + 120) : directoryReader.u64(offset + 120),
            children: [],
            parentId: null,
        });
    }
    const root = parseDirectoryTree(entries);
    const pathMap = buildPathMap(entries);
    const miniFat = [];
    if (numMiniFatSectors && firstMiniFatSector >= 0) {
        const miniFatBytes = readChainBytes(bytes, sectorSize, firstMiniFatSector, fat);
        const miniFatReader = new BinaryReader(miniFatBytes);
        for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) {
            miniFat.push(miniFatReader.i32(i));
        }
    }
    const rootStreamBytes = readChainBytes(bytes, sectorSize, root.startSector, fat, root.streamSize);
    function readMiniStream(entry) {
        if (entry.startSector < 0)
            return new Uint8Array(0);
        const chain = collectChain(entry.startSector, (sid) => miniFat[sid] ?? ENDOFCHAIN);
        const out = new Uint8Array(chain.length * miniSectorSize);
        let offset = 0;
        for (const miniSid of chain) {
            const start = miniSid * miniSectorSize;
            const end = start + miniSectorSize;
            if (end > rootStreamBytes.length)
                throw new Error(`Mini sector ${miniSid} is out of bounds`);
            out.set(rootStreamBytes.subarray(start, end), offset);
            offset += miniSectorSize;
        }
        return out.subarray(0, Math.min(entry.streamSize, out.length));
    }
    function getStream(identifier) {
        const entry = typeof identifier === 'string' ? pathMap.get(identifier) ?? null : identifier;
        if (!entry)
            return null;
        if (entry.objectType !== 2 && entry.objectType !== 5)
            return null;
        if (entry.objectType === 5)
            return rootStreamBytes;
        if (entry.streamSize < miniStreamCutoffSize && entry.startSector >= 0 && miniFat.length) {
            return readMiniStream(entry);
        }
        return readChainBytes(bytes, sectorSize, entry.startSector, fat, entry.streamSize);
    }
    function listChildren(path) {
        const entry = typeof path === 'string' ? pathMap.get(path) ?? null : path;
        if (!entry)
            return [];
        return (entry.children || []).map((id) => entries[id]).filter((child) => Boolean(child));
    }
    return {
        bytes,
        majorVersion,
        sectorSize,
        miniSectorSize,
        numDirSectors,
        numFatSectors,
        firstDirSector,
        transactionSignature,
        miniStreamCutoffSize,
        warnings,
        entries,
        root,
        pathMap,
        getEntry(path) {
            return pathMap.get(path) ?? null;
        },
        getStream,
        listChildren,
        findByName(name, startPath = '/') {
            const start = startPath === '/' ? root : pathMap.get(startPath) ?? null;
            if (!start)
                return null;
            const stack = [start];
            while (stack.length) {
                const entry = stack.pop();
                if (!entry)
                    continue;
                if (entry.name === name)
                    return entry;
                for (const childId of entry.children || []) {
                    const child = entries[childId];
                    if (child)
                        stack.push(child);
                }
            }
            return null;
        },
    };
}
