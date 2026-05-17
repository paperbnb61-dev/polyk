export function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  const v = typeof raw === "string" ? raw.trim() : "";
  return v || fallback;
}

export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function envBool(name: string, fallback: boolean): boolean {
  const raw = envString(name, fallback ? "true" : "false").toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

export function clampCents(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}
