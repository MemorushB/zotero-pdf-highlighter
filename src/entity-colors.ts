/**
 * Maps NER entity types to Zotero's native annotation colors.
 * All 8 colors are from Zotero's built-in palette.
 */

export const ENTITY_COLORS: Record<string, string> = {
  METHOD:      "#2ea8e5",  // blue
  DATASET:     "#f19837",  // orange
  METRIC:      "#ff6666",  // red
  TASK:        "#5fb236",  // green
  PERSON:      "#ffd400",  // yellow
  MATERIAL:    "#e56eee",  // magenta
  INSTITUTION: "#a28ae5",  // purple
  TERM:        "#aaaaaa",  // gray
};

const FALLBACK_COLOR = "#ffd400"; // yellow

export function colorForEntityType(entityType: string): string {
  return ENTITY_COLORS[entityType.toUpperCase()] ?? FALLBACK_COLOR;
}
