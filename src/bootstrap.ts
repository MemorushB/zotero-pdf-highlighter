declare const Zotero: any;

let readerEventListenerId: string;

async function attachToReader(reader: any) {
    await reader._initPromise; // Wait for the reader iframe to be fully initialized
    const win = reader._iframeWindow;
    if (win && win.PDFViewerApplication) {
        await win.PDFViewerApplication.initializedPromise;
        if (win.PDFViewerApplication.eventBus) {
            win.PDFViewerApplication.eventBus.on('textlayerrendered', (e: any) => {
                Zotero.debug("[Zotero PDF Highlighter] HELLO! Text layer rendered on page: " + e.pageNumber);
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
    
    if (Zotero.Reader && Zotero.Reader._readers) {
        for (let reader of Zotero.Reader._readers) {
            attachToReader(reader);
        }
    }

    readerEventListenerId = Zotero.Reader.registerEventListener('renderToolbar', (event: any) => {
        attachToReader(event.reader);
    }, 'zotero-pdf-highlighter');
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
