import { isLoopbackBindHost, networkBindAuthError } from "../bind-guard"

describe("isLoopbackBindHost", () => {
  test.each(["127.0.0.1", "::1", "localhost", "LOCALHOST", "127.5.6.7", " 127.0.0.1 "])(
    "treats %s as loopback",
    (host) => {
      expect(isLoopbackBindHost(host)).toBe(true)
    },
  )

  test.each(["0.0.0.0", "::", "10.0.0.5", "192.168.1.10", "example.com", "127.example.com", ""])(
    "treats %s as network-reachable",
    (host) => {
      expect(isLoopbackBindHost(host)).toBe(false)
    },
  )
})

describe("networkBindAuthError", () => {
  test("refuses a non-loopback bind with no auth", () => {
    const err = networkBindAuthError("0.0.0.0", false)
    expect(err).toContain("Refusing to bind to non-loopback host")
    expect(err).toContain("SCG_API_KEYS")
  })

  test("allows a non-loopback bind when auth is configured", () => {
    expect(networkBindAuthError("0.0.0.0", true)).toBeNull()
  })

  test("allows a loopback bind with no auth (local-first default)", () => {
    expect(networkBindAuthError("127.0.0.1", false)).toBeNull()
    expect(networkBindAuthError("localhost", false)).toBeNull()
  })

  test("allows a loopback bind with auth", () => {
    expect(networkBindAuthError("::1", true)).toBeNull()
  })
})
