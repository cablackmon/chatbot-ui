/**
 * @jest-environment node
 */
// Exercises the real provider SDKs (openai, @anthropic-ai/sdk,
// @google/generative-ai) with the global fetch replaced by a spy, so every
// upstream request is observed and none reaches the network.

let mockProfile: Record<string, any> = {}
let mockCustomModel: Record<string, any> | null = null

jest.mock("../../../../lib/server/server-chat-helpers", () => ({
  checkApiKey: jest.fn(),
  getServerProfile: jest.fn(async () => mockProfile)
}))

jest.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: mockCustomModel, error: null })
        })
      })
    }),
    rpc: async () => ({
      data: [{ content: "chunk", similarity: 1 }],
      error: null
    })
  })
}))

jest.mock("../../../../lib/generate-local-embedding", () => ({
  generateLocalEmbedding: jest.fn()
}))

import { POST as anthropicPOST } from "@/app/api/chat/anthropic/route"
import { POST as azurePOST } from "@/app/api/chat/azure/route"
import { POST as customPOST } from "@/app/api/chat/custom/route"
import { POST as googlePOST } from "@/app/api/chat/google/route"
import { POST as groqPOST } from "@/app/api/chat/groq/route"
import { POST as mistralPOST } from "@/app/api/chat/mistral/route"
import { POST as openaiPOST } from "@/app/api/chat/openai/route"
import { POST as openrouterPOST } from "@/app/api/chat/openrouter/route"
import { POST as perplexityPOST } from "@/app/api/chat/perplexity/route"
import { GET as assistantsGET } from "@/app/api/assistants/openai/route"
import { POST as commandPOST } from "@/app/api/command/route"
import { POST as retrievePOST } from "@/app/api/retrieval/retrieve/route"
import { NextRequest } from "next/server"

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  })

const embeddingResponse = () =>
  json({
    object: "list",
    data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
    model: "text-embedding-3-small",
    usage: { prompt_tokens: 1, total_tokens: 1 }
  })

const sse = (events: string[]) =>
  new Response(events.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  })

const openaiStream = () =>
  sse([
    `data: ${JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      created: 1,
      model: "m",
      choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }]
    })}\n\n`,
    "data: [DONE]\n\n"
  ])

const anthropicStream = () =>
  sse(
    [
      {
        type: "message_start",
        message: {
          id: "m1",
          type: "message",
          role: "assistant",
          content: [],
          model: "m",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hi" }
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" }
    ].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  )

const googleStream = () =>
  sse([
    `data: ${JSON.stringify({
      candidates: [
        { content: { role: "model", parts: [{ text: "hi" }] }, index: 0 }
      ]
    })}\n\n`
  ])

const chatRequest = (body: Record<string, unknown>) =>
  new NextRequest("http://localhost/api/chat", {
    method: "POST",
    body: JSON.stringify(body)
  })

const openaiBody = (model: string) => ({
  chatSettings: { model, temperature: 0.5 },
  messages: [{ role: "user", content: "hi" }]
})

const requestedHosts = (spy: jest.SpyInstance) =>
  spy.mock.calls.map(([input]) => new URL(String(input)).hostname)

describe("Edge chat routes: trusted provider destinations", () => {
  let fetchSpy: jest.SpyInstance
  const savedAzureEndpoint = process.env.AZURE_OPENAI_ENDPOINT

  beforeEach(() => {
    mockProfile = {}
    mockCustomModel = null
    delete process.env.AZURE_OPENAI_ENDPOINT
    fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async () => {
      throw new Error("unexpected network request")
    })
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    if (savedAzureEndpoint === undefined) {
      delete process.env.AZURE_OPENAI_ENDPOINT
    } else {
      process.env.AZURE_OPENAI_ENDPOINT = savedAzureEndpoint
    }
  })

  describe("positive controls: each built-in provider reaches its fixed host", () => {
    it.each([
      ["openai", openaiPOST, "openai_api_key", "gpt-4o", "api.openai.com"],
      ["groq", groqPOST, "groq_api_key", "llama3-8b-8192", "api.groq.com"],
      [
        "mistral",
        mistralPOST,
        "mistral_api_key",
        "mistral-large-latest",
        "api.mistral.ai"
      ],
      [
        "perplexity",
        perplexityPOST,
        "perplexity_api_key",
        "sonar-small-chat",
        "api.perplexity.ai"
      ],
      [
        "openrouter",
        openrouterPOST,
        "openrouter_api_key",
        "openai/gpt-4o",
        "openrouter.ai"
      ]
    ])(
      "%s streams a completion from its fixed host",
      async (_name, POST, keyField, model, host) => {
        mockProfile = { [keyField]: "test-key" }
        fetchSpy.mockImplementation(async () => openaiStream())

        const response = await POST(chatRequest(openaiBody(model)) as any)

        expect(response.status).toBe(200)
        expect(await response.text()).toBe("hi")
        expect(requestedHosts(fetchSpy)).toEqual([host])
        expect(fetchSpy.mock.calls[0][1].redirect).toBe("manual")
      }
    )

    it("anthropic streams a completion from api.anthropic.com", async () => {
      mockProfile = { anthropic_api_key: "test-key" }
      fetchSpy.mockImplementation(async () => anthropicStream())

      const response = await anthropicPOST(
        chatRequest({
          chatSettings: {
            model: "claude-3-5-sonnet-20240620",
            temperature: 0.5
          },
          messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "hi" }
          ]
        })
      )

      expect(response.status).toBe(200)
      expect(await response.text()).toBe("hi")
      expect(requestedHosts(fetchSpy)).toEqual(["api.anthropic.com"])
      expect(fetchSpy.mock.calls[0][1].redirect).toBe("manual")
    })

    it("google streams a completion from its fixed SDK host", async () => {
      mockProfile = { google_gemini_api_key: "test-key" }
      fetchSpy.mockImplementation(async () => googleStream())

      const response = await googlePOST(
        chatRequest({
          chatSettings: { model: "gemini-1.5-flash", temperature: 0.5 },
          messages: [{ role: "user", parts: [{ text: "hi" }] }]
        }) as any
      )

      expect(response.status).toBe(200)
      expect(await response.text()).toBe("hi")
      expect(requestedHosts(fetchSpy)).toEqual([
        "generativelanguage.googleapis.com"
      ])
    })

    it("azure streams from the operator-configured AZURE_OPENAI_ENDPOINT host", async () => {
      process.env.AZURE_OPENAI_ENDPOINT = "https://contoso.openai.azure.com"
      mockProfile = {
        azure_openai_api_key: "test-key",
        azure_openai_endpoint: "https://contoso.openai.azure.com/",
        azure_openai_45_turbo_id: "gpt4-deploy"
      }
      fetchSpy.mockImplementation(async () => openaiStream())

      const response = await azurePOST(
        chatRequest(openaiBody("gpt-4-turbo-preview"))
      )

      expect(response.status).toBe(200)
      expect(await response.text()).toBe("hi")
      const [input, init] = fetchSpy.mock.calls[0]
      const url = new URL(String(input))
      expect(url.hostname).toBe("contoso.openai.azure.com")
      expect(url.pathname).toBe(
        "/openai/deployments/gpt4-deploy/chat/completions"
      )
      expect(init.redirect).toBe("manual")
    })

    it.each([
      ["groq", "https://api.groq.com/openai/v1", "api.groq.com"],
      ["openrouter", "https://openrouter.ai/api/v1", "openrouter.ai"],
      ["a normalized host", "https://API.OpenAI.com./v1", "api.openai.com"]
    ])(
      "custom model with a %s base_url reaches the trusted host",
      async (_label, baseUrl, host) => {
        mockCustomModel = { api_key: "test-key", base_url: baseUrl }
        fetchSpy.mockImplementation(async () => openaiStream())

        const response = await customPOST(
          chatRequest({ ...openaiBody("gpt-4o"), customModelId: "m1" })
        )

        expect(response.status).toBe(200)
        expect(await response.text()).toBe("hi")
        expect(requestedHosts(fetchSpy)).toEqual([host])
      }
    )
  })

  describe("custom model base_url outside the trusted hosts fails closed", () => {
    it.each([
      ["an unknown host", "https://llm.example.com/v1"],
      ["a lookalike suffix host", "https://api.openai.com.evil.com/v1"],
      ["a lookalike prefix host", "https://evil-api.openai.com/v1"],
      ["a subdomain of a trusted host", "https://evil.api.openai.com/v1"],
      ["an IDN lookalike", "https://аpi.openai.com/v1"],
      ["a private IP", "https://10.0.0.1/v1"],
      ["the metadata IP", "https://169.254.169.254/latest"],
      ["a decimal IP", "https://2130706433/v1"],
      ["an IPv6 literal", "https://[::1]/v1"],
      ["localhost (self-hosted Ollama)", "http://localhost:11434/v1"],
      ["credentials", "https://user:pass@api.openai.com/v1"],
      ["http", "http://api.openai.com/v1"],
      ["an unusual port", "https://api.openai.com:8443/v1"],
      ["a query string", "https://api.openai.com/v1?x=1"],
      ["no base_url", null]
    ])("rejects %s with 403 before any request", async (_label, baseUrl) => {
      mockCustomModel = { api_key: "test-key", base_url: baseUrl }

      const response = await customPOST(
        chatRequest({ ...openaiBody("gpt-4o"), customModelId: "m1" })
      )

      expect(response.status).toBe(403)
      expect((await response.json()).message).toMatch(/^Blocked server request/)
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })

  describe("azure endpoint provenance", () => {
    const azureProfile = (endpoint: string) => ({
      azure_openai_api_key: "test-key",
      azure_openai_endpoint: endpoint,
      azure_openai_45_turbo_id: "gpt4-deploy"
    })

    it("rejects a profile-only endpoint when AZURE_OPENAI_ENDPOINT is unset", async () => {
      mockProfile = azureProfile("https://contoso.openai.azure.com")

      const response = await azurePOST(
        chatRequest(openaiBody("gpt-4-turbo-preview"))
      )

      expect(response.status).toBe(403)
      expect((await response.json()).message).toMatch(/AZURE_OPENAI_ENDPOINT/)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it.each([
      ["another host", "https://evil.example.com"],
      ["a lookalike host", "https://contoso.openai.azure.com.evil.com"],
      ["credentials", "https://u:p@contoso.openai.azure.com"],
      ["an unusual port", "https://contoso.openai.azure.com:444"],
      ["http", "http://contoso.openai.azure.com"]
    ])(
      "rejects a profile endpoint on %s that differs from the operator host",
      async (_label, endpoint) => {
        process.env.AZURE_OPENAI_ENDPOINT = "https://contoso.openai.azure.com"
        mockProfile = azureProfile(endpoint)

        const response = await azurePOST(
          chatRequest(openaiBody("gpt-4-turbo-preview"))
        )

        expect(response.status).toBe(403)
        expect(fetchSpy).not.toHaveBeenCalled()
      }
    )
  })

  describe("redirects are never followed", () => {
    const redirectTo = (location: string) => async () =>
      new Response(null, { status: 302, headers: { location } })

    it.each([
      ["openai", openaiPOST, "openai_api_key", "api.openai.com"],
      ["groq", groqPOST, "groq_api_key", "api.groq.com"]
    ])(
      "%s does not follow a redirect to an untrusted host",
      async (_name, POST, keyField, host) => {
        mockProfile = { [keyField]: "test-key" }
        fetchSpy.mockImplementation(redirectTo("https://evil.example.com/x"))

        const response = await POST(
          chatRequest(openaiBody("llama3-8b-8192")) as any
        )

        expect(response.status).not.toBe(200)
        expect(fetchSpy).toHaveBeenCalled()
        expect(new Set(requestedHosts(fetchSpy))).toEqual(new Set([host]))
        for (const [, init] of fetchSpy.mock.calls) {
          expect(init.redirect).toBe("manual")
        }
      },
      15000
    )

    it("custom model does not follow a redirect to an untrusted host", async () => {
      mockCustomModel = {
        api_key: "test-key",
        base_url: "https://api.groq.com/openai/v1"
      }
      fetchSpy.mockImplementation(redirectTo("http://169.254.169.254/"))

      const response = await customPOST(
        chatRequest({ ...openaiBody("gpt-4o"), customModelId: "m1" })
      )

      expect(response.status).not.toBe(200)
      expect(new Set(requestedHosts(fetchSpy))).toEqual(
        new Set(["api.groq.com"])
      )
    }, 15000)

    it("anthropic does not follow a redirect to an untrusted host", async () => {
      mockProfile = { anthropic_api_key: "test-key" }
      fetchSpy.mockImplementation(redirectTo("https://evil.example.com/x"))

      const response = await anthropicPOST(
        chatRequest({
          chatSettings: {
            model: "claude-3-5-sonnet-20240620",
            temperature: 0.5
          },
          messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "hi" }
          ]
        })
      )

      expect(response.status).not.toBe(200)
      expect(new Set(requestedHosts(fetchSpy))).toEqual(
        new Set(["api.anthropic.com"])
      )
    }, 15000)
  })

  describe("other OpenAI clients reach only their fixed or operator host", () => {
    it("command calls api.openai.com", async () => {
      mockProfile = { openai_api_key: "test-key" }
      fetchSpy.mockImplementation(async () =>
        json({
          id: "c1",
          object: "chat.completion",
          created: 1,
          model: "m",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop"
            }
          ]
        })
      )

      const response = await commandPOST(
        new Request("http://localhost/api/command", {
          method: "POST",
          body: JSON.stringify({ input: "hi" })
        })
      )

      expect(response.status).toBe(200)
      expect(requestedHosts(fetchSpy)).toEqual(["api.openai.com"])
      expect(fetchSpy.mock.calls[0][1].redirect).toBe("manual")
    })

    it("assistants list calls api.openai.com", async () => {
      mockProfile = { openai_api_key: "test-key" }
      fetchSpy.mockImplementation(async () =>
        json({ object: "list", data: [], has_more: false })
      )

      const response = await assistantsGET()

      expect(response.status).toBe(200)
      expect(requestedHosts(fetchSpy)).toEqual(["api.openai.com"])
    })

    const retrieveRequest = () =>
      new Request("http://localhost/api/retrieval/retrieve", {
        method: "POST",
        body: JSON.stringify({
          userInput: "q",
          fileIds: ["f1"],
          embeddingsProvider: "openai",
          sourceCount: 1
        })
      })

    it("retrieval (Node runtime) embeds through api.openai.com", async () => {
      mockProfile = { openai_api_key: "test-key", use_azure_openai: false }
      fetchSpy.mockImplementation(async () => embeddingResponse())

      const response = await retrievePOST(retrieveRequest())

      expect(response.status).toBe(200)
      expect(requestedHosts(fetchSpy)).toEqual(["api.openai.com"])
      expect(fetchSpy.mock.calls[0][1].redirect).toBe("manual")
    })

    it("retrieval (Node runtime) embeds through the operator Azure host", async () => {
      process.env.AZURE_OPENAI_ENDPOINT = "https://contoso.openai.azure.com"
      mockProfile = {
        use_azure_openai: true,
        azure_openai_api_key: "test-key",
        azure_openai_endpoint: "https://contoso.openai.azure.com",
        azure_openai_embeddings_id: "embed-deploy"
      }
      fetchSpy.mockImplementation(async () => embeddingResponse())

      const response = await retrievePOST(retrieveRequest())

      expect(response.status).toBe(200)
      const url = new URL(String(fetchSpy.mock.calls[0][0]))
      expect(url.hostname).toBe("contoso.openai.azure.com")
      expect(url.pathname).toBe("/openai/deployments/embed-deploy/embeddings")
    })

    it("retrieval (Node runtime) rejects a profile-only Azure endpoint before any request", async () => {
      mockProfile = {
        use_azure_openai: true,
        azure_openai_api_key: "test-key",
        azure_openai_endpoint: "https://evil.example.com",
        azure_openai_embeddings_id: "embed-deploy"
      }

      const response = await retrievePOST(retrieveRequest())

      expect(response.status).toBe(403)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it("retrieval (Node runtime) does not follow an Azure redirect to an untrusted host", async () => {
      process.env.AZURE_OPENAI_ENDPOINT = "https://contoso.openai.azure.com"
      mockProfile = {
        use_azure_openai: true,
        azure_openai_api_key: "test-key",
        azure_openai_endpoint: "https://contoso.openai.azure.com",
        azure_openai_embeddings_id: "embed-deploy"
      }
      fetchSpy.mockImplementation(
        async () =>
          new Response(null, {
            status: 307,
            headers: { location: "http://169.254.169.254/" }
          })
      )

      const response = await retrievePOST(retrieveRequest())

      expect(response.status).not.toBe(200)
      expect(new Set(requestedHosts(fetchSpy))).toEqual(
        new Set(["contoso.openai.azure.com"])
      )
    }, 15000)
  })
})
