export function countLoc(content: string) {
  if (content.trim().length === 0) {
    return 0;
  }
  return content.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0).length;
}

export function splitLines(content: string) {
  return content.split(/\r\n|\r|\n/);
}

export function lineNumber(index: number) {
  return index + 1;
}

export function indentationOf(line: string) {
  return line.match(/^\s*/)?.[0].length ?? 0;
}
