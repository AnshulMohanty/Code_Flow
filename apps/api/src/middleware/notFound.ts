import type { RequestHandler } from "express";
import { createErrorResponse } from "./errorHandler.js";

export const notFound: RequestHandler = (req, res) => {
  res.status(404).json(
    createErrorResponse("NOT_FOUND", `Route not found: ${req.method} ${req.path}`, {
      path: req.path,
      method: req.method,
    }),
  );
};
