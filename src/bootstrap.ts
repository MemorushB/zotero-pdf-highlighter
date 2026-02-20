declare const Zotero: any;

export function install() {
    Zotero.debug("Zotero PDF Highlighter: installed");
}

export function startup({ id, version, rootURI }: { id: string, version: string, rootURI: string }) {
    Zotero.debug("Zotero PDF Highlighter: startup");
}

export function shutdown() {
    Zotero.debug("Zotero PDF Highlighter: shutdown");
}

export function uninstall() {
    Zotero.debug("Zotero PDF Highlighter: uninstalled");
}