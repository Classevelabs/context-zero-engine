const { execFileSync } = jest.requireActual("child_process") as typeof import("child_process")

describe("universal tree-sitter adapter", () => {
  test("extracts script, mobile, and CUDA symbols in a real Node process", () => {
    const script = `
            require('ts-node/register');
            const { extractWithTreeSitter } = require('./src/adapters/universal');
            const cases = {
                bash: ['deploy.sh', 'deploy() {\\n  curl https://example.com\\n  echo "done" > out.txt\\n}\\n'],
                php: ['sample.php', '<?php function add($a, $b) { return $a + $b; } class Box { public function get() { return 1; } }'],
                swift: ['Client.swift', 'final class Client { func fetch() async throws { _ = URLSession.shared } }'],
                cpp: ['kernel.cu', '__global__ void saxpy(float *y) { y[0] = 1.0f; }\\nint host_add(int a, int b) { return a + b; }\\n'],
            };
            const output = {};
            for (const [language, [file, source]] of Object.entries(cases)) {
                const result = extractWithTreeSitter(file, source, language);
                output[language] = {
                    symbols: result.symbols.map(symbol => symbol.canonical_name),
                    behaviorHints: result.behavior_hints.map(hint => hint.detail),
                    uncertaintyFlags: result.uncertainty_flags,
                };
            }
            const oversized = extractWithTreeSitter('oversized.go', 'x'.repeat(5 * 1024 * 1024 + 1), 'go');
            output.oversized = {
                symbols: oversized.symbols,
                behaviorHints: oversized.behavior_hints,
                uncertaintyFlags: oversized.uncertainty_flags,
                parseConfidence: oversized.parse_confidence,
            };
            process.stdout.write(JSON.stringify(output));
        `

    const raw = execFileSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, LOG_LEVEL: "fatal" },
    })
    const output = JSON.parse(raw) as Record<
      string,
      { symbols: string[]; behaviorHints: string[]; uncertaintyFlags: string[]; parseConfidence?: number }
    >

    expect(output["bash"]?.symbols).toContain("deploy")
    expect(output["bash"]?.behaviorHints).toContain("bash_curl")
    expect(output["php"]?.symbols).toEqual(expect.arrayContaining(["add", "Box", "get"]))
    expect(output["swift"]?.symbols).toEqual(expect.arrayContaining(["Client", "fetch"]))
    expect(output["swift"]?.behaviorHints).toContain("swift_urlsession")
    expect(output["cpp"]?.symbols).toEqual(expect.arrayContaining(["saxpy", "host_add"]))
    expect(output["oversized"]).toMatchObject({
      symbols: [],
      uncertaintyFlags: ["source_too_large"],
      parseConfidence: 0,
    })
  })
})
