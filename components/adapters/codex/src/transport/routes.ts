const RESPONSE_PATHS = new Set([
  "/responses",
  "/v1/responses",
  "/backend-api/codex/responses",
]);

const MODEL_PATHS = new Set([
  "/models",
  "/v1/models",
  "/backend-api/codex/models",
]);

export const CODEX_RESPONSE_PATHS = Array.from(RESPONSE_PATHS);
export const CODEX_MODEL_PATHS = Array.from(MODEL_PATHS);

export function isCodexResponsesPath(pathname: string): boolean {
  return RESPONSE_PATHS.has(pathname);
}

export function isCodexModelsPath(pathname: string): boolean {
  return MODEL_PATHS.has(pathname);
}

export function codexResourceSuffix(inboundPath: string): string {
  const url = new URL(inboundPath, "http://127.0.0.1");
  let pathname = url.pathname;
  for (const prefix of ["/backend-api/codex", "/v1"]) {
    if (pathname === prefix) {
      pathname = "/";
      break;
    }
    if (pathname.startsWith(`${prefix}/`)) {
      pathname = pathname.slice(prefix.length);
      break;
    }
  }
  return `${pathname || "/"}${url.search}`;
}

export function codexUpstreamRequestPath(baseUrl: string, inboundPath: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = codexResourceSuffix(inboundPath);
  if (base.endsWith("/v1") || base.endsWith("/backend-api/codex")) return suffix;
  return `/v1${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
}
