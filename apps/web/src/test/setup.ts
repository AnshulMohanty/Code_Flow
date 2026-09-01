import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * UNMOUNT AFTER EVERY TEST.
 *
 * React Testing Library auto-cleans only when `globals: true`, which this project does not set (it
 * imports `describe`/`it` explicitly instead). Without this, every `render` leaves its tree in the
 * document and the next test's queries match elements from the previous one — the failure mode is
 * "found multiple elements", which reads like a duplicated-markup bug in the component rather than a
 * leaked test.
 */
afterEach(() => {
  cleanup();
});
