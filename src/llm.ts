/**
 * LLM API client for NER extraction.
 * Uses Zotero.HTTP.request() to bypass CookieSandbox header stripping.
 * Settings read from Zotero.Prefs at call time.
 */

declare const Zotero: any;

// ── Types ────────────────────────────────────────────────────────────

export interface NerEntity {
  text: string;
  type: string;
  start: number; // 0-based char offset
  end: number;   // exclusive
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LlmErrorClassification {
  kind: "rate_limit" | "server_error" | "client_error";
  retryable: boolean;
}

// ── Constants ────────────────────────────────────────────────────────

const PREF_PREFIX = "extensions.zotero-pdf-highlighter.";
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

const NER_SYSTEM_PROMPT = `You are an academic named-entity recognition (NER) engine.

Given a text passage, extract all named entities and return ONLY a JSON object (no markdown, no explanation) in this exact format:
{"entities":[{"text":"exact text","type":"TYPE","start":0,"end":5}]}

Entity types:
1. METHOD — algorithms, models, architectures, techniques (e.g., "BERT", "gradient descent")
2. DATASET — named datasets, benchmarks (e.g., "ImageNet", "GLUE")
3. METRIC — evaluation measures, scores (e.g., "F1 score", "accuracy", "95%")
4. TASK — research problems, objectives (e.g., "object detection", "NER")
5. PERSON — researchers, authors (e.g., "Vaswani", "Hinton")
6. MATERIAL — chemicals, genes, proteins, substances (e.g., "dopamine", "graphene")
7. INSTITUTION — organizations, universities, companies (e.g., "MIT", "Google")
8. TERM — key technical terms, theories, concepts (e.g., "attention mechanism", "overfitting")

Rules:
- "start" is the 0-based character offset where the entity begins in the input text.
- "end" is the exclusive character offset (start + length of entity text).
- "text" must be the exact substring from the input at [start, end).
- Return ONLY valid JSON. No markdown code fences, no commentary.
- If no entities found, return {"entities":[]}.`;

// ── Preference helpers ───────────────────────────────────────────────

function getPref(key: string): string {
  return String(Zotero.Prefs.get(PREF_PREFIX + key) ?? "");
}

// ── Error classification ─────────────────────────────────────────────

function classifyHttpError(status: number): LlmErrorClassification {
  if (status === 429) return { kind: "rate_limit", retryable: true };
  if (status >= 500)  return { kind: "server_error", retryable: true };
  return { kind: "client_error", retryable: false };
}

// ── JSON extraction ──────────────────────────────────────────────────

function extractJsonFromResponse(raw: string): string {
  // Try raw parse first
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fencePattern = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/;
  const fenceMatch = fencePattern.exec(trimmed);
  if (fenceMatch) return fenceMatch[1].trim();

  // Last resort: find first { ... last }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

// ── Offset validation & repair ───────────────────────────────────────

function validateAndRepairEntities(entities: NerEntity[], sourceText: string): NerEntity[] {
  const validated: NerEntity[] = [];

  for (const entity of entities) {
    if (!entity.text || !entity.type || typeof entity.start !== "number" || typeof entity.end !== "number") {
      continue;
    }

    const normalizedType = entity.type.toUpperCase();
    const entityLen = entity.text.length;

    // Strategy 1: exact match at declared offsets
    const sliceAtOffset = sourceText.slice(entity.start, entity.end);
    if (sliceAtOffset === entity.text) {
      validated.push({ text: entity.text, type: normalizedType, start: entity.start, end: entity.end });
      continue;
    }

    // Strategy 2: search nearby (±30 chars) for exact substring
    const searchStart = Math.max(0, entity.start - 30);
    const searchEnd = Math.min(sourceText.length, entity.end + 30);
    const nearbyWindow = sourceText.slice(searchStart, searchEnd);
    const nearbyIdx = nearbyWindow.indexOf(entity.text);
    if (nearbyIdx !== -1) {
      const repairedStart = searchStart + nearbyIdx;
      validated.push({ text: entity.text, type: normalizedType, start: repairedStart, end: repairedStart + entityLen });
      continue;
    }

    // Strategy 3: global search for first occurrence
    const globalIdx = sourceText.indexOf(entity.text);
    if (globalIdx !== -1) {
      validated.push({ text: entity.text, type: normalizedType, start: globalIdx, end: globalIdx + entityLen });
      continue;
    }

    // Discard: entity text not found in source
    Zotero.debug(`[NER] discarding entity "${entity.text}" — not found in source text`);
  }

  return validated;
}

// ── Core API call with retry ─────────────────────────────────────────

async function chatCompletion(messages: ChatMessage[]): Promise<string> {
  const apiKey = getPref("apiKey");
  const baseURL = getPref("baseURL") || "https://openrouter.ai/api/v1";
  const model = getPref("model") || "z-ai/glm-4.5-air:free";

  const url = `${baseURL.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const body = JSON.stringify({
    model,
    messages,
    temperature: 0,
  });

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Use Zotero.HTTP.request to bypass CookieSandbox which strips
      // Authorization headers from regular fetch() calls.
      const xhr = await Zotero.HTTP.request("POST", url, {
        headers,
        body,
        responseType: "text",
        timeout: REQUEST_TIMEOUT_MS,
        successCodes: false, // Handle non-2xx responses manually
      });

      const status = xhr.status;
      const responseText = xhr.responseText;

      if (status < 200 || status >= 300) {
        const errClassification = classifyHttpError(status);
        lastError = new Error(`LLM API ${status}: ${responseText.slice(0, 200)}`);
        Zotero.debug(`[NER] attempt ${attempt + 1}/${MAX_RETRIES} failed: ${lastError.message} (${errClassification.kind})`);

        if (!errClassification.retryable) throw lastError;

        // Exponential backoff with jitter before retry
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 500;
        await new Promise(resolve => setTimeout(resolve, backoff));
        continue;
      }

      const json = JSON.parse(responseText);
      const content: string = json?.choices?.[0]?.message?.content ?? "";
      if (!content) throw new Error("LLM returned empty content");
      return content;

    } catch (err: any) {
      if (!lastError || lastError.message !== err.message) {
        lastError = err;
        Zotero.debug(`[NER] attempt ${attempt + 1}/${MAX_RETRIES}: ${err.message}`);
      }

      // Backoff before retry (unless it's a non-retryable error we already threw)
      if (attempt < MAX_RETRIES - 1) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 500;
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }
  }

  throw lastError ?? new Error("LLM API failed after all retries");
}

// ── Public API ───────────────────────────────────────────────────────

export async function extractEntities(text: string): Promise<NerEntity[]> {
  if (!text.trim()) return [];

  const rawResponse = await chatCompletion([
    { role: "system", content: NER_SYSTEM_PROMPT },
    { role: "user", content: text },
  ]);

  Zotero.debug(`[NER] raw LLM response (${rawResponse.length} chars): ${rawResponse.slice(0, 300)}`);

  const jsonStr = extractJsonFromResponse(rawResponse);
  let parsed: { entities?: NerEntity[] };
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Failed to parse LLM JSON response: ${jsonStr.slice(0, 200)}`);
  }

  const rawEntities = parsed.entities;
  if (!Array.isArray(rawEntities)) {
    throw new Error(`LLM response missing "entities" array`);
  }

  const validated = validateAndRepairEntities(rawEntities, text);
  Zotero.debug(`[NER] extracted ${validated.length} valid entities from ${rawEntities.length} raw`);
  return validated;
}
