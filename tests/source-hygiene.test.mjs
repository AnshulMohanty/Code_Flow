import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * REPO-WIDE SOURCE HYGIENE.
 *
 * This exists because of a bug that was found, fixed, and then survived in two other files.
 * `packages/observability/src/tracer.ts` used a raw 0x00 byte as a map-key separator; commit
 * 1193d93 replaced it with the `\u0000` escape because a raw NUL makes every tool classify the
 * file as BINARY — `grep` skips it silently, `git diff` refuses to render it, and a copy-paste or
 * a careless editor can drop the byte with no visible change.
 *
 * The fix was applied where the problem was NOTICED rather than where it OCCURRED: the identical
 * pattern was still in `stages/analyze.ts` and `stages/inventory.ts`, so two of the pipeline's
 * eight stages were un-greppable. A one-file fix cannot prevent that; a repo-wide assertion can.
 *
 * The runtime value of the escape is identical to the raw byte, so this is purely about the source
 * being readable by the tools everyone uses on it.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'legacy']);
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.cjs', '.js', '.json', '.yml', '.yaml', '.md'];
/** Built from its char code so no shell, heredoc or editor between here and disk can eat it. */
const SEPARATOR = String.fromCharCode(92);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) yield full;
  }
}

test('no tracked source file contains a raw NUL byte (it makes the file binary to git and grep)', async () => {
  const offenders = [];
  for await (const file of walk(repoRoot)) {
    const bytes = await readFile(file);
    // Windows path separators normalised so the failure message reads the same on every platform.
    if (bytes.includes(0)) offenders.push(relative(repoRoot, file).split(SEPARATOR).join('/'));
  }
  assert.deepEqual(
    offenders,
    [],
    'Use the six-character escape instead of a literal NUL. Offending files: ' + offenders.join(', '),
  );
});
