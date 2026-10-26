/**
 * @jest-environment node
 */
import { openapiToFunctions } from "@/lib/openapi-conversion"

describe("openapiToFunctions external $ref handling", () => {
  it("does not fetch or read external $ref targets", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(() => {
      throw new Error("network must not be reached")
    })

    try {
      const result = await openapiToFunctions({
        info: { title: "Refs", description: "", version: "v1" },
        servers: [{ url: "https://api.example.com" }],
        paths: {
          "/a": {
            get: {
              operationId: "getA",
              parameters: [
                {
                  name: "q",
                  in: "query",
                  schema: { $ref: "https://evil.com/s.json" }
                },
                { name: "f", in: "query", schema: { $ref: "/etc/passwd" } }
              ]
            }
          }
        }
      })

      expect(fetchSpy).not.toHaveBeenCalled()
      expect(result.routes).toHaveLength(1)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
