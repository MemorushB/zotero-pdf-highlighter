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

export function install(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: installed");
}

export function startup(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: startup");
    
    // Register the event listener according to the Zotero 8 Plugin Development Guide gist.
    // This replaces the old renderToolbar / PDFViewerApplication hack.
    Zotero.Reader.registerEventListener(eventType, textSelectionHandler, pluginID);
}

export function shutdown(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: shutdown");
    
    // Unregister manually as shown in the gist
    Zotero.Reader.unregisterEventListener(eventType, textSelectionHandler);
}

export function uninstall(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: uninstalled");
}
