/**
 * @jest-environment node
 */
import { hasMatch } from "next/dist/shared/lib/match-remote-pattern"

const { imageRemotePatterns } = require("../../lib/image-remote-patterns")

const SUPABASE = "https://abcdefghijklmnop.supabase.co"

const loadNextConfig = (supabaseUrl: string | undefined) => {
  const previous = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (supabaseUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
  else process.env.NEXT_PUBLIC_SUPABASE_URL = supabaseUrl
  try {
    let config: any
    jest.isolateModules(() => {
      config = require("../../next.config.js")
    })
    return config
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previous
  }
}

const allowed = (patterns: any[], url: string) =>
  hasMatch([], patterns, new URL(url))

describe("next.config.js image remotePatterns", () => {
  const patterns = loadNextConfig(SUPABASE).images.remotePatterns

  it("has no wildcard host", () => {
    expect(patterns).toEqual([
      {
        protocol: "https",
        hostname: "abcdefghijklmnop.supabase.co",
        port: "",
        pathname: "/storage/v1/object/**"
      }
    ])
  })

  it.each([
    [
      "public profile image",
      `${SUPABASE}/storage/v1/object/public/profile_images/u1/image.png`
    ],
    [
      "signed workspace image",
      `${SUPABASE}/storage/v1/object/sign/workspace_images/u1/w1.png?token=abc`
    ],
    [
      "signed assistant image",
      `${SUPABASE}/storage/v1/object/sign/assistant_images/u1/a1.png?token=abc`
    ]
  ])("allows the %s", (_label, url) => {
    expect(allowed(patterns, url)).toBe(true)
  })

  it.each([
    ["an arbitrary host", "https://evil.com/storage/v1/object/public/x.png"],
    [
      "another Supabase project",
      "https://otherproject.supabase.co/storage/v1/object/public/x.png"
    ],
    [
      "a subdomain escape",
      "https://abcdefghijklmnop.supabase.co.evil.com/storage/v1/object/public/x.png"
    ],
    ["a non-storage path", `${SUPABASE}/rest/v1/profiles`],
    [
      "http",
      "http://abcdefghijklmnop.supabase.co/storage/v1/object/public/x.png"
    ],
    [
      "an unusual port",
      "https://abcdefghijklmnop.supabase.co:8443/storage/v1/object/public/x.png"
    ],
    ["localhost", "http://localhost/storage/v1/object/public/x.png"],
    ["the metadata IP", "http://169.254.169.254/latest/meta-data"]
  ])("rejects %s", (_label, url) => {
    expect(allowed(patterns, url)).toBe(false)
  })

  it("allows no remote host when the Supabase URL is unset", () => {
    expect(loadNextConfig(undefined).images.remotePatterns).toEqual([])
  })

  it("keeps local Supabase working in development", () => {
    const local = imageRemotePatterns("http://127.0.0.1:54321")
    expect(
      allowed(local, "http://127.0.0.1:54321/storage/v1/object/public/x.png")
    ).toBe(true)
    expect(allowed(local, "http://127.0.0.1:8080/x.png")).toBe(false)
  })
})
