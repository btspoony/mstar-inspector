/**
 * The per-declaration model-id ceiling — ONE literal, because three faces must
 * agree on it (I-000483 / I-000484): the store's declaration gate, the
 * settings route's 400 and the SPA's model picker. The SPA used to hand-copy
 * the number; changing this constant now changes all three.
 *
 * Zero dependencies by design: the dashboard leaf boundary (AL-22-1) forbids
 * importing the store/pipeline/review layers, and the SPA bundle may only take
 * a pure constant from a contracts leaf.
 */
export const MAX_CUSTOM_PROVIDER_MODEL_IDS = 128;

/** One model's size facts, from whichever side states them. */
export type ModelSize = {
  contextWindow?: number;
  maxTokens?: number;
};

/** Which side supplied the numbers — a UI label, never a runtime decision. */
export type ModelSizeSource = "declared" | "catalog" | "absent";

/**
 * Resolve one model's sizes: the operator's statement wins per field, the
 * catalog fills what they left blank. A field present on neither side stays
 * absent — never invented. `source` names where the shown numbers came from
 * so the UI can say it; the consumer of the numbers does not branch on it.
 */
export function resolveModelSize(
  declared: ModelSize | undefined,
  catalog: ModelSize | undefined,
): ModelSize & { source: ModelSizeSource } {
  const contextWindow = declared?.contextWindow ?? catalog?.contextWindow;
  const maxTokens = declared?.maxTokens ?? catalog?.maxTokens;
  const filledByCatalog =
    (contextWindow !== undefined && declared?.contextWindow === undefined) ||
    (maxTokens !== undefined && declared?.maxTokens === undefined);
  return {
    contextWindow,
    maxTokens,
    source:
      contextWindow === undefined && maxTokens === undefined
        ? "absent"
        : filledByCatalog
          ? "catalog"
          : "declared",
  };
}
