import { closeSync, openSync, writeSync } from "node:fs";

/**
 * Writes `JSON.stringify(value, null, 2) + "\n"` to `file` WITHOUT building that string. On Kubernetes
 * the result is 93 MB of indented JSON; stringifying it whole took the process from 1.3 GB to 2 GB at
 * the very end of a run. This walks the value and flushes every megabyte, byte-identical to
 * `JSON.stringify` (same omission of `undefined`/functions in objects, `null` for them in arrays,
 * `toJSON`, and the same empty `[]` / `{}`).
 */
export function writeJsonFile(file: string, value: unknown): void {
  const fd = openSync(file, "w");
  let buffer = "";
  const flush = () => {
    if (buffer) writeSync(fd, buffer, null, "utf8");
    buffer = "";
  };
  const write = (text: string) => {
    buffer += text;
    if (buffer.length >= 1 << 20) flush();
  };

  const emit = (input: unknown, indent: string): void => {
    let value = input;
    if (value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
      value = (value as { toJSON(): unknown }).toJSON();
    }
    if (value === null || typeof value !== "object") {
      write(JSON.stringify(value) ?? "null");
      return;
    }
    const inner = `${indent}  `;
    if (Array.isArray(value)) {
      if (value.length === 0) return write("[]");
      write("[\n");
      value.forEach((item, index) => {
        write(inner);
        if (item === undefined || typeof item === "function" || typeof item === "symbol") write("null");
        else emit(item, inner);
        write(index < value.length - 1 ? ",\n" : "\n");
      });
      return write(`${indent}]`);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => {
      const entry = record[key];
      return entry !== undefined && typeof entry !== "function" && typeof entry !== "symbol";
    });
    if (keys.length === 0) return write("{}");
    write("{\n");
    keys.forEach((key, index) => {
      write(`${inner}${JSON.stringify(key)}: `);
      emit(record[key], inner);
      write(index < keys.length - 1 ? ",\n" : "\n");
    });
    write(`${indent}}`);
  };

  try {
    emit(value, "");
    write("\n");
    flush();
  } finally {
    closeSync(fd);
  }
}
