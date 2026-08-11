function validatedMcpUrl(value) {
  const url = new URL(value);
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new Error("Discord MCP must use HTTPS or local HTTP");
  return url;
}

function structuredToolResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result?.content?.find((item) => item?.type === "text")?.text;
  if (!text) throw new Error("Discord MCP returned no structured tool result");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Discord MCP returned an invalid tool result");
  }
}

export async function callDiscordMcpTool({ mcpUrl, token, name, args = {}, fetchImpl = fetch }) {
  const response = await fetchImpl(validatedMcpUrl(mcpUrl), {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `radar-${name}`,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (!response.ok) throw new Error(`Discord MCP request failed with HTTP ${response.status}`);
  const payload = await response.json().catch(() => null);
  if (!payload || payload.error || payload.result?.isError) throw new Error("Discord MCP tool request failed");
  return structuredToolResult(payload.result);
}
