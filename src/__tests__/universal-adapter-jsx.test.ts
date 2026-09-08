/**
 * Regression guard — the universal (tree-sitter) adapter parses JSX.
 *
 * The workspace-native path routes .tsx/.jsx/.js through this adapter. It used
 * the `.typescript` tree-sitter sub-grammar for them, which cannot read JSX, so
 * every React file became ERROR nodes: components and their handlers emitted no
 * symbols and parse_confidence collapsed — silently, on the flagship language.
 * The fix selects the `.tsx` (JSX) grammar for .tsx/.jsx/.js while keeping the
 * `.typescript` grammar for plain .ts (whose `<T>expr` assertions the .tsx
 * grammar would misread as JSX). All three cases below are asserted.
 *
 * Runs in a real Node process because the native tree-sitter grammars do not
 * load under the jest module environment (same pattern as universal-adapter.test.ts).
 */

const { execFileSync } = jest.requireActual("child_process") as typeof import("child_process")

describe("universal adapter — JSX", () => {
  test("extracts symbols from .tsx and .jsx, and keeps .ts angle-bracket assertions", () => {
    const cases: Record<string, [string, string, string]> = {
      // .tsx: TypeScript + JSX. Needs the JSX grammar.
      tsx: [
        "Button.tsx",
        "typescript",
        [
          'import { useState } from "react"',
          "export function Button(props: { label: string }) {",
          "  const [n, setN] = useState(0)",
          "  const onClick = () => setN(n + 1)",
          "  return <button onClick={onClick}>{props.label}: {n}</button>",
          "}",
          "export function Panel() {",
          '  return <div><Button label="ok" /></div>',
          "}",
        ].join("\n"),
      ],
      // .jsx: JavaScript + JSX. Routed through the "javascript" key.
      jsx: [
        "Card.jsx",
        "javascript",
        [
          'import { useState } from "react"',
          "export function Card(props) {",
          "  const [open, setOpen] = useState(false)",
          "  return <section onClick={() => setOpen(!open)}>{open ? props.body : props.title}</section>",
          "}",
        ].join("\n"),
      ],
      // .ts: plain TypeScript with an angle-bracket type assertion, which is
      // legal in .ts but a JSX open-tag under the .tsx grammar. Must still parse.
      ts: [
        "assert.ts",
        "typescript",
        ["export function pick(x: unknown): string {", "  return (<string>x).trim()", "}"].join("\n"),
      ],
    }

    const script = `
      require('ts-node/register');
      const { extractWithTreeSitter } = require('./src/adapters/universal');
      const cases = ${JSON.stringify(cases)};
      const output = {};
      for (const key of Object.keys(cases)) {
        const [file, lang, src] = cases[key];
        const r = extractWithTreeSitter(file, src, lang);
        output[key] = {
          symbols: r.symbols.map(s => s.canonical_name),
          parseConfidence: r.parse_confidence,
          uncertaintyFlags: r.uncertainty_flags,
        };
      }
      process.stdout.write(JSON.stringify(output));
    `

    const raw = execFileSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, LOG_LEVEL: "fatal" },
    })
    const out = JSON.parse(raw) as Record<
      string,
      { symbols: string[]; parseConfidence: number; uncertaintyFlags: string[] }
    >

    // .tsx — React component + sibling component must be seen, cleanly parsed.
    expect(out["tsx"]?.symbols).toEqual(expect.arrayContaining(["Button", "Panel"]))
    expect(out["tsx"]?.parseConfidence ?? 0).toBeGreaterThan(0.9)

    // .jsx — JS component must be seen, cleanly parsed.
    expect(out["jsx"]?.symbols).toEqual(expect.arrayContaining(["Card"]))
    expect(out["jsx"]?.parseConfidence ?? 0).toBeGreaterThan(0.9)

    // .ts — the angle-bracket assertion must not be misread as JSX.
    expect(out["ts"]?.symbols).toEqual(expect.arrayContaining(["pick"]))
    expect(out["ts"]?.parseConfidence ?? 0).toBeGreaterThan(0.9)
  })
})
