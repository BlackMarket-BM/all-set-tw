const origin = "https://api-gcp.binance.com";
const allowed = new Set([
  "GET /sapi/v1/account/apiRestrictions",
  "GET /api/v3/account",
  "POST /sapi/v1/asset/get-funding-asset",
  "GET /api/v3/ticker/price",
]);

// Private service binding only. Use a fetch handler so placement also applies
// when the caller runs inside a Queue consumer.
export async function forwardBinanceRequest(
  request: Request,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    !allowed.has(`${request.method} ${url.pathname}`)
  ) {
    return new Response("Unsupported request", { status: 403 });
  }
  const headers = new Headers();
  const apiKey = request.headers.get("X-MBX-APIKEY");
  if (apiKey) headers.set("X-MBX-APIKEY", apiKey);
  try {
    // Binance signs the query string, including for the read-only POST.
    const response = await fetcher(request.url, {
      method: request.method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return new Response("Upstream redirect rejected", { status: 502 });
    }
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new Response("Binance connection failed", { status: 502 });
  }
}

export default {
  fetch(request: Request) {
    return forwardBinanceRequest(request);
  },
};
