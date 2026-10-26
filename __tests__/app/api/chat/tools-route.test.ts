/**
 * @jest-environment node
 */
const mockCreate = jest.fn()

jest.mock("../../../../lib/server/server-chat-helpers", () => ({
  checkApiKey: jest.fn(),
  getServerProfile: jest.fn().mockResolvedValue({
    openai_api_key: "test-key",
    openai_organization_id: null
  })
}))

jest.mock("openai", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } }
  }))
}))

jest.mock("ai", () => ({
  OpenAIStream: jest.fn(),
  StreamingTextResponse: jest.fn()
}))

import { POST } from "@/app/api/chat/tools/route"

const toolSchema = (serverUrl: string) =>
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Weather", description: "Weather", version: "v1" },
    servers: [{ url: serverUrl }],
    paths: {
      "/forecast": {
        get: {
          operationId: "getForecast",
          parameters: [
            { name: "city", in: "query", schema: { type: "string" } }
          ]
        }
      }
    }
  })

const request = (schemas: string[]) =>
  new Request("http://localhost/api/chat/tools", {
    method: "POST",
    body: JSON.stringify({
      chatSettings: { model: "gpt-5.4" },
      messages: [{ role: "user", content: "weather?" }],
      selectedTools: schemas.map(schema => ({ schema, custom_headers: "" }))
    })
  })

describe("POST /api/chat/tools", () => {
  let fetchSpy: jest.SpyInstance

  beforeEach(() => {
    mockCreate.mockReset()
    fetchSpy = jest.spyOn(global, "fetch").mockImplementation(() => {
      throw new Error("network must not be reached")
    })
  })

  afterEach(() => fetchSpy.mockRestore())

  it.each([
    ["an unknown host", "https://weather.example.com"],
    ["a lookalike host", "https://api.openai.com.evil.com"],
    ["a loopback IP", "https://127.0.0.1"],
    ["credentials", "https://u:p@weather.example.com"],
    ["http", "http://weather.example.com"]
  ])(
    "fails closed with 403 for a tool server with %s before any upstream request",
    async (_label, serverUrl) => {
      const response = await POST(request([toolSchema(serverUrl)]))

      expect(response.status).toBe(403)
      expect((await response.json()).message).toMatch(/^Blocked server request/)
      expect(mockCreate).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
    }
  )

  it("fails closed for a tool schema without a server URL", async () => {
    const schema = JSON.parse(toolSchema("https://x.example"))
    delete schema.servers
    const response = await POST(request([JSON.stringify(schema)]))

    expect(response.status).toBe(403)
    expect(mockCreate).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("still answers without tools when none are selected", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "hello" } }]
    })
    const response = await POST(request([]))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("hello")
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
