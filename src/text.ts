/** Removes common Markdown so QQ shows clean text. */
export function stripMarkdown(input: string): string {
  return input
    .replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_m, body: string) => body.trim())
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/___([^_]+)___/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/!?\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Splits long replies into QQ-friendly chunks, preferring line boundaries. */
export function splitChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = maxChars;
    const window = rest.slice(0, maxChars);
    const newline = window.lastIndexOf('\n');
    if (newline > maxChars * 0.5) {
      cut = newline;
    } else {
      const space = window.lastIndexOf(' ');
      if (space > maxChars * 0.5) cut = space;
    }
    const piece = rest.slice(0, cut).trim();
    if (piece) chunks.push(piece);
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest.trim()) chunks.push(rest.trim());
  return chunks;
}
