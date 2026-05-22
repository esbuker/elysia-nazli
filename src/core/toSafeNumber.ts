export const toSafeNumber = (value: unknown, fallback: number) => {
  if (typeof value === 'bigint') {
    const asNumber = Number(value)

    return Number.isFinite(asNumber) ? asNumber : fallback
  }

  if (typeof value === 'string') {
    const parsed = Number(value)

    return Number.isFinite(parsed) ? parsed : fallback
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback
  }

  return fallback
}
