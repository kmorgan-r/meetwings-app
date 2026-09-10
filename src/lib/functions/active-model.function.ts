/**
 * Naming the model behind an answer.
 *
 * Providers report the model that produced a response in its top-level
 * `model` field. Usually that is the requested id or a dated snapshot of it;
 * a router such as openrouter/free reports whichever model it picked.
 */

/**
 * Whether `answered` (the `model` a provider reported) is the requested model.
 * A dated snapshot counts as the same model (gpt-5.6-terra answers as
 * gpt-5.6-terra-2026-08-01), and so does the plain id of a variant (a ":free"
 * request answered under its base id). A router's pick does not, and with no
 * requested id (a custom provider that hardcodes its model) nothing does.
 */
export function isSameModel(requested: string, answered: string): boolean {
  if (!requested) return false;
  const [base] = requested.split(":");
  return answered.startsWith(base);
}

/** OpenRouter's routers (openrouter/free, openrouter/auto, ...) pick a model per request. */
export function isRouterModel(modelId: string): boolean {
  return modelId.startsWith("openrouter/");
}
