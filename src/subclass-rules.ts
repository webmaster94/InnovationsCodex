export function patternCapacity(bardLevel: unknown): number {
  const level = Number(bardLevel);
  if (!Number.isInteger(level) || level < 3) return 0;
  return Math.max(0, (level * 2) - 2);
}

export function maximumPatternTier(spells: Record<string, { max?: unknown } | undefined>): number {
  let highest = 0;
  for (let level = 1; level <= 9; level += 1) {
    const maximum = Number(spells?.[`spell${level}`]?.max ?? 0);
    if (Number.isFinite(maximum) && maximum > 0) highest = level;
  }
  return highest;
}
