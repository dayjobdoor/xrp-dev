// Preloaded into the real bin: every rippled call is answered offline with the URL it was sent to, after FAKE_DELAY_MS.
globalThis.fetch = (async (url: string | URL | Request) => {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_DELAY_MS ?? 0)));
  return Response.json({ result: { status: "success", url: String(url) } });
}) as typeof fetch;
