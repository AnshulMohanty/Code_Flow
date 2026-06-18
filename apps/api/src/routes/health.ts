import { Router } from "express";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "codeflow-api",
    version: process.env.npm_package_version || "0.0.0",
    timestamp: new Date().toISOString(),
  });
});
