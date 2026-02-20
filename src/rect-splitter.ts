/**
 * Computes sub-rects for an entity's character range within a full text selection.
 *
 * MVP approach: proportional interpolation based on character position ratios.
 * - Single-line (1 rect): linearly interpolate x-coords by char ratio.
 * - Multi-line (N rects): distribute chars across rects by width proportion,
 *   then cut start/end rects.
 */

// ── Types ────────────────────────────────────────────────────────────

interface LineAllocation {
  rectIndex: number;
  charStart: number;  // inclusive char offset for this line
  charEnd: number;    // exclusive char offset for this line
  rect: number[];     // [x1, y1, x2, y2]
}

// ── Helpers ──────────────────────────────────────────────────────────

function clampRect(rect: number[]): number[] {
  const [x1, y1, x2, y2] = rect;
  // Ensure x1 <= x2 (degenerate rects from rounding)
  if (x1 > x2) return [x2, y1, x1, y2];
  return [x1, y1, x2, y2];
}

function allocateCharsToLines(fullText: string, fullRects: number[][]): LineAllocation[] {
  if (fullRects.length === 0) return [];

  const totalChars = fullText.length;
  if (totalChars === 0) return [];

  // Compute width of each rect
  const widths = fullRects.map(r => Math.abs(r[2] - r[0]));
  const totalWidth = widths.reduce((sum, w) => sum + w, 0);

  // Guard: zero total width — distribute evenly
  if (totalWidth <= 0) {
    const charsPerLine = Math.ceil(totalChars / fullRects.length);
    return fullRects.map((rect, i) => ({
      rectIndex: i,
      charStart: i * charsPerLine,
      charEnd: Math.min((i + 1) * charsPerLine, totalChars),
      rect,
    }));
  }

  // Distribute chars proportionally to rect width
  const allocations: LineAllocation[] = [];
  let charCursor = 0;

  for (let i = 0; i < fullRects.length; i++) {
    const proportion = widths[i] / totalWidth;
    const isLastLine = i === fullRects.length - 1;
    const charsForLine = isLastLine
      ? totalChars - charCursor
      : Math.round(proportion * totalChars);

    const charEnd = Math.min(charCursor + charsForLine, totalChars);

    allocations.push({
      rectIndex: i,
      charStart: charCursor,
      charEnd,
      rect: fullRects[i],
    });

    charCursor = charEnd;
  }

  return allocations;
}

function interpolateXInRect(
  rect: number[],
  lineCharStart: number,
  lineCharEnd: number,
  targetCharStart: number,
  targetCharEnd: number
): number[] {
  const [x1, y1, x2, y2] = rect;
  const lineLen = lineCharEnd - lineCharStart;

  if (lineLen <= 0) return [x1, y1, x2, y2];

  const startRatio = (targetCharStart - lineCharStart) / lineLen;
  const endRatio = (targetCharEnd - lineCharStart) / lineLen;

  const rectWidth = x2 - x1;
  const newX1 = x1 + startRatio * rectWidth;
  const newX2 = x1 + endRatio * rectWidth;

  return clampRect([newX1, y1, newX2, y2]);
}

// ── Public API ───────────────────────────────────────────────────────

export function computeEntityRects(
  fullText: string,
  fullRects: number[][],
  entityStart: number,
  entityEnd: number
): number[][] {
  // Guard: invalid inputs
  if (fullRects.length === 0) return [];
  if (entityStart < 0 || entityEnd <= entityStart || entityStart >= fullText.length) return [];

  // Clamp entity range to text bounds
  const clampedEnd = Math.min(entityEnd, fullText.length);

  // Fast path: single rect
  if (fullRects.length === 1) {
    return [interpolateXInRect(fullRects[0], 0, fullText.length, entityStart, clampedEnd)];
  }

  // Multi-rect: allocate chars to lines, find overlapping rects
  const lines = allocateCharsToLines(fullText, fullRects);
  const entityRects: number[][] = [];

  for (const line of lines) {
    // Skip lines with no overlap
    if (line.charEnd <= entityStart || line.charStart >= clampedEnd) continue;

    // Compute the overlap range within this line
    const overlapStart = Math.max(entityStart, line.charStart);
    const overlapEnd = Math.min(clampedEnd, line.charEnd);

    // Does the entity span the entire line?
    const spansEntireLine = overlapStart === line.charStart && overlapEnd === line.charEnd;
    if (spansEntireLine) {
      entityRects.push(line.rect);
      continue;
    }

    // Partial line — interpolate x coordinates
    entityRects.push(interpolateXInRect(line.rect, line.charStart, line.charEnd, overlapStart, overlapEnd));
  }

  return entityRects;
}
