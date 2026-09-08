import { isTestFilePath, detectTestFramework } from "../test-conventions"

/**
 * The predicate has to be right in both directions. A miss costs a language
 * every test link it could have had; a false hit takes library code out of the
 * pool a test is allowed to link to.
 */
describe("isTestFilePath — what each toolchain actually runs", () => {
  const TESTS: Array<[string, string]> = [
    ["jest", "src/__tests__/index.test.ts"],
    ["jest spec", "src/utils.spec.tsx"],
    ["go", "internal/config/config_test.go"],
    ["pytest prefix", "tests/auth_tests/test_views.py"],
    ["pytest suffix", "src/pkg/utils_test.py"],
    ["pytest conftest", "tests/conftest.py"],
    ["rspec", "spec/models/user_spec.rb"],
    ["minitest", "test/helpers_test.rb"],
    ["junit", "okhttp/src/test/java/okhttp3/CacheTest.java"],
    ["kotlin", "okhttp/src/test/java/okhttp3/DispatcherTest.kt"],
    ["dotnet", "test/Serilog.Tests/LoggerTests.cs"],
    ["phpunit", "tests/Handler/CurlHandlerTest.php"],
    ["xctest", "Tests/AlamofireTests/SessionTests.swift"],
    ["ctest", "test/format-test.cc"],
    ["cargo integration", "tokio/tests/rt_common.rs"],
    ["shell", "scripts/deploy_test.sh"],
  ]

  test.each(TESTS)("recognises %s: %s", (_label, filePath) => {
    expect(isTestFilePath(filePath)).toBe(true)
  })

  /**
   * `django/test/` ships as public library code — `django.test.Client` is what
   * users import. A bare `test/` segment anywhere would classify it as a test
   * suite and remove it from the linkable pool, which is why the directory rule
   * only fires at the root of the tree.
   */
  const LIBRARY: Array<[string, string]> = [
    ["Django's shipped test utilities", "django/test/client.py"],
    ["Django's test runner library", "django/test/runner.py"],
    ["ordinary library source", "django/db/models/query.py"],
    ["a name merely containing 'test'", "src/contest/protest.py"],
    ["'latest' is not 'test'", "pkg/latest/version.go"],
    ["'Attest' is not 'Test'", "src/Attest.cs"],
    ["testdata helper, not a test", "internal/testdata_loader.go"],
    ["manifest is not a test", "src/manifest.php"],
  ]

  test.each(LIBRARY)("does not claim %s: %s", (_label, filePath) => {
    expect(isTestFilePath(filePath)).toBe(false)
  })

  test("an empty path is not a test", () => {
    expect(isTestFilePath("")).toBe(false)
  })

  test("Windows separators are handled", () => {
    expect(isTestFilePath("src\\__tests__\\index.test.ts")).toBe(true)
    expect(isTestFilePath("django\\test\\client.py")).toBe(false)
  })
})

describe("detectTestFramework", () => {
  const CASES: Array<[string, string]> = [
    ["src/index.test.ts", "jest"],
    ["internal/config_test.go", "go test"],
    ["tests/test_views.py", "pytest"],
    ["spec/user_spec.rb", "rspec"],
    ["test/helpers_test.rb", "minitest"],
    ["src/test/java/CacheTest.java", "junit"],
    ["test/LoggerTests.cs", "dotnet test"],
    ["tests/CurlHandlerTest.php", "phpunit"],
    ["Tests/SessionTests.swift", "xctest"],
    ["tokio/tests/rt_common.rs", "cargo test"],
    ["test/format-test.cc", "ctest"],
  ]

  test.each(CASES)("%s is %s", (filePath, expected) => {
    expect(detectTestFramework(filePath)).toBe(expected)
  })
})
