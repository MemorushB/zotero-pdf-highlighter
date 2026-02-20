var chromeHandle;

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  // Register chrome so preferences.xhtml can be found
  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "zotero-pdf-highlighter", rootURI + "content/"],
  ]);

  // Load the main plugin script
  var ctx = {};
  Services.scriptloader.loadSubScript(
    rootURI + "content/scripts/zotero-pdf-highlighter.js",
    ctx
  );

  // Call plugin startup
  if (ctx.startup) {
    await ctx.startup({ id, version, resourceURI, rootURI }, reason);
  }

  // Store reference for shutdown
  Zotero._zoteroPdfHighlighter = ctx;
}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) return;
  if (Zotero._zoteroPdfHighlighter && Zotero._zoteroPdfHighlighter.shutdown) {
    Zotero._zoteroPdfHighlighter.shutdown(
      { id, version, resourceURI, rootURI },
      reason
    );
  }
  Zotero._zoteroPdfHighlighter = null;
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall(data, reason) {}
