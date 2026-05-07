/**
 * Node's fetch (undici) can throw ConnectTimeoutError on slow/blocked networks.
 * Retries + longer timeout reduce spurious failures.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;
const RETRY_BASE_MS = 800;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchJson<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number; retries?: number }
): Promise<T> {
  const timeoutMs = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = init?.retries ?? DEFAULT_RETRIES;
  const { timeoutMs: _t, retries: _r, ...rest } = init ?? {};

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...rest, signal: ctrl.signal });
      clearTimeout(tid);
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${url} ${txt.slice(0, 200)}`);
      }
      return (await res.json()) as T;
    } catch (e) {
      clearTimeout(tid);
      lastErr = e;
      if (attempt < retries) {
        await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
      }
    }
  }
  throw lastErr;
}

/** Plain GET returning Response body text/json callers handle */
export async function fetchWithRetry(url: string, init?: RequestInit & { timeoutMs?: number; retries?: number }): Promise<Response> {
  const timeoutMs = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = init?.retries ?? DEFAULT_RETRIES;
  const { timeoutMs: _t, retries: _r, ...rest } = init ?? {};

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...rest, signal: ctrl.signal });
      clearTimeout(tid);
      return res;
    } catch (e) {
      clearTimeout(tid);
      lastErr = e;
      if (attempt < retries) await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}
