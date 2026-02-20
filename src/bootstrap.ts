declare const Zotero: any;

export interface BootstrapData {
    id: string;
    version: string;
    resourceURI: string;
    rootURI: string;
}

let readerEventListenerId: any;

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
        
        button.onclick = () => {
            // We can't easily change the DOM without breaking Zotero's selection logic, 
            // so we use Zotero's official API to create a highlight annotation.
            const color = '#c678dd'; // VS Code purple
            Zotero.debug('[Zotero PDF Highlighter] creating official annotation for selection');
            event.reader.createAnnotationFromSelection({
                type: 'highlight',
                color: color
            });
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