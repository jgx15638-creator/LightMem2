export type TokenPilotMcpWireProtocol = "newline_json" | "content_length";

export function encodeMcpMessage(
  message: unknown,
  protocol: TokenPilotMcpWireProtocol = "newline_json",
): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (protocol === "content_length") {
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
    return Buffer.concat([header, body]);
  }
  return Buffer.concat([body, Buffer.from("\n", "utf8")]);
}
