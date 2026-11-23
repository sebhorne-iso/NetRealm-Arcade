// Dialect registry (filled in by js/cli/index.js) so dialects can open sessions to each other
// without circular imports.
const REG = new Map();
export const register = (ids, dialect) => [].concat(ids).forEach((id) => REG.set(id, dialect));
export const getDialect = (id) => REG.get(id) || REG.get('ios');
export const hasDialect = (id) => REG.has(id);
