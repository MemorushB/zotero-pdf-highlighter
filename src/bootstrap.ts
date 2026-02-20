declare const Zotero: any;

import { extractEntities, type NerEntity } from "./llm";
import { colorForEntityType } from "./entity-colors";
import { computeEntityRects } from "./rect-splitter";

export interface BootstrapData {
    id: string;
    version: string;
    resourceURI: string;
    rootURI: string;
}

let registeredHandler: ((event: any) => void) | null = null;
let toolbarHandler: ((event: any) => void) | null = null;
const FALLBACK_HIGHLIGHT_COLOR = '#ffd400';
const HIGHLIGHT_FAILURE_MESSAGE = 'Could not create a highlight from this selection.';

// ── Preferences ──────────────────────────────────────────────────────

const PREF_PREFIX = 'extensions.zotero-pdf-highlighter.';

const PREF_DEFAULTS: Record<string, string> = {
    apiKey:  '',
    baseURL: 'https://openrouter.ai/api/v1',
    model:   'z-ai/glm-4.5-air:free',
};

function registerPreferenceDefaults(): void {
    for (const [key, val] of Object.entries(PREF_DEFAULTS)) {
        if (Zotero.Prefs.get(PREF_PREFIX + key) === undefined) {
            Zotero.Prefs.set(PREF_PREFIX + key, val, true);
        }
    }
}

// ── UI feedback helpers ──────────────────────────────────────────────

function setButtonState(button: any, text: string, disabled: boolean): void {
    button.textContent = text;
    button.disabled = disabled;
}

function showTemporaryButtonState(button: any, event: any, text: string, durationMs: number): void {
    setButtonState(button, text, true);

    const timerHost = event?.doc?.defaultView;
    if (timerHost && typeof timerHost.setTimeout === 'function') {
        timerHost.setTimeout(() => {
            setButtonState(button, '🔬 NER Highlight', false);
        }, durationMs);
        return;
    }

    setButtonState(button, '🔬 NER Highlight', false);
}

function notifyHighlightFailure(event: any, button: any): 'zotero.alert' | 'inline-hint' {
    if (typeof Zotero?.alert === 'function') {
        const hostWindow = event?.doc?.defaultView || Zotero?.getMainWindow?.();
        try {
            Zotero.alert(hostWindow, 'Zotero PDF Highlighter', HIGHLIGHT_FAILURE_MESSAGE);
            return 'zotero.alert';
        } catch {
            // Fallback handled below.
        }
    }

    Zotero.debug('[Zotero PDF Highlighter] highlight creation failed');
    showTemporaryButtonState(button, event, '❌ Failed', 1500);
    return 'inline-hint';
}

// ── Debug helper ─────────────────────────────────────────────────────

function summarizeResult(result: any): string {
    const MAX_STRING_PREVIEW = 80;

    if (result === null) return 'null';
    if (result === undefined) return 'undefined';

    const resultType = typeof result;
    if (resultType === 'string') {
        const isTruncated = result.length > MAX_STRING_PREVIEW;
        const preview = isTruncated ? `${result.slice(0, MAX_STRING_PREVIEW)}...` : result;
        return `string(len=${result.length}, preview=${JSON.stringify(preview)})`;
    }
    if (resultType === 'number' || resultType === 'boolean' || resultType === 'bigint') {
        return `${resultType}(${String(result)})`;
    }
    if (resultType === 'function') {
        return `function(${result.name || 'anonymous'})`;
    }

    const ctorName = result?.constructor?.name || 'Object';
    if (Array.isArray(result)) return `array(len=${result.length})`;
    if (resultType === 'object') return `object(type=${ctorName}, keys=${Object.keys(result).length})`;
    if (ctorName && ctorName !== 'Object') return `object(${ctorName})`;

    return `type(${resultType})`;
}

// ── Single annotation creation (shared by NER + fallback) ────────────

async function createSingleHighlight(
    event: any,
    annotationBase: any,
    color: string,
    rects: number[][],
    text: string
): Promise<boolean> {
    const reader = event?.reader;

    const fullAnnotation = {
        ...annotationBase,
        type: 'highlight',
        color,
        text,
        position: {
            ...annotationBase.position,
            rects,
        },
    };

    // Path A: Internal annotation manager
    try {
        const internal = reader?._internalReader;
        const mgr = internal?._annotationManager ?? internal?.annotationManager;
        if (mgr && typeof mgr.addAnnotation === 'function') {
            let result = mgr.addAnnotation(fullAnnotation);
            if (result && typeof result.then === 'function') result = await result;
            if (result !== false && result !== null) return true;
        }
    } catch (err: any) {
        Zotero.debug(`[Zotero PDF Highlighter] Path A failed: ${err?.message || err}`);
    }

    // Path B: Zotero.Annotations.saveFromJSON
    try {
        const attachment = reader?._item || (reader?.itemID ? Zotero.Items?.get(reader.itemID) : null);
        if (attachment && typeof Zotero.Annotations?.saveFromJSON === 'function') {
            const json = {
                key: Zotero.DataObjectUtilities?.generateKey?.() || Zotero.Utilities?.generateObjectKey?.() || `highlight_${Date.now()}`,
                ...fullAnnotation,
                comment: fullAnnotation.comment || '',
                tags: fullAnnotation.tags || [],
            };
            let result = Zotero.Annotations.saveFromJSON(attachment, json);
            if (result && typeof result.then === 'function') result = await result;
            return true;
        }
    } catch (err: any) {
        Zotero.debug(`[Zotero PDF Highlighter] Path B failed: ${err?.message || err}`);
    }

    // Path C: _onSetAnnotation
    try {
        const internal = reader?._internalReader;
        if (internal && typeof internal._onSetAnnotation === 'function') {
            let result = internal._onSetAnnotation(fullAnnotation);
            if (result && typeof result.then === 'function') result = await result;
            if (result !== false) return true;
        }
    } catch (err: any) {
        Zotero.debug(`[Zotero PDF Highlighter] Path C failed: ${err?.message || err}`);
    }

    return false;
}

// ── Fallback: single yellow highlight ────────────────────────────────

async function createFallbackHighlight(event: any): Promise<boolean> {
    const base = event?.params?.annotation;
    if (!base?.position) return false;

    Zotero.debug('[Zotero PDF Highlighter] using fallback single yellow highlight');
    return createSingleHighlight(
        event,
        base,
        FALLBACK_HIGHLIGHT_COLOR,
        base.position.rects,
        base.text || ''
    );
}

// ── NER-powered multi-entity highlighting ────────────────────────────

async function createNerHighlightsFallback(
    reader: any,
    annotationBase: any,
    text: string,
    entities: NerEntity[]
): Promise<number> {
    let created = 0;
    const internal = reader?._internalReader || reader;
    const mgr = internal?._annotationManager;
    const baseRects = annotationBase.position?.rects ?? [];
    const pageIndex = annotationBase.position?.pageIndex ?? 0;

    // Get attachment for saveFromJSON - try multiple paths
    const itemID = reader?._itemID || internal?._itemID || reader?.itemID || internal?.itemID;
    let attachment = null;
    if (itemID) {
        try {
            attachment = await Zotero.Items.getAsync(itemID);
            Zotero.debug(`[Zotero PDF Highlighter] Fallback: Got attachment from itemID ${itemID}: ${!!attachment}`);
        } catch (e: any) {
            Zotero.debug(`[Zotero PDF Highlighter] Fallback: Failed to get attachment from itemID: ${e?.message}`);
        }
    }
    // Also try reader._item directly
    if (!attachment && reader?._item) {
        attachment = reader._item;
        Zotero.debug(`[Zotero PDF Highlighter] Fallback: Got attachment from reader._item: ${!!attachment}`);
    }
    if (!attachment) {
        Zotero.debug(`[Zotero PDF Highlighter] Fallback: No attachment found, itemID=${itemID}`);
    }

    for (const entity of entities) {
        try {
            const color = colorForEntityType(entity.type) || '#ffd400';
            const rects = computeEntityRects(text, baseRects, entity.start, entity.end);
            if (rects.length === 0) continue;

            const annotationKey = Zotero.DataObjectUtilities?.generateKey?.()
                || Zotero.Utilities?.generateObjectKey?.()
                || `ner_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

            const annotationData = {
                key: annotationKey,
                type: 'highlight',
                color: color,
                text: entity.text,
                comment: `[${entity.type}]`,
                position: {
                    pageIndex: pageIndex,
                    rects: rects,
                },
                pageLabel: annotationBase.pageLabel || String(pageIndex + 1),
                sortIndex: annotationBase.sortIndex || `${String(pageIndex).padStart(5, '0')}|000000|00000`,
                tags: [],
            };

            Zotero.debug(`[Zotero PDF Highlighter] Creating annotation with color: ${color}`);

            // Primary: Use Zotero.Annotations.saveFromJSON (most reliable)
            if (attachment && typeof Zotero.Annotations?.saveFromJSON === 'function') {
                try {
                    let result = Zotero.Annotations.saveFromJSON(attachment, annotationData);
                    if (result && typeof result.then === 'function') {
                        result = await result;
                    }
                    Zotero.debug(`[Zotero PDF Highlighter] Created highlight for "${entity.text}" via saveFromJSON`);
                    created++;
                    refreshAnnotationView(internal);
                    continue;  // Success, move to next entity
                } catch (saveErr: any) {
                    Zotero.debug(`[Zotero PDF Highlighter] saveFromJSON failed: ${saveErr?.message}`);
                }
            } else {
                Zotero.debug(`[Zotero PDF Highlighter] Fallback: Skipping saveFromJSON: attachment=${!!attachment}, saveFromJSON=${typeof Zotero.Annotations?.saveFromJSON}`);
            }

            // Secondary fallback: Try annotation manager
            if (mgr && typeof mgr.addAnnotation === 'function') {
                try {
                    let result = mgr.addAnnotation(annotationData);
                    if (result && typeof result.then === 'function') {
                        result = await result;
                    }
                    if (result !== false && result !== null) {
                        Zotero.debug(`[Zotero PDF Highlighter] Created highlight for "${entity.text}" via addAnnotation`);
                        created++;
                        refreshAnnotationView(internal);
                        continue;
                    }
                } catch (mgrErr: any) {
                    Zotero.debug(`[Zotero PDF Highlighter] addAnnotation failed: ${mgrErr?.message}`);
                }
            }

            Zotero.debug(`[Zotero PDF Highlighter] All methods failed for "${entity.text}"`);
        } catch (e: any) {
            Zotero.debug(`[Zotero PDF Highlighter] Fallback error for "${entity.text}": ${e?.message}`);
        }
    }

    return created;
}

async function createNerHighlightsWithCharPositions(
    reader: any,
    annotationBase: any,
    text: string,
    entities: NerEntity[]
): Promise<number> {
    let created = 0;

    const internal = reader?._internalReader || reader;
    const mgr = internal?._annotationManager;
    const pageIndex = annotationBase.position?.pageIndex ?? 0;

    // Get attachment for saveFromJSON - try multiple paths
    const itemID = reader?._itemID || internal?._itemID || reader?.itemID || internal?.itemID;
    let attachment = null;
    if (itemID) {
        try {
            attachment = await Zotero.Items.getAsync(itemID);
            Zotero.debug(`[Zotero PDF Highlighter] Got attachment from itemID ${itemID}: ${!!attachment}`);
        } catch (e: any) {
            Zotero.debug(`[Zotero PDF Highlighter] Failed to get attachment from itemID: ${e?.message}`);
        }
    }
    // Also try reader._item directly
    if (!attachment && reader?._item) {
        attachment = reader._item;
        Zotero.debug(`[Zotero PDF Highlighter] Got attachment from reader._item: ${!!attachment}`);
    }
    if (!attachment) {
        Zotero.debug(`[Zotero PDF Highlighter] No attachment found, itemID=${itemID}`);
    }

    // Get character-level positions from PDF.js
    const charPositions = await getCharPositionsForPage(internal, pageIndex);

    if (charPositions.length === 0) {
        Zotero.debug(`[Zotero PDF Highlighter] No char positions for page ${pageIndex}, using fallback`);
        return createNerHighlightsFallback(reader, annotationBase, text, entities);
    }

    // Find the starting offset in the page text that matches our selection
    const pageText = charPositions.map(cp => cp.char).join('');
    
    Zotero.debug(`[Zotero PDF Highlighter] Selection text length: ${text.length}, first 50 chars: "${text.substring(0, 50)}..."`);
    Zotero.debug(`[Zotero PDF Highlighter] Page text length: ${pageText.length}`);

    // Add detailed debugging
    Zotero.debug(`[Zotero PDF Highlighter] Selection first 100 chars: "${text.substring(0, 100)}"`);
    Zotero.debug(`[Zotero PDF Highlighter] Page text first 500 chars: "${pageText.substring(0, 500)}"`);

    // Check if normalized versions help
    const normalizedSelection = normalizeText(text);
    const normalizedPage = normalizeText(pageText);
    Zotero.debug(`[Zotero PDF Highlighter] Normalized selection first 100: "${normalizedSelection.substring(0, 100)}"`);
    Zotero.debug(`[Zotero PDF Highlighter] Normalized page first 500: "${normalizedPage.substring(0, 500)}"`);

    // Try to find why it fails
    const snippet = normalizedSelection.substring(0, 30);
    const snippetIdx = normalizedPage.indexOf(snippet);
    Zotero.debug(`[Zotero PDF Highlighter] First 30-char snippet "${snippet}" found at index: ${snippetIdx}`);
    
    const selectionStartInPage = findTextInPage(pageText, text);

    if (selectionStartInPage < 0) {
        Zotero.debug(`[Zotero PDF Highlighter] Could not find selection text in page, using fallback`);
        return createNerHighlightsFallback(reader, annotationBase, text, entities);
    }

    for (const entity of entities) {
        try {
            const color = colorForEntityType(entity.type) || '#ffd400';

            // Calculate positions in page coordinates
            const entityStartInPage = selectionStartInPage + entity.start;
            const entityEndInPage = selectionStartInPage + entity.end;

            // Get rects for this entity
            const entityRects: number[][] = [];
            for (let i = entityStartInPage; i < entityEndInPage && i < charPositions.length; i++) {
                const cp = charPositions[i];
                if (cp.rect[2] - cp.rect[0] > 0.1) { // Skip zero-width
                    entityRects.push(cp.rect);
                }
            }

            if (entityRects.length === 0) continue;

            const mergedRects = mergeAdjacentRects(entityRects);

            const annotationKey = Zotero.DataObjectUtilities?.generateKey?.()
                || Zotero.Utilities?.generateObjectKey?.()
                || `ner_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

            const annotationData = {
                key: annotationKey,
                type: 'highlight',
                color: color,
                text: entity.text,
                comment: `[${entity.type}]`,
                position: {
                    pageIndex: pageIndex,
                    rects: mergedRects,
                },
                pageLabel: annotationBase.pageLabel || String(pageIndex + 1),
                sortIndex: annotationBase.sortIndex || `${String(pageIndex).padStart(5, '0')}|000000|00000`,
                tags: [],
            };

            // Primary: Use Zotero.Annotations.saveFromJSON (most reliable)
            if (attachment && typeof Zotero.Annotations?.saveFromJSON === 'function') {
                try {
                    let result = Zotero.Annotations.saveFromJSON(attachment, annotationData);
                    if (result && typeof result.then === 'function') {
                        result = await result;
                    }
                    Zotero.debug(`[Zotero PDF Highlighter] Created highlight for "${entity.text}" via saveFromJSON`);
                    created++;
                    refreshAnnotationView(internal);
                    continue;  // Success, move to next entity
                } catch (saveErr: any) {
                    Zotero.debug(`[Zotero PDF Highlighter] saveFromJSON failed: ${saveErr?.message}`);
                }
            } else {
                Zotero.debug(`[Zotero PDF Highlighter] CharPositions: Skipping saveFromJSON: attachment=${!!attachment}, saveFromJSON=${typeof Zotero.Annotations?.saveFromJSON}`);
            }

            // Secondary fallback: Try annotation manager
            if (mgr && typeof mgr.addAnnotation === 'function') {
                try {
                    let result = mgr.addAnnotation(annotationData);
                    if (result && typeof result.then === 'function') {
                        result = await result;
                    }
                    if (result !== false && result !== null) {
                        Zotero.debug(`[Zotero PDF Highlighter] Created highlight for "${entity.text}" via addAnnotation`);
                        created++;
                        refreshAnnotationView(internal);
                        continue;
                    }
                } catch (mgrErr: any) {
                    Zotero.debug(`[Zotero PDF Highlighter] addAnnotation failed: ${mgrErr?.message}`);
                }
            }

            Zotero.debug(`[Zotero PDF Highlighter] All methods failed for "${entity.text}"`);
        } catch (e: any) {
            Zotero.debug(`[Zotero PDF Highlighter] CharPositions failed for "${entity.text}": ${e?.message}`);
        }
    }

    return created;
}

async function createNerHighlights(event: any, button: any): Promise<void> {
    const base = event?.params?.annotation;
    if (!base?.position) {
        notifyHighlightFailure(event, button);
        return;
    }

    const selectedText: string = base.text || '';
    if (!selectedText.trim()) {
        notifyHighlightFailure(event, button);
        return;
    }

    const fullRects: number[][] = base.position.rects || [];
    if (fullRects.length === 0) {
        notifyHighlightFailure(event, button);
        return;
    }

    // Show analyzing state
    setButtonState(button, '⏳ Analyzing...', true);

    let entities: NerEntity[];
    try {
        entities = await extractEntities(selectedText);
    } catch (err: any) {
        Zotero.debug(`[Zotero PDF Highlighter] NER extraction failed: ${err?.message || err}`);
        // Fallback to single yellow highlight
        const fallbackOk = await createFallbackHighlight(event);
        if (fallbackOk) {
            showTemporaryButtonState(button, event, '⚠️ Fallback (1)', 2000);
        } else {
            notifyHighlightFailure(event, button);
        }
        return;
    }

    // No entities found — fallback
    if (entities.length === 0) {
        Zotero.debug('[Zotero PDF Highlighter] NER returned 0 entities, using fallback');
        const fallbackOk = await createFallbackHighlight(event);
        if (fallbackOk) {
            showTemporaryButtonState(button, event, '⚠️ No entities', 2000);
        } else {
            notifyHighlightFailure(event, button);
        }
        return;
    }

    Zotero.debug(`[Zotero PDF Highlighter] creating highlights for ${entities.length} entities`);

    // Use character-level positions for accurate highlighting
    const reader = event?.reader;
    const created = await createNerHighlightsWithCharPositions(reader, base, selectedText, entities);

    // Show result
    const failCount = entities.length - created;
    if (failCount === 0) {
        showTemporaryButtonState(button, event, `✓ Done (${created})`, 2000);
    } else {
        showTemporaryButtonState(button, event, `⚠️ ${created}ok/${failCount}err`, 2500);
    }
}

// ── Text normalization and fuzzy matching ───────────────────────────

function normalizeText(text: string): string {
    // Normalize whitespace and common variations
    return text
        .replace(/\s+/g, ' ')  // Collapse whitespace
        .replace(/[\u2018\u2019]/g, "'")  // Smart quotes to regular
        .replace(/[\u201C\u201D]/g, '"')
        .trim();
}

function findTextInPage(pageText: string, selectionText: string): number {
    // Try exact match first
    let idx = pageText.indexOf(selectionText);
    if (idx >= 0) return idx;

    // Try normalized match
    const normalizedPage = normalizeText(pageText);
    const normalizedSelection = normalizeText(selectionText);
    idx = normalizedPage.indexOf(normalizedSelection);
    if (idx >= 0) return idx;

    // Try finding a significant substring with decreasing lengths
    // Start with 50 chars, then try shorter snippets if that fails
    const snippetLengths = [50, 30, 20];
    for (const len of snippetLengths) {
        if (normalizedSelection.length < len) continue;
        const snippet = normalizedSelection.substring(0, len);
        if (snippet.length > 10) {
            idx = normalizedPage.indexOf(snippet);
            if (idx >= 0) {
                Zotero.debug(`[Zotero PDF Highlighter] findTextInPage: found ${len}-char snippet at index ${idx}`);
                return idx;
            }
        }
    }

    return -1;
}

// ── Rect merging for character-level positions ──────────────────────

function mergeAdjacentRects(rects: number[][]): number[][] {
    if (rects.length === 0) return [];
    if (rects.length === 1) return rects;

    const merged: number[][] = [];
    let current = [...rects[0]];

    for (let i = 1; i < rects.length; i++) {
        const next = rects[i];
        // Check if same line (similar y values, within tolerance)
        const sameY = Math.abs(current[1] - next[1]) < 5 && Math.abs(current[3] - next[3]) < 5;
        // Check if adjacent (next x1 is close to current x2)
        const adjacent = Math.abs(next[0] - current[2]) < 10;

        if (sameY && adjacent) {
            // Merge: extend current rect
            current[2] = next[2]; // extend x2
        } else {
            // Different line or gap: save current and start new
            merged.push(current);
            current = [...next];
        }
    }
    merged.push(current);

    return merged;
}

// ── Character width estimation ──────────────────────────────────────

// Relative width weights for different character classes
// Based on typical proportional font metrics (normalized to average width = 1.0)
const CHAR_WIDTH_WEIGHTS: Record<string, number> = {
    // Narrow characters (~0.3-0.4 relative width)
    narrow: 0.35,
    // Medium-narrow characters (~0.5-0.6)
    mediumNarrow: 0.55,
    // Average width characters (~1.0)
    average: 1.0,
    // Wide characters (~1.2-1.5)
    wide: 1.3,
    // Extra wide characters (~1.5-2.0)
    extraWide: 1.7,
};

function getCharWidthClass(char: string): number {
    const code = char.charCodeAt(0);
    
    // Narrow: i, l, 1, |, ', !, ., :, ;, ,
    if ('il1|\'!.:;,'.includes(char)) return CHAR_WIDTH_WEIGHTS.narrow;
    
    // Medium-narrow: f, t, j, r, I, J, (, ), [, ], {, }
    if ('ftjrIJ()[]{}/-'.includes(char)) return CHAR_WIDTH_WEIGHTS.mediumNarrow;
    
    // Wide: m, w, M, W, @, &
    if ('mwMW@&'.includes(char)) return CHAR_WIDTH_WEIGHTS.wide;
    
    // Extra wide: full-width characters (CJK), em-dash
    if (code >= 0x3000 && code <= 0x9FFF) return CHAR_WIDTH_WEIGHTS.extraWide; // CJK
    if (code >= 0xFF00 && code <= 0xFFEF) return CHAR_WIDTH_WEIGHTS.extraWide; // Fullwidth forms
    if (char === '—' || char === '…') return CHAR_WIDTH_WEIGHTS.wide;
    
    // Spaces: slightly narrower than average
    if (char === ' ') return 0.5;
    
    // Digits: slightly narrower than average
    if (code >= 0x30 && code <= 0x39) return 0.85;
    
    // Uppercase letters (except I, J, M, W which are handled above): wider than average
    if (code >= 0x41 && code <= 0x5A) return 1.1;
    
    // Default: average width
    return CHAR_WIDTH_WEIGHTS.average;
}

/**
 * Estimate individual character widths for a string based on character classes.
 * The sum of returned widths equals the total width.
 */
function estimateCharacterWidths(str: string, totalWidth: number): number[] {
    if (str.length === 0) return [];
    if (str.length === 1) return [totalWidth];
    
    // Calculate relative weights for each character
    const weights = str.split('').map(getCharWidthClass);
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    
    // Avoid division by zero
    if (totalWeight === 0) {
        const uniform = totalWidth / str.length;
        return new Array(str.length).fill(uniform);
    }
    
    // Scale weights to match total width
    return weights.map(w => (w / totalWeight) * totalWidth);
}

// ── Character position extraction from PDF.js ───────────────────────

async function getCharPositionsForPage(
    internal: any,
    pageIndex: number
): Promise<Array<{char: string, rect: number[]}>> {
    const charPositions: Array<{char: string, rect: number[]}> = [];

    try {
        const pdfPages = internal?._primaryView?._iframeWindow?.wrappedJSObject?.PDFViewerApplication?.pdfViewer?._pages
            || internal?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer?._pages;

        if (!pdfPages || !pdfPages[pageIndex]) return charPositions;

        const pdfPage = pdfPages[pageIndex].pdfPage;
        if (!pdfPage) return charPositions;

        // Try to get text content with character-level geometry if available
        let textContent;
        try {
            // Some PDF.js versions support includeCharsGeometry option
            textContent = await pdfPage.getTextContent({ includeCharsGeometry: true });
        } catch {
            textContent = await pdfPage.getTextContent();
        }
        const items = textContent?.items || [];

        // Debug: log first item structure to understand available properties
        if (items.length > 0) {
            const sampleItem = items[0];
            Zotero.debug(`[Zotero PDF Highlighter] Sample text item keys: ${Object.keys(sampleItem).join(', ')}`);
            if (sampleItem.chars) {
                Zotero.debug(`[Zotero PDF Highlighter] chars array available with ${sampleItem.chars.length} entries`);
            }
        }

        for (const item of items) {
            if (!item.str) continue;
            const str = item.str;
            const transform = item.transform;
            const width = item.width || 0;
            const height = item.height || Math.abs(transform[3]) || 12;
            const baseline = transform[5];

            // If char-level positions are available, use them
            if (item.chars && Array.isArray(item.chars) && item.chars.length === str.length) {
                for (let i = 0; i < item.chars.length; i++) {
                    const charInfo = item.chars[i];
                    const charTransform = charInfo.transform || transform;
                    const charX = charTransform[4];
                    const charW = charInfo.width || (width / str.length);
                    
                    const yShift = height * 0.25;
                    const y1 = baseline - yShift;
                    const y2 = baseline + height - yShift;
                    
                    charPositions.push({
                        char: str[i],
                        rect: [charX, y1, charX + charW, y2],
                    });
                }
                continue;
            }

            // Fallback: estimate character widths based on character class
            const charWidths = estimateCharacterWidths(str, width);
            let x = transform[4];

            // Center-align highlight vertically with text
            // PDF baseline is where letters sit; text extends mostly above
            // Shift down by ~25% of height to center the highlight
            const yShift = height * 0.25;
            const y1 = baseline - yShift;
            const y2 = baseline + height - yShift;

            for (let i = 0; i < str.length; i++) {
                const cw = charWidths[i];
                charPositions.push({
                    char: str[i],
                    rect: [x, y1, x + cw, y2],
                });
                x += cw;
            }
        }
    } catch (e) {
        Zotero.debug(`[Zotero PDF Highlighter] getCharPositionsForPage error: ${e}`);
    }

    return charPositions;
}

// ── Annotation view refresh helper ──────────────────────────────────

function refreshAnnotationView(internal: any): void {
    try {
        // Try to trigger a re-render of annotations
        const annotationManager = internal?._annotationManager;
        if (annotationManager?.render) {
            annotationManager.render();
        }

        // Alternative: trigger PDF viewer update
        const pdfViewer = internal?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer;
        if (pdfViewer?.update) {
            pdfViewer.update();
        }
    } catch {
        // Silent fail - refresh is nice-to-have
    }
}

// ── Bootstrap lifecycle ──────────────────────────────────────────────

export function install(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: installed");
}

export function startup(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: startup");

    registerPreferenceDefaults();

    // Create global namespace for hooks (must be before PreferencePanes.register)
    if (!Zotero.ZoteroPDFHighlighter) {
        Zotero.ZoteroPDFHighlighter = {};
    }
    Zotero.ZoteroPDFHighlighter.hooks = {
        _prefsCleanup: null as (() => void) | null,

        onPrefsLoad: (event: any) => {
            // Cleanup previous listeners if any
            Zotero.ZoteroPDFHighlighter.hooks._prefsCleanup?.();

            Zotero.debug('[Zotero PDF Highlighter] onPrefsLoad triggered');

            const doc = event.target?.ownerDocument || event.currentTarget?.ownerDocument;
            if (!doc) {
                Zotero.debug('[Zotero PDF Highlighter] WARNING: Could not get prefs document from event');
                return;
            }

            Zotero.debug(`[Zotero PDF Highlighter] Prefs doc: ${doc?.location?.href || 'unknown'}`);

            const inputs: Record<string, string> = {
                'pref-apiKey': 'apiKey',
                'pref-baseURL': 'baseURL',
                'pref-model': 'model',
                'pref-systemPrompt': 'systemPrompt',
            };

            const handlers: Array<{ el: Element; type: string; fn: () => void }> = [];

            for (const [inputId, prefKey] of Object.entries(inputs)) {
                const input = doc.getElementById(inputId) as HTMLInputElement | null;
                Zotero.debug(`[Zotero PDF Highlighter] Input ${inputId}: ${!!input}`);

                if (!input) continue;

                // Load current value
                const fullKey = PREF_PREFIX + prefKey;
                const currentValue = Zotero.Prefs.get(fullKey) ?? '';
                input.value = currentValue;
                Zotero.debug(`[Zotero PDF Highlighter] Loaded ${fullKey} = ${currentValue ? '***' : '(empty)'}`);

                // Save on change
                const saveHandler = () => {
                    try {
                        const value = input.value;
                        Zotero.Prefs.set(fullKey, value);
                        Zotero.debug(`[Zotero PDF Highlighter] Saved ${fullKey}`);
                    } catch (e) {
                        Zotero.debug(`[Zotero PDF Highlighter] Error saving ${fullKey}: ${e}`);
                    }
                };

                input.addEventListener('change', saveHandler);
                input.addEventListener('blur', saveHandler);
                handlers.push({ el: input, type: 'change', fn: saveHandler });
                handlers.push({ el: input, type: 'blur', fn: saveHandler });
            }

            // Store cleanup function
            Zotero.ZoteroPDFHighlighter.hooks._prefsCleanup = () => {
                for (const { el, type, fn } of handlers) {
                    el.removeEventListener(type, fn);
                }
                Zotero.debug('[Zotero PDF Highlighter] Prefs listeners cleaned up');
            };
        }
    };

    // Register preferences pane (scaffold pattern)
    if (data.rootURI && Zotero.PreferencePanes?.register) {
        Zotero.PreferencePanes.register({
            pluginID: 'zotero-pdf-highlighter@memorushb.com',
            src: data.rootURI + 'content/preferences.xhtml',
            scripts: [data.rootURI + 'content/preferences.js'],
            label: 'PDF Highlighter',
        });
    }

    registeredHandler = (event: any) => {
        const { append, doc } = event;
        const button = doc.createElement('button');
        button.textContent = '🔬 NER Highlight';
        button.style.backgroundColor = '#1e1e1e';
        button.style.color = '#d4d4d4';
        button.style.border = '1px solid #333';
        button.style.borderRadius = '3px';
        button.style.padding = '2px 5px';
        button.style.cursor = 'pointer';

        button.onclick = async () => {
            await createNerHighlights(event, button);
        };

        append(button);
    };
    Zotero.Reader.registerEventListener('renderTextSelectionPopup', registeredHandler, 'zotero-pdf-highlighter');

    // Register toolbar button for whole-document NER (all pages)
    toolbarHandler = (event: any) => {
        const { append, doc, reader } = event;
        const button = doc.createElement('button');
        button.id = 'zotero-pdf-highlighter-toolbar-btn';
        button.textContent = '🔬 NER';
        button.title = 'Run NER highlighting on ALL pages';
        button.style.cssText = 'background:#1e1e1e;color:#d4d4d4;border:1px solid #333;border-radius:3px;padding:2px 8px;cursor:pointer;font-size:12px;margin-left:4px;';

        button.onclick = async () => {
            button.disabled = true;
            button.textContent = '⏳ Starting...';

            try {
                const internal = reader?._internalReader;
                const attachment = reader?._item || (reader?.itemID ? Zotero.Items?.get(reader.itemID) : null);

                // Get total page count
                const pdfViewer = internal?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer;
                const totalPages = pdfViewer?.pagesCount || 1;

                Zotero.debug(`[Zotero PDF Highlighter] Processing ${totalPages} pages`);

                let totalCreated = 0;

                for (let pageIdx = 0; pageIdx < totalPages; pageIdx++) {
                    try {
                        button.textContent = `⏳ Page ${pageIdx + 1}/${totalPages}`;

                        // Get text content for this page
                        const pdfPages = internal?._primaryView?._iframeWindow?.wrappedJSObject?.PDFViewerApplication?.pdfViewer?._pages
                            || internal?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer?._pages;

                        if (!pdfPages || !pdfPages[pageIdx]) {
                            Zotero.debug(`[Zotero PDF Highlighter] Page ${pageIdx} not available, skipping`);
                            continue;
                        }

                        const pdfPage = pdfPages[pageIdx].pdfPage;
                        if (!pdfPage) continue;

                        const textContent = await pdfPage.getTextContent();
                        const items = textContent?.items || [];

                        // Build page text and track character-level positions
                        let pageText = '';
                        const charPositions: Array<{ char: string; rect: number[]; pageIndex: number }> = [];

                        for (const item of items) {
                            if (!item.str) continue;
                            const str = item.str;
                            const transform = item.transform; // [scaleX, skewX, skewY, scaleY, translateX, translateY]
                            const width = item.width || 0;
                            const height = item.height || Math.abs(transform[3]) || 12;
                            const baseline = transform[5];

                            // Estimate character widths based on character class
                            const charWidths = estimateCharacterWidths(str, width);
                            let x = transform[4];

                            // Center-align highlight vertically with text
                            // PDF baseline is where letters sit; text extends mostly above
                            // Shift down by ~25% of height to center the highlight
                            const yShift = height * 0.25;
                            const y1 = baseline - yShift;
                            const y2 = baseline + height - yShift;

                            for (let i = 0; i < str.length; i++) {
                                const cw = charWidths[i];
                                charPositions.push({
                                    char: str[i],
                                    rect: [x, y1, x + cw, y2],
                                    pageIndex: pageIdx,
                                });
                                x += cw;
                            }
                            pageText += str;

                            // Handle end-of-line
                            if (item.hasEOL) {
                                charPositions.push({
                                    char: '\n',
                                    rect: [0, 0, 0, 0], // Newlines have no visual rect
                                    pageIndex: pageIdx,
                                });
                                pageText += '\n';
                            }
                        }

                        if (pageText.trim().length === 0) {
                            Zotero.debug(`[Zotero PDF Highlighter] Page ${pageIdx} has no text, skipping`);
                            continue;
                        }

                        Zotero.debug(`[Zotero PDF Highlighter] Page ${pageIdx} text length: ${pageText.length}`);

                        // Call NER for this page
                        const entities = await extractEntities(pageText);
                        if (!entities || entities.length === 0) {
                            Zotero.debug(`[Zotero PDF Highlighter] No entities found on page ${pageIdx}`);
                            continue;
                        }

                        Zotero.debug(`[Zotero PDF Highlighter] Found ${entities.length} entities on page ${pageIdx}`);

                        // Create highlights for each entity
                        for (const entity of entities) {
                            try {
                                const entityColor = colorForEntityType(entity.type) || '#ffd400';

                                // Get rects for this entity using character positions
                                const entityRects: number[][] = [];
                                for (let i = entity.start; i < entity.end && i < charPositions.length; i++) {
                                    const pos = charPositions[i];
                                    // Skip newlines and zero-width rects
                                    if (pos.char === '\n' || (pos.rect[2] - pos.rect[0]) < 0.1) continue;
                                    entityRects.push(pos.rect);
                                }

                                if (entityRects.length === 0) {
                                    Zotero.debug(`[Zotero PDF Highlighter] No rects for "${entity.text}", skipping`);
                                    continue;
                                }

                                // Merge adjacent rects on same line into single rects
                                const mergedRects = mergeAdjacentRects(entityRects);

                                const annotationKey = Zotero.DataObjectUtilities?.generateKey?.()
                                    || Zotero.Utilities?.generateObjectKey?.()
                                    || `ner_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

                                const annotationData = {
                                    key: annotationKey,
                                    type: 'highlight',
                                    color: entityColor,
                                    text: entity.text,
                                    comment: `[${entity.type}]`,
                                    position: {
                                        pageIndex: pageIdx,
                                        rects: mergedRects,
                                    },
                                    pageLabel: String(pageIdx + 1),
                                    sortIndex: `${String(pageIdx).padStart(5, '0')}|000000|00000`,
                                    tags: [],
                                };

                                // Try to create annotation
                                if (attachment && typeof Zotero.Annotations?.saveFromJSON === 'function') {
                                    let result = Zotero.Annotations.saveFromJSON(attachment, annotationData);
                                    if (result && typeof result.then === 'function') {
                                        result = await result;
                                    }
                                    totalCreated++;
                                    // Refresh view after each highlight for live feedback
                                    refreshAnnotationView(internal);
                                    Zotero.debug(`[Zotero PDF Highlighter] Created highlight for "${entity.text}" on page ${pageIdx}`);
                                }
                            } catch (e: any) {
                                Zotero.debug(`[Zotero PDF Highlighter] Failed to create highlight for "${entity.text}": ${e?.message}`);
                            }
                        }

                    } catch (pageErr: any) {
                        Zotero.debug(`[Zotero PDF Highlighter] Error processing page ${pageIdx}: ${pageErr?.message}`);
                    }
                }

                Zotero.debug(`[Zotero PDF Highlighter] Total highlights created: ${totalCreated}`);
                button.textContent = `✓ ${totalCreated} entities`;
                setTimeout(() => { button.textContent = '🔬 NER'; button.disabled = false; }, 3000);

            } catch (error: any) {
                Zotero.debug(`[Zotero PDF Highlighter] Toolbar NER failed: ${error?.message || error}`);
                button.textContent = '❌ Error';
                setTimeout(() => { button.textContent = '🔬 NER'; button.disabled = false; }, 2000);
            }
        };

        append(button);
    };
    Zotero.Reader.registerEventListener('renderToolbar', toolbarHandler, 'zotero-pdf-highlighter');
}

export function shutdown(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: shutdown");

    if (registeredHandler) {
        Zotero.Reader.unregisterEventListener('renderTextSelectionPopup', registeredHandler);
        registeredHandler = null;
    }

    if (toolbarHandler) {
        Zotero.Reader.unregisterEventListener('renderToolbar', toolbarHandler);
        toolbarHandler = null;
    }

    // Cleanup prefs listeners
    Zotero.ZoteroPDFHighlighter?.hooks?._prefsCleanup?.();

    // Clean up global namespace
    if (Zotero.ZoteroPDFHighlighter) {
        delete Zotero.ZoteroPDFHighlighter;
    }
}

export function uninstall(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: uninstalled");
}
