import { JC_MAP, UNDERLINE_MAP, VERTICAL_ALIGN_MAP } from './constants.js';
export function propertyArrayToMaps(properties) {
    const out = { char: {}, para: {}, table: {} };
    for (const prop of properties || []) {
        if (prop.kind === 'unknown')
            continue;
        const bucket = out[prop.kind];
        bucket[prop.name] = prop.value;
    }
    return out;
}
export function charPropsToState(properties) {
    const state = {
        bold: false,
        italic: false,
        strike: false,
        underline: 0,
        fontSizeHalfPoints: undefined,
        fontFamilyId: undefined,
        colorIndex: undefined,
        highlight: undefined,
        spacing: 0,
        positionHalfPoints: 0,
        scale: 100,
        hidden: false,
        smallCaps: false,
        caps: false,
        outline: false,
        shadow: false,
        emboss: false,
        imprint: false,
        rtl: false,
        pictureOffset: undefined,
        data: false,
        ole2: false,
        object: false,
        special: false,
        charStyleId: undefined,
    };
    for (const prop of properties || []) {
        switch (prop.name) {
            case 'plain':
                if (prop.value) {
                    state.bold = false;
                    state.italic = false;
                    state.strike = false;
                    state.underline = 0;
                    state.smallCaps = false;
                    state.caps = false;
                }
                break;
            case 'bold':
            case 'revisionDeleted':
            case 'revisionInserted':
            case 'italic':
            case 'strike':
            case 'hidden':
            case 'smallCaps':
            case 'caps':
            case 'outline':
            case 'shadow':
            case 'emboss':
            case 'imprint':
            case 'rtl':
            case 'data':
            case 'ole2':
            case 'object':
            case 'special':
                state[prop.name] = Boolean(prop.value);
                break;
            case 'underline':
                state.underline = prop.value ?? 0;
                break;
            case 'fontSizeHalfPoints':
                state.fontSizeHalfPoints = prop.value;
                break;
            case 'fontFamilyId':
                state.fontFamilyId = prop.value;
                break;
            case 'colorIndex':
                state.colorIndex = prop.value;
                break;
            case 'highlight':
                state.highlight = prop.value;
                break;
            case 'spacing':
                state.spacing = prop.value || 0;
                break;
            case 'positionHalfPoints':
                state.positionHalfPoints = prop.value || 0;
                break;
            case 'scale':
                state.scale = prop.value || 100;
                break;
            case 'pictureOffset':
                state.pictureOffset = prop.value;
                break;
            case 'charStyleId':
                state.charStyleId = prop.value;
                break;
            default:
                state[prop.name] = prop.value;
                break;
        }
    }
    return state;
}
export function paraPropsToState(properties) {
    const state = {
        styleId: 0,
        alignment: 0,
        spacingBefore: 0,
        spacingAfter: 0,
        lineSpacing: 0,
        lineSpacingRule: 'auto',
        leftIndent: 0,
        rightIndent: 0,
        firstLineIndent: 0,
        keepLines: false,
        keepNext: false,
        pageBreakBefore: false,
        widowControl: false,
        inTable: false,
        tableRowEnd: false,
        innerTableCell: false,
        innerTableRowEnd: false,
        itap: 0,
        dtap: 0,
        listLevel: undefined,
        listId: undefined,
        rtlPara: false,
        adjustRight: false,
        frameLeft: undefined,
        frameTop: undefined,
        frameWidth: undefined,
        frameHeight: undefined,
        framePosition: undefined,
        frameWrap: undefined,
        borders: {},
        shading: undefined,
    };
    for (const prop of properties || []) {
        switch (prop.name) {
            case 'styleId':
                state.styleId = prop.value || 0;
                break;
            case 'alignment':
                state.alignment = prop.value ?? 0;
                break;
            case 'spacingBefore':
                state.spacingBefore = prop.value || 0;
                break;
            case 'spacingAfter':
                state.spacingAfter = prop.value || 0;
                break;
            case 'lineSpacing': {
                state.lineSpacing = prop.value || 0;
                const bytes = prop.operandBytes;
                const absolute = bytes && bytes.length >= 4
                    ? bytes[2] === 0 && bytes[3] === 0
                    : state.lineSpacing < 0;
                state.lineSpacingRule = absolute
                    ? state.lineSpacing < 0 ? 'exact' : 'atLeast'
                    : 'auto';
                break;
            }
            case 'leftIndent':
                state.leftIndent = prop.value || 0;
                break;
            case 'rightIndent':
                state.rightIndent = prop.value || 0;
                break;
            case 'firstLineIndent':
                state.firstLineIndent = prop.value || 0;
                break;
            case 'keepLines':
            case 'keepNext':
            case 'pageBreakBefore':
            case 'widowControl':
            case 'inTable':
            case 'tableRowEnd':
            case 'innerTableCell':
            case 'innerTableRowEnd':
            case 'rtlPara':
            case 'adjustRight':
                state[prop.name] = Boolean(prop.value);
                break;
            case 'itap':
                state.itap = prop.value || 0;
                break;
            case 'dtap':
                state.dtap = prop.value || 0;
                break;
            case 'listLevel':
                state.listLevel = prop.value;
                break;
            case 'listId':
                state.listId = prop.value;
                break;
            case 'frameLeft':
                state.frameLeft = prop.value;
                break;
            case 'frameTop':
                state.frameTop = prop.value;
                break;
            case 'frameWidth':
                state.frameWidth = prop.value;
                break;
            case 'frameHeight':
                state.frameHeight = prop.value;
                break;
            case 'framePosition':
                state.framePosition = prop.value;
                break;
            case 'frameWrap':
                state.frameWrap = prop.value;
                break;
            case 'borderTop':
                state.borders.top = prop.value;
                break;
            case 'borderLeft':
                state.borders.left = prop.value;
                break;
            case 'borderBottom':
                state.borders.bottom = prop.value;
                break;
            case 'borderRight':
                state.borders.right = prop.value;
                break;
            case 'borderBetween':
                state.borders.between = prop.value;
                break;
            case 'borderBar':
                state.borders.bar = prop.value;
                break;
            case 'shading':
                state.shading = prop.value;
                break;
            default:
                state[prop.name] = prop.value;
                break;
        }
    }
    return state;
}
export function tablePropsToState(properties) {
    const state = {
        styleId: undefined,
        alignment: 0,
        leftIndent: 0,
        gapHalf: 0,
        cantSplit: false,
        header: false,
        rowHeight: 0,
        rtl: false,
        positionCode: undefined,
        absLeft: undefined,
        absTop: undefined,
        distanceLeft: undefined,
        distanceTop: undefined,
        tableWidth: undefined,
        autoFit: undefined,
        widthBefore: undefined,
        widthAfter: undefined,
        borders: {},
        defTable: undefined,
        operations: [],
    };
    for (const prop of properties || []) {
        switch (prop.name) {
            case 'styleId':
                state.styleId = prop.value;
                break;
            case 'alignment':
                state.alignment = prop.value ?? 0;
                break;
            case 'leftIndent':
                state.leftIndent = prop.value || 0;
                break;
            case 'gapHalf':
                state.gapHalf = prop.value || 0;
                break;
            case 'cantSplit':
            case 'header':
            case 'rtl':
                state[prop.name] = Boolean(prop.value);
                break;
            case 'rowHeight':
                state.rowHeight = prop.value || 0;
                break;
            case 'positionCode':
                state.positionCode = prop.value;
                break;
            case 'absLeft':
                state.absLeft = prop.value;
                break;
            case 'absTop':
                state.absTop = prop.value;
                break;
            case 'distanceLeft':
                state.distanceLeft = prop.value;
                break;
            case 'distanceTop':
                state.distanceTop = prop.value;
                break;
            case 'tableWidth':
                state.tableWidth = prop.value;
                break;
            case 'autoFit':
                state.autoFit = prop.value;
                break;
            case 'widthBefore':
                state.widthBefore = prop.value;
                break;
            case 'widthAfter':
                state.widthAfter = prop.value;
                break;
            case 'tableBorders':
                state.borders = prop.value || {};
                break;
            case 'defTable':
                state.defTable = prop.value;
                break;
            default:
                state.operations.push(prop);
                break;
        }
    }
    return state;
}
export function getTableDepth(paraState) {
    if (!paraState?.inTable)
        return 0;
    return Math.max(1, paraState.itap || 0 || (paraState.dtap ? paraState.dtap : 1));
}
export function cssTextAlign(value) {
    return JC_MAP[value] || 'left';
}
export function cssUnderline(value) {
    return UNDERLINE_MAP[value] || (value ? 'single' : 'none');
}
export function cssVerticalAlign(value) {
    return VERTICAL_ALIGN_MAP[value] || 'top';
}
export function rangeApply(list, range, callback) {
    if (!range)
        return;
    const first = Math.max(0, range.first || 0);
    const lim = Math.max(first, range.lim || first);
    for (let i = first; i < lim && i < list.length; i += 1)
        callback(list[i], i);
}
export function applyTableStateToCells(tableState) {
    const def = tableState?.defTable;
    const cells = (def?.cells || []).map((cell, index) => ({
        index,
        width: def?.rgdxaCenter?.[index + 1] != null && def?.rgdxaCenter?.[index] != null
            ? Math.max(0, def.rgdxaCenter[index + 1] - def.rgdxaCenter[index])
            : cell?.wWidth,
        ftsWidth: cell?.tcgrf?.ftsWidth,
        borders: (cell?.borders || {}),
        merge: cell?.tcgrf?.horzMerge || 0,
        vertMerge: cell?.tcgrf?.vertMerge || 0,
        vertAlign: cell?.tcgrf?.vertAlign || 0,
        fitText: Boolean(cell?.tcgrf?.fitText),
        noWrap: Boolean(cell?.tcgrf?.noWrap),
        hideMark: Boolean(cell?.tcgrf?.hideMark),
        textFlow: cell?.tcgrf?.textFlow || 0,
        rightBoundary: def?.rgdxaCenter?.[index + 1],
        leftBoundary: def?.rgdxaCenter?.[index],
    }));
    let geometryChanged = false;
    const initialLeftBoundary = cells[0]?.leftBoundary || 0;
    for (const op of tableState.operations || []) {
        switch (op.name) {
            case 'insertCells': {
                if (def?.cells?.length)
                    break;
                const value = op.value;
                const first = Math.min(cells.length, Math.max(0, value?.itcFirst || 0));
                const count = Math.min(63 - cells.length, Math.max(0, value?.ctc || 0));
                const width = Math.max(0, value?.dxaCol || 0);
                if (count) {
                    cells.splice(first, 0, ...Array.from({ length: count }, (_, offset) => ({
                        index: first + offset,
                        width,
                        borders: {},
                        merge: 0,
                        vertMerge: 0,
                        vertAlign: 0,
                        fitText: false,
                        noWrap: false,
                        hideMark: false,
                        textFlow: 0,
                    })));
                    geometryChanged = true;
                }
                break;
            }
            case 'deleteCells': {
                const range = op.value;
                if (range) {
                    const first = Math.max(0, range.first || 0);
                    const count = Math.max(0, (range.lim || first) - first);
                    if (count) {
                        cells.splice(first, count);
                        geometryChanged = true;
                    }
                }
                break;
            }
            case 'merge':
                rangeApply(cells, op.value, (cell, idx) => {
                    const range = op.value;
                    if (idx === range.first)
                        cell.merge = 2;
                    else
                        cell.merge = 1;
                });
                break;
            case 'split':
                rangeApply(cells, op.value, (cell) => { cell.merge = 0; });
                break;
            case 'cellWidth':
                rangeApply(cells, op.value.range, (cell) => {
                    const value = op.value;
                    cell.ftsWidth = value.ftsWidth;
                    if ((value.ftsWidth === 2 || value.ftsWidth === 3) && value.width != null) {
                        cell.width = value.width;
                    }
                });
                break;
            case 'columnWidth':
                rangeApply(cells, op.value.range, (cell) => {
                    cell.width = Math.max(0, op.value.width || 0);
                    geometryChanged = true;
                });
                break;
            case 'vertMerge': {
                const value = op.value;
                const cell = value?.index != null ? cells[value.index] : undefined;
                if (cell)
                    cell.vertMerge = value?.value || 0;
                break;
            }
            case 'vertAlign':
                rangeApply(cells, op.value.range, (cell) => { cell.vertAlign = op.value.value; });
                break;
            case 'setBorder':
                rangeApply(cells, op.value.range, (cell) => {
                    const value = op.value;
                    const borders = { ...(cell.borders || {}) };
                    if (value.bordersToApply & 0x01)
                        borders.top = value.border;
                    if (value.bordersToApply & 0x02)
                        borders.left = value.border;
                    if (value.bordersToApply & 0x04)
                        borders.bottom = value.border;
                    if (value.bordersToApply & 0x08)
                        borders.right = value.border;
                    if (value.bordersToApply & 0x10)
                        borders.diagonalDown = value.border;
                    if (value.bordersToApply & 0x20)
                        borders.diagonalUp = value.border;
                    cell.borders = borders;
                });
                break;
            case 'setShading':
                rangeApply(cells, op.value.range, (cell, index) => {
                    const value = op.value;
                    if (!value.odd || (index - value.range.first) % 2 === 0)
                        cell.shading = value.shading;
                });
                break;
            case 'cellPadding':
            case 'cellSpacing': {
                const value = op.value;
                const isTwips = value?.ftsWidth === 3 || (op.name === 'cellSpacing' && value?.ftsWidth === 0x13);
                if (!value?.range || !isTwips || value.width == null)
                    break;
                rangeApply(cells, value.range, (cell) => {
                    const key = op.name === 'cellPadding' ? 'paddingTwips' : 'spacingTwips';
                    const sides = { ...(cell[key] || {}) };
                    if ((value.sides || 0) & 0x01)
                        sides.top = value.width;
                    if ((value.sides || 0) & 0x02)
                        sides.left = value.width;
                    if ((value.sides || 0) & 0x04)
                        sides.bottom = value.width;
                    if ((value.sides || 0) & 0x08)
                        sides.right = value.width;
                    cell[key] = sides;
                });
                break;
            }
            case 'defaultShading': {
                const value = op.value;
                (value?.values || []).forEach((shading, offset) => {
                    const cell = cells[(value?.start || 0) + offset];
                    if (cell)
                        cell.shading = shading;
                });
                break;
            }
            case 'fitText':
                rangeApply(cells, op.value.range, (cell) => { cell.fitText = Boolean(op.value.value); });
                break;
            case 'cellNoWrap':
                rangeApply(cells, op.value.range, (cell) => { cell.noWrap = Boolean(op.value.value); });
                break;
            case 'textFlow':
                rangeApply(cells, op.value.range, (cell) => { cell.textFlow = op.value.value; });
                break;
            default:
                break;
        }
    }
    if (geometryChanged) {
        let boundary = initialLeftBoundary;
        cells.forEach((cell) => {
            const width = Math.max(0, cell.width || 0);
            cell.leftBoundary = boundary;
            boundary += width;
            cell.rightBoundary = boundary;
        });
    }
    cells.forEach((cell, index) => { cell.index = index; });
    return cells;
}
