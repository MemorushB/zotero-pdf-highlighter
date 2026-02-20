declare const Zotero: any;

export interface BootstrapData {
    id: string;
    version: string;
    resourceURI: string;
    rootURI: string;
}

let readerEventListenerId: any;
const HIGHLIGHT_COLOR = '#ffd400';

async function createSelectionHighlight(event: any): Promise<boolean> {
    const reader = event?.reader;
    const annotation = { type: 'highlight', color: HIGHLIGHT_COLOR };

    const candidates: Array<{ owner: any; method: string; argsList: any[][] }> = [
        { owner: event, method: 'createAnnotationFromSelection', argsList: [[annotation], []] },
        { owner: reader, method: 'createAnnotationFromSelection', argsList: [[annotation], []] },
        { owner: reader, method: '_createAnnotation', argsList: [[annotation]] },
        { owner: reader, method: 'createAnnotation', argsList: [[annotation]] },
        { owner: reader?._internalReader, method: 'createAnnotationFromSelection', argsList: [[annotation], []] },
        { owner: reader?._internalReader, method: '_createAnnotation', argsList: [[annotation]] }
    ];

    for (const candidate of candidates) {
        const fn = candidate.owner?.[candidate.method];
        if (typeof fn !== 'function') {
            continue;
        }

        for (const args of candidate.argsList) {
            const argLabel = args.length === 0 ? 'no args' : 'annotation args';
            Zotero.debug(`[Zotero PDF Highlighter] trying ${candidate.method} (${argLabel})`);

            try {
                const result = fn.apply(candidate.owner, args);
                if (result && typeof result.then === 'function') {
                    await result;
                }
                Zotero.debug(`[Zotero PDF Highlighter] highlight created via ${candidate.method}`);
                return true;
            } catch (error: any) {
                Zotero.debug(`[Zotero PDF Highlighter] ${candidate.method} failed: ${error?.message || error}`);
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
        button.textContent = 'VS Code Highlight';
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
