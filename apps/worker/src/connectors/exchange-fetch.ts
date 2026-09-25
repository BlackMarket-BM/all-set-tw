export function exchangeFetch(env: {
  BINANCE_HTTP?: Pick<Fetcher, "fetch">;
}): typeof fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://api-gcp.binance.com") {
      if (!env.BINANCE_HTTP) {
        throw new Error("Binance 區域連線服務尚未設定。");
      }
      return env.BINANCE_HTTP.fetch(input, init);
    }
    return fetch(input, init);
  };
}
