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
