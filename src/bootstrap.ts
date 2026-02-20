declare const Zotero: any;

export interface BootstrapData {
    id: string;
    version: string;
    resourceURI: string;
    rootURI: string;
}

let readerEventListenerId: any;
const HIGHLIGHT_COLOR = '#ffd400';

function summarizeResult(result: any): string {
    if (result === null) {
        return 'null';
    }
    if (result === undefined) {
        return 'undefined';
    }

    const resultType = typeof result;
    if (resultType === 'string') {
        return `string(${JSON.stringify(result)})`;
    }
    if (resultType === 'number' || resultType === 'boolean' || resultType === 'bigint') {
        return `${resultType}(${String(result)})`;
    }
    if (resultType === 'function') {
        return `function(${result.name || 'anonymous'})`;
    }

    const ctorName = result?.constructor?.name;
    if (ctorName && ctorName !== 'Object') {
        return `object(${ctorName})`;
    }

    try {
        return `object(${JSON.stringify(result)})`;
    } catch {
        return 'object([unserializable])';
    }
}

async function createSelectionHighlight(event: any): Promise<boolean> {
    const reader = event?.reader;
    const payload = { type: 'highlight', color: HIGHLIGHT_COLOR };

    const candidates: Array<{ owner: any; ownerLayer: 'event' | 'reader' | 'internalReader'; method: string; argsList: any[][] }> = [
        { owner: event, ownerLayer: 'event', method: 'createAnnotationFromSelection', argsList: [[payload], []] },
        { owner: reader, ownerLayer: 'reader', method: 'createAnnotationFromSelection', argsList: [[payload], []] },
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
            Zotero.debug('[Zotero PDF Highlighter] create highlight from selection');
            await createSelectionHighlight(event);
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
