// The host copies at most 32 000 characters at once. A big manifest or YAML is copied in parts instead of failing.

export const CLIPBOARD_MAX = 32_000;
/** Room under the limit, so a part never lands exactly on it. */
const PART_MAX = 30_000;

/**
 * Splits text into parts that each fit one copy. Parts break between YAML documents (`---`) when they can and between
 * lines otherwise, so each part is still readable on its own. Text that fits is one part.
 */
export const splitForClipboard = (text: string, max = PART_MAX): string[] => {
  if (text.length <= max) return [text];
  const lines = text.split('\n');
  // Documents first: a new document starts at a line that is exactly `---`.
  const documents: string[][] = [[]];
  for (const line of lines) {
    if (/^---\s*$/.test(line) && documents[documents.length - 1]!.length > 0) documents.push([]);
    documents[documents.length - 1]!.push(line);
  }
  const parts: string[] = [];
  let current = '';
  const push = (): void => {
    if (current) parts.push(current);
    current = '';
  };
  for (const doc of documents) {
    const block = doc.join('\n');
    if (block.length > max) {
      // One document alone is too long: break it by line.
      push();
      for (const line of doc) {
        const piece = line.length > max ? line.slice(0, max) : line;
        if (current && current.length + piece.length + 1 > max) push();
        current = current ? `${current}\n${piece}` : piece;
      }
      push();
    } else if (current && current.length + block.length + 1 > max) {
      push();
      current = block;
    } else current = current ? `${current}\n${block}` : block;
  }
  push();
  return parts;
};
