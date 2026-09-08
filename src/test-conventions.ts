/**
 * ContextZero — what a test file is called, per language.
 *
 * One predicate, because "is this a test?" was previously asked with a
 * JavaScript-only spelling — `.test.` / `.spec.` / `__tests__` — inside
 * `populateTestArtifacts`. Every language that names its tests differently
 * linked nothing: Go `_test.go`, Python `test_*.py`, Rust `tests/`, Java
 * `*Test.java`, Ruby `*_spec.rb`, C# `*Tests.cs`, PHP `*Test.php`, Swift
 * `*Tests.swift`. Measured across an 18-repository sweep, 14 repositories
 * linked zero tests and `scg_get_tests` returned the same empty answer for all.
 *
 * The rules below are the ones each toolchain enforces itself — `go test` only
 * compiles `_test.go`, pytest only collects `test_*.py` / `*_test.py`, Maven
 * and Gradle only run `src/test/`, cargo only runs `<crate>/tests/*.rs`.
 * Matching what the runner matches is why this is a convention table and not a
 * guess.
 *
 * Being wrong in either direction costs something, so neither rule is loose:
 *  - a false negative loses the language its test links entirely;
 *  - a false positive takes a library symbol OUT of the pool a test can link
 *    to. A bare `test/` segment anywhere is exactly that mistake: Django ships
 *    `django/test/client.py` as public library code, not as its test suite,
 *    which lives in a separate top-level `tests/`.
 */

/** Directory shapes that are unambiguous wherever they appear. */
const UNAMBIGUOUS_TEST_DIRS = ["__tests__", "__test__", "src/test/", "src/tests/"]

/** Directory names that mean "tests" only at the root of the tree. */
const ROOT_TEST_DIRS = new Set(["test", "tests", "spec", "specs", "testing"])

/**
 * Filename shapes, matched against the basename with its original case: the
 * Java, C#, Swift and PHP conventions are capitalised (`LoggerTests.cs`), and
 * lower-casing the path first silently disabled all four.
 */
const TEST_FILENAME_PATTERNS: RegExp[] = [
  // JavaScript / TypeScript: foo.test.ts, foo.spec.tsx
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  // Go: foo_test.go — the only spelling `go test` compiles.
  /_test\.go$/,
  // Python: test_foo.py, foo_test.py, conftest.py — what pytest collects.
  /^test_.*\.py$/,
  /_test\.py$/,
  /^conftest\.py$/,
  // Ruby: foo_spec.rb (RSpec), foo_test.rb (minitest).
  /_(spec|test)\.rb$/,
  // Java / Kotlin: FooTest.java, FooTests.kt, FooIT.java (failsafe).
  /(Test|Tests|IT|TestCase)\.(java|kt|kts)$/,
  // C#: FooTest.cs, FooTests.cs.
  /(Test|Tests)\.cs$/,
  // PHP: FooTest.php — the PHPUnit convention.
  /Test\.php$/,
  // Swift: FooTests.swift, FooTest.swift.
  /(Test|Tests)\.swift$/,
  // C / C++: foo_test.cc, foo-test.cc, test_foo.cpp. No compiler enforces a
  // spelling here the way `go test` does, and both separators are in wide use
  // (fmt names every one of its tests `format-test.cc`, `chrono-test.cc`).
  /[-_]test\.(c|cc|cpp|cxx|h|hpp)$/,
  /^test[-_].*\.(c|cc|cpp|cxx)$/,
  // Rust: an inline `#[cfg(test)]` module cannot be seen from a path; the
  // integration-test directory is handled by the cargo rule below.
  /_test\.rs$/,
  // Bash: foo_test.sh, test_foo.sh.
  /_test\.sh$/,
  /^test_.*\.sh$/,
]

/** Forward slashes, no leading `./`. Case is preserved. */
function normalize(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "")
}

/**
 * Whether `filePath` is a test file under any supported language's convention.
 *
 * Path-based on purpose: it runs over every indexed file and must not parse.
 */
export function isTestFilePath(filePath: string): boolean {
  if (!filePath) return false
  const normalized = normalize(filePath)
  const lower = normalized.toLowerCase()
  const segments = lower.split("/").filter(Boolean)

  for (const dir of UNAMBIGUOUS_TEST_DIRS) {
    if (`/${lower}/`.includes(`/${dir.toLowerCase().replace(/^\/|\/$/g, "")}/`)) return true
  }

  // A root-level `tests/` is the test suite; a nested one is usually a package
  // that happens to be named `test` (django/test, rails' actionpack/test).
  if (segments.length > 1 && ROOT_TEST_DIRS.has(segments[0]!)) return true

  // cargo runs `<crate>/tests/*.rs` as integration tests, so for Rust the
  // directory carries the meaning at any depth.
  if (lower.endsWith(".rs") && segments.includes("tests")) return true

  const basename = normalized.slice(normalized.lastIndexOf("/") + 1)
  return TEST_FILENAME_PATTERNS.some((pattern) => pattern.test(basename))
}

/**
 * Best-effort runner name for a test file, used only as a label on the stored
 * artifact. "unknown" is an honest answer and is returned whenever the path
 * does not identify one.
 */
export function detectTestFramework(filePath: string): string {
  const normalized = normalize(filePath)
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1)

  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(basename)) return "jest"
  if (/_test\.go$/.test(basename)) return "go test"
  if (/^test_.*\.py$/.test(basename) || /_test\.py$/.test(basename) || basename === "conftest.py") return "pytest"
  if (/_spec\.rb$/.test(basename)) return "rspec"
  if (/_test\.rb$/.test(basename)) return "minitest"
  if (/(Test|Tests|IT|TestCase)\.java$/.test(basename)) return "junit"
  if (/(Test|Tests)\.(kt|kts)$/.test(basename)) return "kotlin.test"
  if (/(Test|Tests)\.cs$/.test(basename)) return "dotnet test"
  if (/Test\.php$/.test(basename)) return "phpunit"
  if (/(Test|Tests)\.swift$/.test(basename)) return "xctest"
  if (normalized.endsWith(".rs")) return "cargo test"
  if (/[-_]test\.(c|cc|cpp|cxx|h|hpp)$/.test(basename) || /^test[-_].*\.(c|cc|cpp|cxx)$/.test(basename)) return "ctest"
  if (/_test\.sh$/.test(basename) || /^test_.*\.sh$/.test(basename)) return "shell"
  if (normalized.endsWith(".py")) return "pytest"
  if (/\.[cm]?[jt]sx?$/.test(basename)) return "jest"
  if (normalized.endsWith(".rb")) return "minitest"
  return "unknown"
}
