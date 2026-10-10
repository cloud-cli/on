const EXACT_SEMVER =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isExactSemver(version: string): boolean {
  if (version.length > 256) return false;
  const match = EXACT_SEMVER.exec(version);
  if (!match) return false;
  if (match.slice(1, 4).some((part) => part.length > 1 && part.startsWith("0"))) return false;
  if (
    match[4]
      ?.split(".")
      .some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))
  ) {
    return false;
  }
  return true;
}
