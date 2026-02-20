declare const Zotero: any;

export interface BootstrapData {
    id: string;
    version: string;
    resourceURI: string;
    rootURI: string;
}

const pluginID = "zotero-pdf-highlighter";
const eventType = "renderTextSelectionPopup";

const textSelectionHandler = (event: any) => {
    let { reader, doc, params, append } = event;
    let container = doc.createElement("div");
    container.append("Highlighter tool loading...");
    append(container);
    setTimeout(() => {
        const text = params.annotation ? params.annotation.text : "selected text";
        container.replaceChildren("Highlighter active for: " + text);
    }, 1000);
};

const renderToolbarHandler = (event: any) => {
    attachToReader(event.reader).catch((err: any) => Zotero.debug(`[Zotero PDF Highlighter] Error attaching to new reader: ${err}`));
};

async function attachToReader(reader: any) {
    if ((reader as any)._myPluginTextLayerRenderedAttached) return;
    (reader as any)._myPluginTextLayerRenderedAttached = true;
    
    await reader._initPromise;
    const pdfWindow = reader._iframeWindow;
    if (!pdfWindow || !pdfWindow.PDFViewerApplication) return;
    
    const eventBus = pdfWindow.PDFViewerApplication.eventBus;
    if (!eventBus) return;

    eventBus.on('textlayerrendered', (event: any) => {
        Zotero.debug("[Zotero PDF Highlighter] Text layer rendered on page: " + event.pageNumber);
        const textLayerDiv = event.source.textLayerDiv;
        if (!textLayerDiv) return;

        // Apply syntax highlighting
        const spans = textLayerDiv.querySelectorAll('span');
        spans.forEach((span: HTMLSpanElement) => {
            const text = span.textContent || '';
            // Example "VS Code" highlighting: make 'the', 'is', 'function', 'const', 'import' colored.
            if (text.includes('the ') || text.includes('a ')) {
                span.style.color = '#c678dd'; // VS Code pink/purple for keywords
                span.style.fontWeight = 'bold';
            }
        });
    });
}

export function install(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: installed");
}

export function startup(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: startup");
    
    // Register the event listener according to the Zotero 8 Plugin Development Guide gist.
    Zotero.Reader.registerEventListener(eventType, textSelectionHandler, pluginID);

    // Also register for new readers via renderToolbar
    Zotero.Reader.registerEventListener('renderToolbar', renderToolbarHandler, pluginID);

    // Loop through existing readers
    if (Zotero.Reader && Zotero.Reader._readers) {
        for (const reader of Zotero.Reader._readers) {
            attachToReader(reader).catch(err => Zotero.debug(`[Zotero PDF Highlighter] Error attaching to reader: ${err}`));
        }
    }
}

export function shutdown(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: shutdown");
    
    // Unregister manually as shown in the gist
    Zotero.Reader.unregisterEventListener(eventType, textSelectionHandler);
    Zotero.Reader.unregisterEventListener('renderToolbar', renderToolbarHandler);
}

export function uninstall(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: uninstalled");
}