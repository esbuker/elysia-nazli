export const readBenchInteger = (name: string, fallback: number, minimum = 1) => {
  const value = Number(Bun.env[name] ?? fallback)

  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`benchmark: ${name} must be a safe integer >= ${minimum}`)
  }

  return value
}

export const summarizeSamples = (samples: number[]) => {
  if (samples.length === 0 || samples.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('benchmark: samples must contain positive finite measurements')
  }
  const sorted = samples.slice().sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  return {
    median: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  }
}
