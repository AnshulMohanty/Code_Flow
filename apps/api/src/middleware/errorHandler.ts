import type { ErrorRequestHandler } from "express";
import type { ApiErrorCode, ErrorResponse } from "../types/api.js";

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function createErrorResponse(
  code: ApiErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): ErrorResponse {
  return {
    error: {
      code,
      message,
      details,
    },
  };
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.statusCode).json(createErrorResponse(err.code, err.message, err.details));
    return;
  }

  if (isJsonParseError(err)) {
    res.status(400).json(createErrorResponse("INVALID_REQUEST", "Request body must be valid JSON."));
    return;
  }

  const message = err instanceof Error ? err.message : "Unexpected server error";
  res.status(500).json(createErrorResponse("INTERNAL_ERROR", message));
};

function isJsonParseError(err: unknown): boolean {
  return (
    err instanceof SyntaxError &&
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status?: unknown }).status === 400
  );
}
