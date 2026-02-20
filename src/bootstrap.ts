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
    const payload = { type: 'highlight', color: HIGHLIGHT_COLOR };

    const candidates: Array<{ owner: any; ownerLayer: 'event' | 'reader' | 'internalReader'; method: string; argsList: any[][] }> = [
        { owner: event, ownerLayer: 'event', method: 'createAnnotationFromSelection', argsList: [[payload], []] },
        { owner: reader, ownerLayer: 'reader', method: 'createAnnotationFromSelection', argsList: [[payload], []] },
        { owner: reader?._internalReader, ownerLayer: 'internalReader', method: 'createAnnotationFromSelection', argsList: [[payload], []] },
        { owner: reader?._internalReader, ownerLayer: 'internalReader', method: 'onAddAnnotation', argsList: [[payload]] },
        { owner: reader?._internalReader, ownerLayer: 'internalReader', method: '_onAddAnnotation', argsList: [[payload]] },
        { owner: reader, ownerLayer: 'reader', method: '_createAnnotation', argsList: [[payload]] },
        { owner: reader, ownerLayer: 'reader', method: 'createAnnotation', argsList: [[payload]] },
        { owner: reader?._internalReader, ownerLayer: 'internalReader', method: '_createAnnotation', argsList: [[payload]] },
        { owner: reader?._internalReader, ownerLayer: 'internalReader', method: 'createAnnotation', argsList: [[payload]] }
    ];

    for (const candidate of candidates) {
        const fn = candidate.owner?.[candidate.method];
        if (typeof fn !== 'function') {
            continue;
        }

        for (const args of candidate.argsList) {
            const argLabel = args.length === 0 ? 'no args' : 'payload';
            Zotero.debug(`[Zotero PDF Highlighter] trying method=${candidate.method} owner=${candidate.ownerLayer} args=${argLabel}`);

            try {
                let result = fn.apply(candidate.owner, args);
                if (result && typeof result.then === 'function') {
                    result = await result;
                }
                Zotero.debug(`[Zotero PDF Highlighter] result method=${candidate.method} owner=${candidate.ownerLayer} value=${summarizeResult(result)}`);

                if (result === false) {
                    Zotero.debug(`[Zotero PDF Highlighter] method=${candidate.method} owner=${candidate.ownerLayer} returned explicit false; trying next fallback`);
                    continue;
                }

                Zotero.debug(`[Zotero PDF Highlighter] highlight created via method=${candidate.method} owner=${candidate.ownerLayer}`);
                return true;
            } catch (error: any) {
                Zotero.debug(`[Zotero PDF Highlighter] failed method=${candidate.method} owner=${candidate.ownerLayer} error=${error?.message || error}`);
            }
        }
    }

    Zotero.debug('[Zotero PDF Highlighter] failed to create highlight: no compatible method succeeded');
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
