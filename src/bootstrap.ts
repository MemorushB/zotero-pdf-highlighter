declare const Zotero: any;

let readerEventListenerId: string;

function handleReaderEvent(event: string, data: any) {
    if (event === 'render') {
        const reader = data.reader;
        const iframeWindow = reader._iframeWindow;
        if (iframeWindow) {
            iframeWindow.addEventListener('textlayerrendered', (e: any) => {
                Zotero.debug("[Zotero PDF Highlighter] Text layer rendered for page " + e.detail.pageNumber);
                // We will do the highlighting here in Phase 3
            });
        }
    }
}

export interface BootstrapData {
    id: string;
    version: string;
    resourceURI: string;
    rootURI: string;
}

export function install(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: installed");
}

export function startup(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: startup");
    readerEventListenerId = Zotero.Reader.registerEventListener('render', handleReaderEvent);
}

export function shutdown(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: shutdown");
    if (readerEventListenerId) {
        Zotero.Reader.unregisterEventListener(readerEventListenerId);
    }
}

export function uninstall(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: uninstalled");
}
