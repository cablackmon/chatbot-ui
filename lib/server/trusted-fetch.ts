// Server-side fetch destination policy.
//
// Responses from attacker-chosen servers can reach the runtime's HTTP
// decompression code, so every server-side request whose URL comes from
// user/tenant data must go to an exact, verified host. Validation happens
// before any network call; redirects are never followed.

// Hosts that user-configured OpenAPI tools may call. This repo ships no
// built-in tools, so no tool host has verified provenance and the list is
// intentionally empty: user-configured tool URLs fail closed. Add an exact
// hostname here only through a reviewed change that records its provenance.
export const TRUSTED_TOOL_HOSTS: readonly string[] = []

export class UntrustedDestinationError extends Error {
  status = 403

  constructor(reason: string) {
    super(`Blocked server request: ${reason}`)
    this.name = "UntrustedDestinationError"
  }
}

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/
const NUMERIC_LABEL = /^(0x[0-9a-f]*|\d+)$/i
const BLOCKED_HOSTNAMES = new Set(["localhost"])
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain"]

const stripTrailingDot = (hostname: string) =>
  hostname.endsWith(".") ? hostname.slice(0, -1) : hostname

// Canonical form used for exact comparison: WHATWG URL parsing lowercases,
// converts IDN to punycode and canonicalizes IPv4 forms; one trailing dot is
// dropped so "host." and "host" compare equal.
export function normalizeHostname(hostname: string): string {
  let parsed: URL
  try {
    parsed = new URL(`https://${hostname}/`)
  } catch {
    throw new UntrustedDestinationError("invalid hostname")
  }
  if (
    parsed.host !== parsed.hostname ||
    parsed.pathname !== "/" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new UntrustedDestinationError("invalid hostname")
  }
  return stripTrailingDot(parsed.hostname)
}

function assertNotIpOrLocal(hostname: string) {
  if (hostname.startsWith("[") || hostname.includes(":")) {
    throw new UntrustedDestinationError(
      "IP literal destinations are not allowed"
    )
  }
  const lastLabel = hostname.split(".").pop() || ""
  if (IPV4_LITERAL.test(hostname) || NUMERIC_LABEL.test(lastLabel)) {
    throw new UntrustedDestinationError(
      "IP literal destinations are not allowed"
    )
  }
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    BLOCKED_SUFFIXES.some(suffix => hostname.endsWith(suffix))
  ) {
    throw new UntrustedDestinationError("local destinations are not allowed")
  }
}

// Returns the canonical URL to fetch. Callers must fetch the returned URL, not
// the raw input, so the request goes exactly where validation looked.
export function assertTrustedUrl(
  rawUrl: string,
  trustedHosts: readonly string[]
): URL {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    throw new UntrustedDestinationError("missing URL")
  }
  if (/[\u0000- \u007f\\]/.test(rawUrl)) {
    throw new UntrustedDestinationError("URL contains forbidden characters")
  }

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new UntrustedDestinationError("invalid URL")
  }

  if (url.protocol !== "https:") {
    throw new UntrustedDestinationError("only https URLs are allowed")
  }
  if (url.username !== "" || url.password !== "") {
    throw new UntrustedDestinationError("URL credentials are not allowed")
  }
  if (url.port !== "") {
    throw new UntrustedDestinationError(
      "only the default https port is allowed"
    )
  }

  const hostname = stripTrailingDot(url.hostname)
  assertNotIpOrLocal(hostname)

  const allowed = new Set(trustedHosts.map(normalizeHostname))
  if (!allowed.has(hostname)) {
    throw new UntrustedDestinationError(`host ${hostname} is not trusted`)
  }

  url.hostname = hostname
  return url
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

export async function fetchTrustedUrl(
  rawUrl: string,
  init: RequestInit,
  trustedHosts: readonly string[],
  fetchImpl: FetchImpl = fetch
): Promise<Response> {
  const url = assertTrustedUrl(rawUrl, trustedHosts)
  const response = await fetchImpl(url.href, { ...init, redirect: "manual" })

  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  ) {
    await response.body?.cancel().catch(() => {})
    throw new UntrustedDestinationError("redirects are not followed")
  }

  return response
}

// Azure OpenAI requests from Node.js routes may only go to the host of the
// endpoint the operator set in the AZURE_OPENAI_ENDPOINT server environment
// variable. A user-entered profile endpoint has no trusted provenance and
// fails closed. Returns the canonical endpoint without a trailing slash.
export function assertTrustedAzureEndpoint(
  profileEndpoint: string | null | undefined,
  operatorEndpoint: string | undefined = process.env.AZURE_OPENAI_ENDPOINT
): string {
  if (!operatorEndpoint) {
    throw new UntrustedDestinationError(
      "Azure OpenAI endpoint must be configured by the server operator (AZURE_OPENAI_ENDPOINT)"
    )
  }
  let operatorHost: string
  try {
    operatorHost = new URL(operatorEndpoint).hostname
  } catch {
    throw new UntrustedDestinationError("invalid AZURE_OPENAI_ENDPOINT")
  }
  const operatorUrl = assertTrustedUrl(operatorEndpoint, [operatorHost])
  const url = assertTrustedUrl(profileEndpoint || "", [operatorUrl.hostname])
  if (url.search !== "" || url.hash !== "") {
    throw new UntrustedDestinationError(
      "Azure OpenAI endpoint must not have a query"
    )
  }
  return url.href.replace(/\/$/, "")
}
