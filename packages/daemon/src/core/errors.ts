export type CoreErrorCode = "not_found" | "forbidden" | "invalid" | "conflict";

/** The one error the core throws. `code` is for callers; the message names the thing. */
export class CoreError extends Error {
  readonly code: CoreErrorCode;

  constructor(code: CoreErrorCode, message: string) {
    super(message);
    this.name = "CoreError";
    this.code = code;
  }
}
