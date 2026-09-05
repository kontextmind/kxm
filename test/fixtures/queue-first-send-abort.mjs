const originalFetch = globalThis.fetch;
let injected = false;
globalThis.fetch = async (input, init) => {
  if (!injected && typeof init?.body === "string" && init.body.includes("hold the queue")) {
    injected = true;
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException("Injected queue send abort", "AbortError"));
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener("abort", abort, { once: true });
    });
  }
  return originalFetch(input, init);
};
