export function contentType(value: string | null): string | undefined {
  if (!value) return undefined;
  const separator = value.indexOf(";");
  const type = (separator === -1 ? value : value.slice(0, separator)).trim();
  return type ? type.toLowerCase() : undefined;
}

function quality(value: string, start: number, end: number): number {
  while (start < end) {
    const separator = value.indexOf(";", start);
    const parameterEnd = separator === -1 || separator > end ? end : separator;
    const parameter = value.slice(start, parameterEnd).trim().toLowerCase();
    if (parameter.startsWith("q=")) {
      const weight = Number(parameter.slice(2).trim());
      return Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0;
    }
    start = parameterEnd + 1;
  }
  return 1;
}

export function accepts(value: string, expected: string): boolean {
  const normalizedExpected = expected.toLowerCase();
  const expectedSlash = normalizedExpected.indexOf("/");
  if (expectedSlash <= 0) return false;
  const expectedNextSlash = normalizedExpected.indexOf("/", expectedSlash + 1);
  const expectedType = normalizedExpected.slice(0, expectedSlash);
  const expectedSubtype = normalizedExpected.slice(
    expectedSlash + 1,
    expectedNextSlash === -1 ? normalizedExpected.length : expectedNextSlash,
  );
  if (!expectedType || !expectedSubtype) return false;
  let specificity = -1;
  let acceptedQuality = 0;
  let start = 0;
  while (start <= value.length) {
    const comma = value.indexOf(",", start);
    const end = comma === -1 ? value.length : comma;
    const semicolon = value.indexOf(";", start);
    const rangeEnd = semicolon === -1 || semicolon > end ? end : semicolon;
    const range = value.slice(start, rangeEnd).trim().toLowerCase();
    const slash = range.indexOf("/");
    const nextSlash = range.indexOf("/", slash + 1);
    const type = slash === -1 ? "" : range.slice(0, slash);
    const subtype =
      slash === -1 ? "" : range.slice(slash + 1, nextSlash === -1 ? range.length : nextSlash);
    const currentSpecificity =
      type === expectedType && subtype === expectedSubtype
        ? 2
        : type === expectedType && subtype === "*"
          ? 1
          : type === "*" && subtype === "*"
            ? 0
            : -1;
    if (currentSpecificity >= specificity && currentSpecificity >= 0) {
      const currentQuality = rangeEnd === end ? 1 : quality(value, rangeEnd + 1, end);
      if (currentSpecificity > specificity) {
        specificity = currentSpecificity;
        acceptedQuality = currentQuality;
      } else {
        acceptedQuality = Math.max(acceptedQuality, currentQuality);
      }
    }
    if (comma === -1) break;
    start = comma + 1;
  }
  return acceptedQuality > 0;
}

export function explicitlyAccepts(value: string, expected: string): boolean {
  const normalizedExpected = expected.trim().toLowerCase();
  let start = 0;
  while (start <= value.length) {
    const comma = value.indexOf(",", start);
    const end = comma === -1 ? value.length : comma;
    const semicolon = value.indexOf(";", start);
    const rangeEnd = semicolon === -1 || semicolon > end ? end : semicolon;
    if (value.slice(start, rangeEnd).trim().toLowerCase() === normalizedExpected)
      return accepts(value, normalizedExpected);
    if (comma === -1) break;
    start = comma + 1;
  }
  return false;
}
