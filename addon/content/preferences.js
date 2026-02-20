// Preference binding for PDF Highlighter settings panel
var PDFHighlighterPrefs = {
  PREF_PREFIX: "extensions.zotero-pdf-highlighter.",

  inputs: {
    "pref-apiKey": "apiKey",
    "pref-baseURL": "baseURL",
    "pref-model": "model"
  },

  // Load values from preferences into input fields
  load: function() {
    Zotero.debug("[PDF Highlighter Prefs] load() called");
    for (const inputId in this.inputs) {
      if (!this.inputs.hasOwnProperty(inputId)) continue;
      const prefKey = this.inputs[inputId];
      const input = document.getElementById(inputId);
      Zotero.debug("[PDF Highlighter Prefs] Looking for input: " + inputId + " -> found: " + !!input);
      if (input) {
        const fullKey = this.PREF_PREFIX + prefKey;
        const value = Zotero.Prefs.get(fullKey);
        Zotero.debug("[PDF Highlighter Prefs] Pref " + fullKey + " = " + (value ? value.substring(0, 4) + "..." : "(empty)"));
        input.value = value ?? "";
      }
    }
  },

  // Save input value to preferences
  save: function(inputId) {
    const prefKey = this.inputs[inputId];
    if (!prefKey) return;
    const input = document.getElementById(inputId);
    if (input) {
      const fullKey = this.PREF_PREFIX + prefKey;
      const value = input.value;
      Zotero.debug("[PDF Highlighter Prefs] Saving " + fullKey + " = " + (value ? value.substring(0, 4) + "..." : "(empty)"));
      Zotero.Prefs.set(fullKey, value);
    }
  },

  // Setup event handlers for saving on change/blur
  setupSaveHandlers: function() {
    Zotero.debug("[PDF Highlighter Prefs] setupSaveHandlers() called");
    for (const inputId in this.inputs) {
      if (!this.inputs.hasOwnProperty(inputId)) continue;
      const input = document.getElementById(inputId);
      if (input) {
        const self = this;
        input.addEventListener("change", function() {
          Zotero.debug("[PDF Highlighter Prefs] change event on " + inputId);
          self.save(inputId);
        });
        input.addEventListener("blur", function() {
          Zotero.debug("[PDF Highlighter Prefs] blur event on " + inputId);
          self.save(inputId);
        });
        // Also add input event for immediate feedback
        input.addEventListener("input", function() {
          // Don't log every keystroke, but save on input
        });
      }
    }
  },

  init: function() {
    Zotero.debug("[PDF Highlighter Prefs] init() called - document.readyState: " + document.readyState);
    this.load();
    this.setupSaveHandlers();
    Zotero.debug("[PDF Highlighter Prefs] init() complete");
  }
};

// Initialize
Zotero.debug("[PDF Highlighter Prefs] Script loaded, waiting for DOM...");
if (document.readyState === "complete" || document.readyState === "interactive") {
  Zotero.debug("[PDF Highlighter Prefs] DOM already ready");
  PDFHighlighterPrefs.init();
} else {
  document.addEventListener("DOMContentLoaded", function() {
    Zotero.debug("[PDF Highlighter Prefs] DOMContentLoaded fired");
    PDFHighlighterPrefs.init();
  });
}
