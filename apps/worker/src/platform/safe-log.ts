import { sanitizeDatabaseError } from "@taiwan-fin-hub/db";

/** Never serialize upstream Error objects: messages, causes and custom fields
 * can contain credentials even when they have no recognizable field name. */
export function safeLogError(error: unknown): Error {
  const sanitized = sanitizeDatabaseError(error);
  return new Error(
    sanitized !== error
      ? "Database query failed."
      : "Operation failed; upstream error details omitted.",
  );
}
