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

    let successCount = 0;
    let failCount = 0;

    for (const entity of entities) {
        const entityRects = computeEntityRects(selectedText, fullRects, entity.start, entity.end);
        if (entityRects.length === 0) {
            Zotero.debug(`[Zotero PDF Highlighter] no rects for entity "${entity.text}" — skipping`);
            failCount++;
            continue;
        }

        const color = colorForEntityType(entity.type);
        const created = await createSingleHighlight(event, base, color, entityRects, entity.text);

        if (created) {
            successCount++;
            Zotero.debug(`[Zotero PDF Highlighter] ✓ "${entity.text}" [${entity.type}] → ${color}`);
        } else {
            failCount++;
            Zotero.debug(`[Zotero PDF Highlighter] ✗ failed to create highlight for "${entity.text}"`);
        }
    }

    // Show result
    if (failCount === 0) {
        showTemporaryButtonState(button, event, `✓ Done (${successCount})`, 2000);
    } else {
        showTemporaryButtonState(button, event, `⚠️ ${successCount}ok/${failCount}err`, 2500);
    }
}

// ── Bootstrap lifecycle ──────────────────────────────────────────────

export function install(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: installed");
}

export function startup(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: startup");

    registerPreferenceDefaults();

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

    // Register toolbar button for whole-page NER
    toolbarHandler = (event: any) => {
        const { append, doc, reader } = event;
        const button = doc.createElement('button');
        button.id = 'zotero-pdf-highlighter-toolbar-btn';
        button.textContent = '🔬 NER';
        button.title = 'Run NER highlighting on current page';
        button.style.cssText = 'background:#1e1e1e;color:#d4d4d4;border:1px solid #333;border-radius:3px;padding:2px 8px;cursor:pointer;font-size:12px;margin-left:4px;';

        button.onclick = async () => {
            button.disabled = true;
            button.textContent = '⏳ Analyzing...';
            try {
                // Get current page text from the reader
                const internal = reader?._internalReader;
                const currentPageIndex = internal?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer?.currentPageNumber
                    ? internal._primaryView._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber - 1
                    : 0;

                // Try to get text content from PDF.js
                const pdfPages = internal?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer?._pages;
                let pageText = '';
                const pageRects: number[][] = [];

                if (pdfPages && pdfPages[currentPageIndex]) {
                    const pdfPage = pdfPages[currentPageIndex].pdfPage;
                    if (pdfPage) {
                        const textContent = await pdfPage.getTextContent();
                        const items = textContent.items || [];

                        for (const item of items) {
                            if (item.str) {
                                const tx = item.transform;
                                // transform = [scaleX, skewX, skewY, scaleY, translateX, translateY]
                                const x = tx[4];
                                const y = tx[5];
                                const width = item.width;
                                const height = Math.abs(tx[3]) || item.height || 12;

                                pageText += item.str;
                                pageRects.push([x, y, x + width, y + height]);
                            }
                            if (item.hasEOL) {
                                pageText += '\n';
                            }
                        }
                    }
                }

                if (!pageText.trim()) {
                    Zotero.debug('[Zotero PDF Highlighter] No text found on current page');
                    button.textContent = '❌ No text';
                    setTimeout(() => { button.textContent = '🔬 NER'; button.disabled = false; }, 2000);
                    return;
                }

                Zotero.debug(`[Zotero PDF Highlighter] Page ${currentPageIndex} text length: ${pageText.length}`);

                // Call LLM for NER
                const entities = await extractEntities(pageText);
                Zotero.debug(`[Zotero PDF Highlighter] Found ${entities.length} entities on page`);

                if (entities.length === 0) {
                    button.textContent = '✓ No entities';
                    setTimeout(() => { button.textContent = '🔬 NER'; button.disabled = false; }, 2000);
                    return;
                }

                // Create highlights for each entity
                const attachment = reader?._item || (reader?.itemID ? Zotero.Items?.get(reader.itemID) : null);
                const mgr = internal?._annotationManager;

                let created = 0;
                for (const entity of entities) {
                    try {
                        const entityColor = colorForEntityType(entity.type);
                        const entityRects = computeEntityRects(pageText, pageRects, entity.start, entity.end);

                        if (entityRects.length === 0) continue;

                        const annotation = {
                            type: 'highlight',
                            color: entityColor,
                            text: entity.text,
                            comment: `[${entity.type}]`,
                            position: {
                                pageIndex: currentPageIndex,
                                rects: entityRects,
                            },
                            pageLabel: String(currentPageIndex + 1),
                            sortIndex: `${String(currentPageIndex).padStart(5, '0')}|000000|00000`,
                            tags: [],
                        };

                        // Try Path A: annotation manager
                        if (mgr && typeof mgr.addAnnotation === 'function') {
                            const result = mgr.addAnnotation(annotation);
                            if (result !== false && result !== null) {
                                created++;
                                continue;
                            }
                        }

                        // Try Path B: saveFromJSON
                        if (attachment && typeof Zotero.Annotations?.saveFromJSON === 'function') {
                            const json = {
                                key: Zotero.DataObjectUtilities?.generateKey?.() || `ner_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                                ...annotation,
                            };
                            await Zotero.Annotations.saveFromJSON(attachment, json);
                            created++;
                        }
                    } catch (e: any) {
                        Zotero.debug(`[Zotero PDF Highlighter] Failed to create highlight for "${entity.text}": ${e?.message}`);
                    }
                }

                button.textContent = `✓ ${created} entities`;
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
}

export function uninstall(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: uninstalled");
}
