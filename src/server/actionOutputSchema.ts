/**
 * Provider output-schema dialects require a root object with properties.
 * Keep the exact discriminated schema in the observation/prompt, but flatten
 * its envelope for the CLI structural guard. The game remains authoritative
 * for type/payload pairing and legal actions; this never repairs a response.
 */
export function actionOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(schema.oneOf)) return schema;
  const variants = schema.oneOf as Array<{ properties: { type: { const: string }; payload: Record<string, unknown> } }>;
  return {
    type: "object", additionalProperties: false, required: ["type", "payload"],
    properties: {
      type: { type: "string", enum: variants.map((variant) => variant.properties.type.const) },
      payload: { anyOf: variants.map((variant) => variant.properties.payload) },
    },
  };
}
