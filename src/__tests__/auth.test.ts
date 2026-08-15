/**
 * Unit tests for authentication middleware.
 */

import { Request, Response, NextFunction } from "express"

// Mock environment before importing the module
const ORIGINAL_ENV = process.env

function createMockReqRes(opts: { path?: string; authorization?: string; xApiKey?: string; ip?: string }): {
  req: Partial<Request>
  res: Partial<Response> & { statusCode?: number; body?: any; headers?: Record<string, string> }
  next: jest.Mock
} {
  const req: Partial<Request> = {
    path: opts.path || "/test",
    ip: opts.ip || "127.0.0.1",
    socket: { remoteAddress: opts.ip || "127.0.0.1" } as any,
    headers: {
      ...(opts.authorization ? { authorization: opts.authorization } : {}),
      ...(opts.xApiKey ? { "x-api-key": opts.xApiKey } : {}),
    } as any,
  }

  const res: Partial<Response> & { statusCode?: number; body?: any; headers?: Record<string, string> } = {
    statusCode: undefined,
    body: undefined,
    headers: {},
    status(code: number) {
      this.statusCode = code
      return this as Response
    },
    json(data: any) {
      this.body = data
      return this as Response
    },
    setHeader(key: string, value: string) {
      this.headers![key] = value
      return this
    },
  }

  const next = jest.fn()
  return { req, res, next }
}

describe("Auth Middleware", () => {
  beforeEach(() => {
    jest.resetModules()
    jest.useRealTimers()
    process.env = { ...ORIGINAL_ENV }
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  test("rejects all requests when no API keys configured", async () => {
    process.env["SCG_API_KEYS"] = ""
    const { authMiddleware } = await import("../middleware/auth")
    const { req, res, next } = createMockReqRes({})

    authMiddleware(req as Request, res as Response, next as NextFunction)

    expect(res.statusCode).toBe(503)
    expect(next).not.toHaveBeenCalled()
  })

  test("allows health check without auth", async () => {
    process.env["SCG_API_KEYS"] = ""
    const { authMiddleware } = await import("../middleware/auth")
    const { req, res, next } = createMockReqRes({ path: "/health" })

    authMiddleware(req as Request, res as Response, next as NextFunction)

    expect(next).toHaveBeenCalled()
  })

  test("allows ready check without auth", async () => {
    process.env["SCG_API_KEYS"] = ""
    const { authMiddleware } = await import("../middleware/auth")
    const { req, res, next } = createMockReqRes({ path: "/ready" })

    authMiddleware(req as Request, res as Response, next as NextFunction)

    expect(next).toHaveBeenCalled()
  })

  test("requires auth for metrics endpoint", async () => {
    process.env["SCG_API_KEYS"] = "correct-key"
    const { authMiddleware } = await import("../middleware/auth")
    const { req, res, next } = createMockReqRes({ path: "/metrics" })

    authMiddleware(req as Request, res as Response, next as NextFunction)

    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  test("exports request authentication helper for valid keys", async () => {
    process.env["SCG_API_KEYS"] = "correct-key"
    const { isRequestAuthenticated } = await import("../middleware/auth")
    const { req } = createMockReqRes({
      path: "/health",
      authorization: "Bearer correct-key",
    })

    expect(isRequestAuthenticated(req as Request)).toBe(true)
  })

  test("request authentication helper rejects invalid keys", async () => {
    process.env["SCG_API_KEYS"] = "correct-key"
    const { isRequestAuthenticated } = await import("../middleware/auth")
    const { req } = createMockReqRes({
      path: "/health",
      authorization: "Bearer wrong-key",
    })

    expect(isRequestAuthenticated(req as Request)).toBe(false)
  })

  test("accepts valid Bearer token", async () => {
    process.env["SCG_API_KEYS"] = "my-secret-key"
    const { authMiddleware } = await import("../middleware/auth")
    const { req, res, next } = createMockReqRes({
      authorization: "Bearer my-secret-key",
    })

    authMiddleware(req as Request, res as Response, next as NextFunction)

    expect(next).toHaveBeenCalled()
  })

  test("accepts valid X-API-Key header", async () => {
    process.env["SCG_API_KEYS"] = "my-secret-key"
    const { authMiddleware } = await import("../middleware/auth")
    const { req, res, next } = createMockReqRes({
      xApiKey: "my-secret-key",
    })

    authMiddleware(req as Request, res as Response, next as NextFunction)

    expect(next).toHaveBeenCalled()
  })

  test("rejects invalid key with 403", async () => {
    process.env["SCG_API_KEYS"] = "correct-key"
    const { authMiddleware } = await import("../middleware/auth")
    const { req, res, next } = createMockReqRes({
      authorization: "Bearer wrong-key",
    })

    authMiddleware(req as Request, res as Response, next as NextFunction)

    expect(res.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })

  test("rejects missing key with 401", async () => {
    process.env["SCG_API_KEYS"] = "correct-key"
    const { authMiddleware } = await import("../middleware/auth")
    const { req, res, next } = createMockReqRes({})
    req.correlationId = "req-123"

    authMiddleware(req as Request, res as Response, next as NextFunction)

    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual(expect.objectContaining({ correlationId: "req-123" }))
    expect(next).not.toHaveBeenCalled()
  })

  test("supports multiple comma-separated keys", async () => {
    process.env["SCG_API_KEYS"] = "key-1,key-2,key-3"
    const { authMiddleware } = await import("../middleware/auth")
    const { req, res, next } = createMockReqRes({
      xApiKey: "key-2",
    })

    authMiddleware(req as Request, res as Response, next as NextFunction)

    expect(next).toHaveBeenCalled()
  })

  test("requires distinct strong admin keys for production HTTP deployments", async () => {
    const { validateAdminApiKeyConfiguration } = await import("../middleware/auth")
    const regular = "r".repeat(32)
    const admin = "a".repeat(32)

    expect(validateAdminApiKeyConfiguration([regular], [], true)).toEqual([
      "SCG_ADMIN_API_KEYS must define a separate admin allowlist in production.",
    ])
    expect(validateAdminApiKeyConfiguration([regular], ["short", regular], true)).toEqual(
      expect.arrayContaining([
        "Every SCG_ADMIN_API_KEYS entry must be at least 32 characters.",
        "SCG_ADMIN_API_KEYS must not reuse a regular SCG_API_KEYS credential in production.",
      ]),
    )
    expect(validateAdminApiKeyConfiguration([regular], [admin], true)).toEqual([])
    expect(validateAdminApiKeyConfiguration([regular], [], false)).toEqual([])
  })

  test("requires an admin key for repository mutation and command-execution routes", async () => {
    const regular = "r".repeat(32)
    const admin = "a".repeat(32)
    process.env["SCG_API_KEYS"] = regular
    process.env["SCG_ADMIN_API_KEYS"] = admin
    const { authMiddleware, requirePrivilegedHttpRoute } = await import("../middleware/auth")

    for (const path of [
      "/scg_register_repo",
      "/scg_apply_patch",
      "/scg_validate_change",
      "/scg_commit_change",
      "/scg_rollback_change",
      "/scg_admin_cleanup_stale",
    ]) {
      const regularCall = createMockReqRes({ path, authorization: `Bearer ${regular}` })
      authMiddleware(regularCall.req as Request, regularCall.res as Response, regularCall.next as NextFunction)
      expect(regularCall.next).toHaveBeenCalledTimes(1)
      requirePrivilegedHttpRoute(
        regularCall.req as Request,
        regularCall.res as Response,
        regularCall.next as NextFunction,
      )
      expect(regularCall.res.statusCode).toBe(403)

      const adminCall = createMockReqRes({ path, authorization: `Bearer ${admin}` })
      authMiddleware(adminCall.req as Request, adminCall.res as Response, adminCall.next as NextFunction)
      requirePrivilegedHttpRoute(adminCall.req as Request, adminCall.res as Response, adminCall.next as NextFunction)
      expect(adminCall.res.statusCode).toBeUndefined()
      expect(adminCall.next).toHaveBeenCalledTimes(2)
    }
  })

  test("holds the admin boundary against the spellings express also routes", async () => {
    // Express matches case-insensitively and ignores a trailing slash, so each
    // of these reaches the same handler as the canonical path. The gate used to
    // compare the raw req.path, so a read key walked straight through.
    const regular = "r".repeat(32)
    process.env["SCG_API_KEYS"] = regular
    process.env["SCG_ADMIN_API_KEYS"] = "a".repeat(32)
    const { authMiddleware, requirePrivilegedHttpRoute } = await import("../middleware/auth")

    for (const path of [
      "/scg_apply_patch/",
      "/SCG_APPLY_PATCH",
      "/Scg_Apply_Patch",
      "/SCG_APPLY_PATCH/",
      "/scg_commit_change/",
      "/SCG_ADMIN_CLEANUP_STALE",
      "/scg_admin_cleanup_stale/",
    ]) {
      const call = createMockReqRes({ path, authorization: `Bearer ${regular}` })
      authMiddleware(call.req as Request, call.res as Response, call.next as NextFunction)
      requirePrivilegedHttpRoute(call.req as Request, call.res as Response, call.next as NextFunction)
      expect(call.res.statusCode).toBe(403)
    }
  })

  test("does not elevate read routes to the admin role", async () => {
    const regular = "r".repeat(32)
    process.env["SCG_API_KEYS"] = regular
    process.env["SCG_ADMIN_API_KEYS"] = "a".repeat(32)
    const { authMiddleware, requirePrivilegedHttpRoute } = await import("../middleware/auth")
    const call = createMockReqRes({ path: "/scg_resolve_symbol", authorization: `Bearer ${regular}` })

    authMiddleware(call.req as Request, call.res as Response, call.next as NextFunction)
    requirePrivilegedHttpRoute(call.req as Request, call.res as Response, call.next as NextFunction)

    expect(call.res.statusCode).toBeUndefined()
    expect(call.next).toHaveBeenCalledTimes(2)
  })

  test("rejects invalid production SIGHUP role reloads atomically", async () => {
    const oldRegular = "r".repeat(32)
    const oldAdmin = "a".repeat(32)
    process.env["NODE_ENV"] = "production"
    process.env["SCG_API_KEYS"] = oldRegular
    process.env["SCG_ADMIN_API_KEYS"] = oldAdmin
    const { hotReloadApiKeys, isRequestAuthenticated, isPresentedKeyAdmin } = await import("../middleware/auth")

    for (const candidate of [
      { regular: "n".repeat(32), admin: "" },
      { regular: "n".repeat(32), admin: "n".repeat(32) },
      { regular: "n".repeat(32), admin: "weak" },
      { regular: "weak", admin: "z".repeat(32) },
    ]) {
      process.env["SCG_API_KEYS"] = candidate.regular
      process.env["SCG_ADMIN_API_KEYS"] = candidate.admin
      expect(hotReloadApiKeys()).toBe(false)

      const oldRequest = createMockReqRes({ authorization: `Bearer ${oldRegular}` })
      expect(isRequestAuthenticated(oldRequest.req as Request)).toBe(true)
      expect(isPresentedKeyAdmin(oldAdmin)).toBe(true)
      const candidateRequest = createMockReqRes({ authorization: `Bearer ${candidate.regular}` })
      expect(isRequestAuthenticated(candidateRequest.req as Request)).toBe(false)
    }
  })

  test("escalates brute-force lockouts exponentially", async () => {
    jest.useFakeTimers()
    process.env["SCG_API_KEYS"] = "correct-key"
    const { authMiddleware, currentLockoutMsForIp } = await import("../middleware/auth")

    for (let i = 0; i < 5; i++) {
      const { req, res, next } = createMockReqRes({
        authorization: "Bearer wrong-key",
        ip: "10.0.0.9",
      })
      authMiddleware(req as Request, res as Response, next as NextFunction)
      expect(res.statusCode).toBe(403)
    }

    expect(currentLockoutMsForIp("10.0.0.9")).toBeGreaterThanOrEqual(30_000)

    const throttled = createMockReqRes({
      authorization: "Bearer wrong-key",
      ip: "10.0.0.9",
    })
    throttled.req.correlationId = "req-throttle"
    authMiddleware(throttled.req as Request, throttled.res as Response, throttled.next as NextFunction)
    expect(throttled.res.statusCode).toBe(429)
    expect(throttled.res.headers?.["Retry-After"]).toBe("30")
    expect(throttled.res.body).toEqual(expect.objectContaining({ correlationId: "req-throttle" }))

    jest.advanceTimersByTime(30_000)

    const nextFailure = createMockReqRes({
      authorization: "Bearer wrong-key",
      ip: "10.0.0.9",
    })
    authMiddleware(nextFailure.req as Request, nextFailure.res as Response, nextFailure.next as NextFunction)
    expect(nextFailure.res.statusCode).toBe(403)
    expect(currentLockoutMsForIp("10.0.0.9")).toBeGreaterThanOrEqual(60_000)
  })
})
