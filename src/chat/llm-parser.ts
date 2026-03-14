/**
 * LLM-based task parser.
 *
 * This module is reserved for future implementation where an LLM
 * handles ambiguous task scheduling requests that the regex parser
 * in parsers.ts cannot handle.
 *
 * Currently disabled — returns null for all inputs.
 * The regex parser covers most common patterns.
 */

export interface ParsedTask {
  name: string;
  message: string;
  schedule?: string;
  executeAfter?: number;
  type: "once" | "recurring" | null;
}

/**
 * Attempt to parse a task scheduling request using an LLM.
 * Currently a no-op stub; returns null.
 *
 * TODO: Wire in LLM call when regex parser coverage proves insufficient.
 */
export async function parseTaskWithLLM(
  _message: string,
): Promise<ParsedTask | null> {
  // Intentionally disabled — regex parser handles common patterns.
  // Uncomment and implement when LLM-based parsing is needed:
  //
  // const response = await llm.generateObject(prompt, schema);
  // return response;
  return null;
}
