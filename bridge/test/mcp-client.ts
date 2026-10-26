/** Minimal MCP Streamable-HTTP client for tests (POST /mcp, JSON responses). */
export function mcpClient(base: string, headers: Record<string, string> = {}) {
  let id = 0;
  const post = async (body: unknown, extra: Record<string, string> = {}) => {
    const r = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers, ...extra },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await r.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: r.status, json, text, headers: r.headers };
  };
  return {
    post,
    rpc: (method: string, params?: unknown) => post({ jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) }),
    /** tools/call -> { envelope, isError } */
    async call(name: string, args: Record<string, unknown> = {}) {
      const r = await post({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } });
      const res = r.json?.result;
      return { status: r.status, rpc: r.json, isError: !!res?.isError, envelope: (res?.structuredContent ?? null) as any, text: res?.content?.[0]?.text as string | undefined };
    },
  };
}
