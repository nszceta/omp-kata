/** Narrows an unknown value to a plain object, or undefined. */
export function asObject(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Parses JSON text; undefined for malformed JSON or a non-object top level. */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
	try {
		return asObject(JSON.parse(text));
	} catch {
		return undefined;
	}
}
