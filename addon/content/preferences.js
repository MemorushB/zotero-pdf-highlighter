// Preference binding for PDF Highlighter settings panel
// NOTE: Use 'var' for Zotero 8 compatibility - functions must be in global scope

var PDFHighlighterPrefs = {
  PREF_PREFIX: "extensions.zotero-pdf-highlighter.",

  inputs: {
    "pref-apiKey": "apiKey",
    "pref-baseURL": "baseURL",
    "pref-model": "model"
  },

  // Load values from preferences into input fields
  load: function() {
    for (var inputId in this.inputs) {
      if (!this.inputs.hasOwnProperty(inputId)) continue;
      var prefKey = this.inputs[inputId];
      var input = document.getElementById(inputId);
      if (input) {
        var value = Zotero.Prefs.get(this.PREF_PREFIX + prefKey);
        input.value = value != null ? value : "";
      }
    }
  },

  // Save value on change
  setupSaveHandlers: function() {
    var self = this;
    for (var inputId in this.inputs) {
      if (!this.inputs.hasOwnProperty(inputId)) continue;
      (function(id, prefKey) {
        var input = document.getElementById(id);
        if (input) {
          input.addEventListener("change", function() {
            Zotero.Prefs.set(self.PREF_PREFIX + prefKey, input.value);
          });
          // Also save on blur for better UX
          input.addEventListener("blur", function() {
            Zotero.Prefs.set(self.PREF_PREFIX + prefKey, input.value);
          });
        }
      })(inputId, this.inputs[inputId]);
    }
  },

  // Initialize the preference pane
  init: function() {
    this.load();
    this.setupSaveHandlers();
  }
};

// Initialize when DOM ready - Zotero 8 compatible approach
// The scripts array in PreferencePanes.register executes this when pane loads
if (document.readyState === "complete" || document.readyState === "interactive") {
  PDFHighlighterPrefs.init();
} else {
  document.addEventListener("DOMContentLoaded", function() {
    PDFHighlighterPrefs.init();
  });
}
