function termVector(text: string): Map<string, number> {
  const vector = new Map<string, number>();
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) vector.set(word, (vector.get(word) ?? 0) + 1);
  return vector;
}

function norm(vector: Map<string, number>): number {
  let sum = 0;
  for (const count of vector.values()) sum += count * count;
  return Math.sqrt(sum);
}

export function similarity(a: string, b: string): number {
  if (!a.trim() && !b.trim()) return 1;
  const va = termVector(a);
  const vb = termVector(b);
  let dot = 0;
  for (const [word, count] of va) dot += count * (vb.get(word) ?? 0);
  const denominator = norm(va) * norm(vb);
  return denominator === 0 ? 0 : dot / denominator;
}
