/**
 * @jest-environment node
 */
import {
  TRUSTED_TOOL_HOSTS,
  UntrustedDestinationError,
  assertTrustedAzureEndpoint,
  assertTrustedUrl,
  fetchTrustedUrl
} from "@/lib/server/trusted-fetch"

const TRUSTED = ["api.trusted.com"]

const okResponse = () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  })

describe("fetchTrustedUrl", () => {
  it("fetches a trusted destination with redirects disabled", async () => {
    const fetchSpy = jest.fn().mockResolvedValue(okResponse())

    const response = await fetchTrustedUrl(
      "https://api.trusted.com/v1/weather?city=austin",
      { method: "GET" },
      TRUSTED,
      fetchSpy
    )

    expect(await response.json()).toEqual({ ok: true })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.trusted.com/v1/weather?city=austin",
      { method: "GET", redirect: "manual" }
    )
  })

  it("overrides a caller-supplied redirect mode", async () => {
    const fetchSpy = jest.fn().mockResolvedValue(okResponse())
    await fetchTrustedUrl(
      "https://api.trusted.com/",
      { redirect: "follow" },
      TRUSTED,
      fetchSpy
    )
    expect(fetchSpy.mock.calls[0][1].redirect).toBe("manual")
  })

  it("fetches the canonical URL after case and trailing-dot normalization", async () => {
    const fetchSpy = jest.fn().mockResolvedValue(okResponse())
    await fetchTrustedUrl(
      "https://API.Trusted.COM./v1",
      {},
      ["API.TRUSTED.com"],
      fetchSpy
    )
    expect(fetchSpy.mock.calls[0][0]).toBe("https://api.trusted.com/v1")
  })

  it.each([
    ["untrusted host", "https://evil.com/"],
    ["subdomain escape", "https://api.trusted.com.evil.com/"],
    ["prefix lookalike", "https://evil-api.trusted.com/"],
    ["hyphen lookalike", "https://evilapi.trusted.com/"],
    ["subdomain of trusted host", "https://x.api.trusted.com/"],
    ["parent of trusted host", "https://trusted.com/"],
    ["IDN homograph (Cyrillic e)", "https://api.trustеd.com/"],
    ["punycode lookalike", "https://api.xn--trustd-6pf.com/"],
    ["credentials", "https://user:pass@api.trusted.com/"],
    ["username only", "https://user@api.trusted.com/"],
    ["credential host confusion", "https://api.trusted.com@evil.com/"],
    ["http scheme", "http://api.trusted.com/"],
    ["ftp scheme", "ftp://api.trusted.com/"],
    ["file scheme", "file:///etc/passwd"],
    ["unusual port", "https://api.trusted.com:8443/"],
    ["port 80 on https", "https://api.trusted.com:80/"],
    ["backslash", "https://evil.com\\@api.trusted.com/"],
    ["whitespace", " https://api.trusted.com/"],
    ["control character", "https://api.trusted.com\t.evil.com/"],
    ["relative URL", "/v1/weather"],
    ["empty URL", ""]
  ])("rejects %s before any network call", async (_label, url) => {
    const fetchSpy = jest.fn()
    await expect(fetchTrustedUrl(url, {}, TRUSTED, fetchSpy)).rejects.toThrow(
      UntrustedDestinationError
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    ["IPv4 loopback", "https://127.0.0.1/", "127.0.0.1"],
    ["decimal IPv4", "https://2130706433/", "127.0.0.1"],
    ["hex IPv4", "https://0x7f.0.0.1/", "127.0.0.1"],
    ["octal IPv4", "https://0177.0.0.1/", "127.0.0.1"],
    ["short IPv4", "https://127.1/", "127.0.0.1"],
    ["private IPv4", "https://10.0.0.1/", "10.0.0.1"],
    ["link-local metadata", "https://169.254.169.254/", "169.254.169.254"],
    ["IPv6 loopback", "https://[::1]/", "[::1]"],
    ["IPv4-mapped IPv6", "https://[::ffff:127.0.0.1]/", "[::ffff:7f00:1]"],
    ["localhost", "https://localhost/", "localhost"],
    ["localhost subdomain", "https://app.localhost/", "app.localhost"]
  ])("rejects %s even when allowlisted", async (_label, url, allowlisted) => {
    const fetchSpy = jest.fn()
    await expect(
      fetchTrustedUrl(url, {}, [allowlisted], fetchSpy)
    ).rejects.toThrow("not allowed")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    ["to an untrusted host", 302, "https://evil.com/payload"],
    ["to the same trusted host", 301, "https://api.trusted.com/other"],
    ["without a Location", 307, null]
  ])(
    "rejects a redirect %s without reading the body",
    async (_l, status, location) => {
      const cancel = jest.fn().mockResolvedValue(undefined)
      const response = {
        status,
        type: "basic",
        ok: false,
        headers: new Headers(location ? { Location: location } : {}),
        body: { cancel },
        json: jest.fn()
      } as unknown as Response
      const fetchSpy = jest.fn().mockResolvedValue(response)

      await expect(
        fetchTrustedUrl("https://api.trusted.com/", {}, TRUSTED, fetchSpy)
      ).rejects.toThrow("redirects are not followed")
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(cancel).toHaveBeenCalled()
      expect(response.json).not.toHaveBeenCalled()
    }
  )

  it("rejects an opaque redirect response", async () => {
    const fetchSpy = jest
      .fn()
      .mockResolvedValue({ status: 0, type: "opaqueredirect", body: null })
    await expect(
      fetchTrustedUrl("https://api.trusted.com/", {}, TRUSTED, fetchSpy)
    ).rejects.toThrow("redirects are not followed")
  })

  it("errors carry HTTP 403", () => {
    expect(() => assertTrustedUrl("https://evil.com/", TRUSTED)).toThrow(
      expect.objectContaining({ status: 403 })
    )
  })
})

describe("TRUSTED_TOOL_HOSTS", () => {
  it("is empty, so user-configured tool URLs fail closed", async () => {
    expect(TRUSTED_TOOL_HOSTS).toEqual([])
    const fetchSpy = jest.fn()
    await expect(
      fetchTrustedUrl(
        "https://weather.example.com/forecast",
        {},
        TRUSTED_TOOL_HOSTS,
        fetchSpy
      )
    ).rejects.toThrow("is not trusted")
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("assertTrustedAzureEndpoint", () => {
  const OPERATOR = "https://contoso.openai.azure.com"

  it("accepts the operator-configured endpoint", () => {
    expect(assertTrustedAzureEndpoint(OPERATOR, OPERATOR)).toBe(OPERATOR)
    expect(assertTrustedAzureEndpoint(`${OPERATOR}/`, OPERATOR)).toBe(OPERATOR)
  })

  it("fails closed when no operator endpoint is configured", () => {
    expect(() => assertTrustedAzureEndpoint(OPERATOR, undefined)).toThrow(
      "AZURE_OPENAI_ENDPOINT"
    )
    expect(() => assertTrustedAzureEndpoint(OPERATOR, "")).toThrow(
      UntrustedDestinationError
    )
  })

  it.each([
    ["another Azure resource", "https://attacker.openai.azure.com"],
    ["an arbitrary host", "https://evil.com"],
    ["a subdomain escape", "https://contoso.openai.azure.com.evil.com"],
    ["credentials", "https://u:p@contoso.openai.azure.com"],
    ["an unusual port", "https://contoso.openai.azure.com:8443"],
    ["http", "http://contoso.openai.azure.com"],
    ["a query", "https://contoso.openai.azure.com/?x=1"],
    ["a missing endpoint", null]
  ])("rejects a profile endpoint with %s", (_label, endpoint) => {
    expect(() => assertTrustedAzureEndpoint(endpoint, OPERATOR)).toThrow(
      UntrustedDestinationError
    )
  })

  it.each([
    ["http", "http://contoso.openai.azure.com"],
    ["an IP literal", "https://10.0.0.5"],
    ["garbage", "not a url"]
  ])("rejects an operator endpoint with %s", (_label, operator) => {
    expect(() => assertTrustedAzureEndpoint(operator, operator)).toThrow(
      UntrustedDestinationError
    )
  })
})
