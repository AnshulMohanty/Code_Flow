// AUTHORED ground truth for parser parity. Every `expected*` list below is a human
// statement of what the file really declares/imports — written from the source, not from
// either parser's output. This is the reference both engines are scored against, which is
// what makes "parity-or-better" a measurement rather than a diff.
//
// Two truth sets per case, on purpose:
//   • `expectedSymbols`     — every symbol a reader would say the file declares.
//   • `expectedCoreSymbols` — the SUBSET the legacy regex parser was built to find
//     (named functions, classes, arrow/function-expression consts, Python def/class).
//     This is the honest parity baseline: tree-sitter must not LOSE any of these.
//
// Hermetic: plain strings, no repo clone, no network, no keys.

export interface ParityCase {
  id: string;
  /** Drives language selection through the registry, exactly as the pipeline does. */
  path: string;
  content: string;
  expectedSymbols: string[];
  expectedCoreSymbols: string[];
  /** Every import / require / dynamic-import SOURCE the file actually has. */
  expectedImports: string[];
  /** What this case is here to measure. */
  note: string;
}

export const PARITY_CORPUS: ParityCase[] = [
  {
    id: "js-commonjs-service",
    path: "src/services/mailer.js",
    note: "CommonJS + a multi-line ESM import + a commented-out import (a regex false positive).",
    content: `"use strict";

const nodemailer = require("nodemailer");
const { renderTemplate } = require("./templates");
// const legacy = require("./legacy-mailer");
import {
  DEFAULT_FROM,
  RETRY_LIMIT,
} from "./constants";

const transport = nodemailer.createTransport({ host: "localhost" });

function buildMessage(to, subject, body) {
  return { from: DEFAULT_FROM, to, subject, html: renderTemplate(body) };
}

async function sendMail(to, subject, body) {
  for (let attempt = 0; attempt < RETRY_LIMIT; attempt += 1) {
    await transport.sendMail(buildMessage(to, subject, body));
  }
}

const sendWelcome = (to) => sendMail(to, "Welcome", "welcome");

module.exports = { sendMail, sendWelcome };
`,
    // `attempt` is a for-loop binding, not a module symbol — not expected from either engine.
    expectedSymbols: ["nodemailer", "transport", "buildMessage", "sendMail", "sendWelcome"],
    expectedCoreSymbols: ["buildMessage", "sendMail", "sendWelcome"],
    expectedImports: ["nodemailer", "./templates", "./constants"],
  },
  {
    id: "jsx-dashboard",
    path: "src/components/Dashboard.jsx",
    note: "React component + hook + a lazily-imported child.",
    content: `import React, { useEffect, useState } from "react";
import classNames from "classnames";
import { fetchStats } from "../api/stats";

const REFRESH_MS = 30000;

export function useStats(repoId) {
  const [stats, setStats] = useState(null);
  useEffect(() => {
    fetchStats(repoId).then(setStats);
  }, [repoId]);
  return stats;
}

export default function Dashboard({ repoId }) {
  const stats = useStats(repoId);
  const Panel = React.lazy(() => import("./Panel"));
  return <div className={classNames("dash")}>{stats ? <Panel stats={stats} /> : null}</div>;
}
`,
    expectedSymbols: ["REFRESH_MS", "useStats", "Dashboard"],
    expectedCoreSymbols: ["useStats", "Dashboard"],
    expectedImports: ["react", "classnames", "../api/stats", "./Panel"],
  },
  {
    id: "ts-domain-model",
    path: "src/domain/order.ts",
    note: "TS type-level declarations, an enum, and class methods (which regex never saw).",
    content: `import type { CustomerId } from "./customer";
import { Money, add } from "./money";

export interface OrderLine {
  sku: string;
  quantity: number;
}

export type OrderId = string;

export enum OrderStatus {
  Draft = "draft",
  Placed = "placed",
}

const TAX_RATE = 0.2;

export class Order {
  private lines: OrderLine[] = [];

  constructor(readonly id: OrderId, readonly customerId: CustomerId) {}

  addLine(line: OrderLine): void {
    this.lines.push(line);
  }

  total(): Money {
    return this.lines.reduce((sum, line) => add(sum, price(line)), Money.zero());
  }
}

function price(line: OrderLine): Money {
  return Money.of(line.quantity);
}
`,
    expectedSymbols: [
      "OrderLine",
      "OrderId",
      "OrderStatus",
      "TAX_RATE",
      "Order",
      "constructor",
      "addLine",
      "total",
      "price",
    ],
    expectedCoreSymbols: ["Order", "price"],
    expectedImports: ["./customer", "./money"],
  },
  {
    id: "tsx-form",
    path: "src/components/OrderForm.tsx",
    note: "TSX component, a typed hook, and a type-only import.",
    content: `import React, { useCallback } from "react";
import type { OrderLine } from "../domain/order";
import { submitOrder } from "../api/orders";

type Props = {
  lines: OrderLine[];
};

export const OrderForm: React.FC<Props> = ({ lines }) => {
  const onSubmit = useCallback(() => submitOrder(lines), [lines]);
  return <form onSubmit={onSubmit} />;
};

export function useOrderTotal(lines: OrderLine[]) {
  return lines.length;
}
`,
    expectedSymbols: ["Props", "OrderForm", "useOrderTotal"],
    expectedCoreSymbols: ["OrderForm", "useOrderTotal"],
    expectedImports: ["react", "../domain/order", "../api/orders"],
  },
  {
    id: "py-service",
    path: "pkg/orders/service.py",
    note: "Python relative imports, a decorated method, and an import nested in a try block.",
    content: `import os
import logging as log
from .models import Order, OrderLine
from ..money import Money as M

try:
    from ujson import dumps
except ImportError:
    from json import dumps

LOGGER = log.getLogger(__name__)


class OrderService:
    def __init__(self, repo):
        self.repo = repo

    @property
    def count(self):
        return len(self.repo)

    async def place(self, order: Order) -> M:
        return await self.repo.save(order)


def build_service(repo=None):
    return OrderService(repo or os.environ["REPO"])
`,
    // Python has no export syntax; LOGGER is a module-level assignment, which neither
    // engine treats as a declaration — so it is not in the truth set for either.
    expectedSymbols: ["OrderService", "__init__", "count", "place", "build_service"],
    expectedCoreSymbols: ["OrderService", "__init__", "count", "place", "build_service"],
    expectedImports: ["os", "logging", ".models", "..money", "ujson", "json"],
  },
  {
    id: "py-flask-app",
    path: "pkg/web/app.py",
    note: "Flask route decorators — the HTTP surface the CPG enrichment reads.",
    content: `from flask import Flask, jsonify
from .service import build_service

app = Flask(__name__)
service = build_service()


@app.route("/health")
def health():
    return jsonify(status="ok")


@app.route("/orders/<order_id>", methods=["GET", "DELETE"])
def order_detail(order_id):
    return jsonify(service.get(order_id))
`,
    expectedSymbols: ["health", "order_detail"],
    expectedCoreSymbols: ["health", "order_detail"],
    expectedImports: ["flask", ".service"],
  },
];
