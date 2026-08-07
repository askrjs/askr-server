export function contentType(value: string | null): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

function quality(parameters: readonly string[]): number {
  const parameter = parameters.find((value) => value.trim().toLowerCase().startsWith("q="));
  if (!parameter) return 1;
  const value = Number(parameter.slice(parameter.indexOf("=") + 1).trim());
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
}

export function accepts(value: string, expected: string): boolean {
  const [expectedType, expectedSubtype] = expected.toLowerCase().split("/", 2);
  if (!expectedType || !expectedSubtype) return false;
  let specificity = -1;
  let acceptedQuality = 0;
  for (const entry of value.split(",")) {
    const [range, ...parameters] = entry.split(";");
    const [type, subtype] = range!.trim().toLowerCase().split("/", 2);
    const currentSpecificity =
      type === expectedType && subtype === expectedSubtype
        ? 2
        : type === expectedType && subtype === "*"
          ? 1
          : type === "*" && subtype === "*"
            ? 0
            : -1;
    if (currentSpecificity < specificity || currentSpecificity < 0) continue;
    const currentQuality = quality(parameters);
    if (currentSpecificity > specificity) {
      specificity = currentSpecificity;
      acceptedQuality = currentQuality;
    } else {
      acceptedQuality = Math.max(acceptedQuality, currentQuality);
    }
  }
  return acceptedQuality > 0;
}
