import { HardwoodError } from "./errors.js";

// Keys that must never appear in audit payloads, step data or anything a model sees.
const FORBIDDEN_KEY =
  /^(password|passwd|secret|token|api[-_]?key|cvv|cvc|clabe|card[-_]?number|pan|pin)$/i;

/**
 * Throws if `value` carries a field that looks like a secret. Key-based on purpose:
 * account references (número de servicio, cuenta) are long digit strings and must
 * not trip a pattern check.
 */
export function assertNoSecrets(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(k)) {
        throw new HardwoodError(
          "secret_detected",
          `refusing to store secret-like field ${path}.${k}`,
        );
      }
      assertNoSecrets(v, `${path}.${k}`);
    }
  }
}
