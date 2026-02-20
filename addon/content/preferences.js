// Preference binding for PDF Highlighter settings panel
(function() {
  const PREF_PREFIX = "extensions.zotero-pdf-highlighter.";
  
  const inputs = {
    "pref-apiKey": "apiKey",
    "pref-baseURL": "baseURL",
    "pref-model": "model"
  };
  
  // Load values from preferences
  function load() {
    for (const [inputId, prefKey] of Object.entries(inputs)) {
      const input = document.getElementById(inputId);
      if (input) {
        const value = Zotero.Prefs.get(PREF_PREFIX + prefKey);
        input.value = value ?? "";
      }
    }
  }
  
  // Save value on change
  function setupSaveHandlers() {
    for (const [inputId, prefKey] of Object.entries(inputs)) {
      const input = document.getElementById(inputId);
      if (input) {
        input.addEventListener("change", () => {
          Zotero.Prefs.set(PREF_PREFIX + prefKey, input.value);
        });
        // Also save on blur for better UX
        input.addEventListener("blur", () => {
          Zotero.Prefs.set(PREF_PREFIX + prefKey, input.value);
        });
      }
    }
  }
  
  // Initialize when DOM ready
  if (document.readyState === "complete") {
    load();
    setupSaveHandlers();
  } else {
    window.addEventListener("load", () => {
      load();
      setupSaveHandlers();
    });
  }
})();
