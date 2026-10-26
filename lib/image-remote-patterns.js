// Remote image hosts the Next.js image optimizer may fetch. App images come
// only from Supabase Storage (public profile images and signed workspace,
// assistant and file URLs from db/storage/*), so the optimizer is limited to
// the storage path on the configured NEXT_PUBLIC_SUPABASE_URL host. With no
// Supabase URL configured, no remote host is allowed.
function imageRemotePatterns(supabaseUrl) {
  if (!supabaseUrl) return []

  const url = new URL(supabaseUrl)
  if (url.protocol !== "https:" && url.protocol !== "http:") return []

  return [
    {
      protocol: url.protocol.slice(0, -1),
      hostname: url.hostname,
      port: url.port,
      pathname: "/storage/v1/object/**"
    }
  ]
}

module.exports = { imageRemotePatterns }
