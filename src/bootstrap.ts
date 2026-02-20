declare const Zotero: any;

export interface BootstrapData {
    id: string;
    version: string;
    resourceURI: string;
    rootURI: string;
}

let readerEventListenerId: any;
const HIGHLIGHT_COLOR = '#ffd400';
const HIGHLIGHT_FAILURE_MESSAGE = 'Could not create a highlight from this selection.';

function showInlineFailureHint(button: any, event: any): void {
    const originalText = button?.textContent || 'Create Highlight';
    button.textContent = 'Highlight Failed';
    button.disabled = true;

    const timerHost = event?.doc?.defaultView;
    if (timerHost && typeof timerHost.setTimeout === 'function') {
        timerHost.setTimeout(() => {
            button.textContent = originalText;
            button.disabled = false;
        }, 1500);
        return;
    }

    button.textContent = originalText;
    button.disabled = false;
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
    showInlineFailureHint(button, event);
    return 'inline-hint';
}

function summarizeResult(result: any): string {
    const MAX_STRING_PREVIEW = 80;

    if (result === null) {
        return 'null';
    }
    if (result === undefined) {
        return 'undefined';
    }

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
    if (Array.isArray(result)) {
        return `array(len=${result.length})`;
    }

    if (resultType === 'object') {
        const keyCount = Object.keys(result).length;
        return `object(type=${ctorName}, keys=${keyCount})`;
    }

    if (ctorName && ctorName !== 'Object') {
        return `object(${ctorName})`;
    }

    return `type(${resultType})`;
}

async function createSelectionHighlight(event: any): Promise<boolean> {
    const reader = event?.reader;
    const base = event?.params?.annotation;

    // Diagnostic: dump available keys for debugging
    Zotero.debug(`[Zotero PDF Highlighter] event keys: ${Object.keys(event || {}).join(', ')}`);
    Zotero.debug(`[Zotero PDF Highlighter] event.params keys: ${Object.keys(event?.params || {}).join(', ')}`);
    if (base) {
        Zotero.debug(`[Zotero PDF Highlighter] annotation base keys: ${Object.keys(base).join(', ')}`);
    }
    Zotero.debug(`[Zotero PDF Highlighter] reader keys: ${Object.keys(reader || {}).join(', ')}`);

    // Guard: selection geometry data is required
    if (!base || !base.position) {
        Zotero.debug('[Zotero PDF Highlighter] no selection annotation data in event.params.annotation');
        return false;
    }

    // Build full annotation payload by merging selection data with highlight config
    const fullAnnotation = {
        ...base,
        type: 'highlight',
        color: HIGHLIGHT_COLOR,
    };

    Zotero.debug(
        `[Zotero PDF Highlighter] fullAnnotation type=${fullAnnotation.type} color=${fullAnnotation.color} ` +
        `hasPosition=${!!fullAnnotation.position} text=${(fullAnnotation.text || '').substring(0, 60)}`
    );

    // Path A: Internal annotation manager (fast path, used by Zotero internally)
    try {
        const internal = reader?._internalReader;
        const mgr = internal?._annotationManager ?? internal?.annotationManager;
        if (mgr && typeof mgr.addAnnotation === 'function') {
            Zotero.debug('[Zotero PDF Highlighter] trying Path A: _annotationManager.addAnnotation');
            let result = mgr.addAnnotation(fullAnnotation);
            if (result && typeof result.then === 'function') {
                result = await result;
            }
            Zotero.debug(`[Zotero PDF Highlighter] Path A result: ${summarizeResult(result)}`);
            if (result !== false && result !== null) {
                Zotero.debug('[Zotero PDF Highlighter] Path A succeeded');
                return true;
            }
        } else {
            Zotero.debug(`[Zotero PDF Highlighter] Path A unavailable: mgr=${!!mgr}, addAnnotation=${typeof mgr?.addAnnotation}`);
        }
    } catch (error: any) {
        Zotero.debug(`[Zotero PDF Highlighter] Path A failed: ${error?.message || error}`);
    }

    // Path B: Data-layer fallback via Zotero.Annotations.saveFromJSON
    try {
        const attachment = reader?._item || (reader?.itemID ? Zotero.Items?.get(reader.itemID) : null);
        if (attachment && typeof Zotero.Annotations?.saveFromJSON === 'function') {
            Zotero.debug('[Zotero PDF Highlighter] trying Path B: Zotero.Annotations.saveFromJSON');
            const json = {
                key: Zotero.DataObjectUtilities?.generateKey?.() || Zotero.Utilities?.generateObjectKey?.() || `highlight_${Date.now()}`,
                ...fullAnnotation,
                comment: fullAnnotation.comment || '',
                tags: fullAnnotation.tags || [],
            };
            let result = Zotero.Annotations.saveFromJSON(attachment, json);
            if (result && typeof result.then === 'function') {
                result = await result;
            }
            Zotero.debug(`[Zotero PDF Highlighter] Path B result: ${summarizeResult(result)}`);
            Zotero.debug('[Zotero PDF Highlighter] Path B succeeded');
            return true;
        } else {
            Zotero.debug(`[Zotero PDF Highlighter] Path B unavailable: attachment=${!!attachment}, saveFromJSON=${typeof Zotero.Annotations?.saveFromJSON}`);
        }
    } catch (error: any) {
        Zotero.debug(`[Zotero PDF Highlighter] Path B failed: ${error?.message || error}`);
    }

    // Path C: Last resort - try _onSetAnnotation if available
    try {
        const internal = reader?._internalReader;
        if (internal && typeof internal._onSetAnnotation === 'function') {
            Zotero.debug('[Zotero PDF Highlighter] trying Path C: _onSetAnnotation');
            let result = internal._onSetAnnotation(fullAnnotation);
            if (result && typeof result.then === 'function') {
                result = await result;
            }
            if (result !== false) {
                Zotero.debug('[Zotero PDF Highlighter] Path C succeeded');
                return true;
            }
        }
    } catch (error: any) {
        Zotero.debug(`[Zotero PDF Highlighter] Path C failed: ${error?.message || error}`);
    }

    Zotero.debug('[Zotero PDF Highlighter] all paths failed');
    return false;
}

export function install(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: installed");
}

export function startup(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: startup");
    
    readerEventListenerId = Zotero.Reader.registerEventListener('renderTextSelectionPopup', (event: any) => {
        const { append, doc } = event;
        const button = doc.createElement('button');
        button.textContent = 'Create Highlight';
        button.style.backgroundColor = '#1e1e1e';
        button.style.color = '#d4d4d4';
        button.style.border = '1px solid #333';
        button.style.borderRadius = '3px';
        button.style.padding = '2px 5px';
        button.style.cursor = 'pointer';
        
        button.onclick = async () => {
            const created = await createSelectionHighlight(event);
            if (!created) {
                const feedbackMethod = notifyHighlightFailure(event, button);
                Zotero.debug(`[Zotero PDF Highlighter] highlight not created (feedback=${feedbackMethod})`);
            }
        };
        
        append(button);
    }, 'zotero-pdf-highlighter');
}

export function shutdown(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: shutdown");
    
    if (readerEventListenerId) {
        Zotero.Reader.unregisterEventListener('renderTextSelectionPopup', readerEventListenerId);
    }
}

export function uninstall(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: uninstalled");
}
