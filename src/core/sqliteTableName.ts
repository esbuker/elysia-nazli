export const sanitizeTableName = (name: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQLite table name: ${name}`)
  }

  return name
}
