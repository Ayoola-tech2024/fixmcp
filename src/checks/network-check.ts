import type { Finding, ServerEntry } from "../types.js";

export interface NetworkOptions {
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

/** For http/sse servers: is the endpoint network-reachable at all? */
export async function checkNetwork(
  entry: ServerEntry,
  opts: NetworkOptions = {}
): Promise<Finding[]> {
  if (entry.transport === "stdio" || !entry.url) return [];
  const timeoutMs = opts.timeoutMs ?? 5000;
  const doFetch = opts.fetchFn ?? fetch;
  try {
    const res = await doFetch(entry.url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // any HTTP response means the host + route are alive; auth/protocol issues
    // surface later in real usage, not here.
    return [
      {
        check: "network",
        severity: "ok",
        message: `endpoint reachable (HTTP ${res.status}).`,
      },
    ];
  } catch (err) {
    const cause =
      (err as { cause?: { code?: string } })?.cause?.code ??
      (err as Error).name;
    return [
      {
        check: "network",
        severity: "error",
        message: `endpoint unreachable: ${entry.url} (${cause})`,
        detail: "DNS failure, connection refused, or timeout - check the URL and your network.",
      },
    ];
  }
}
