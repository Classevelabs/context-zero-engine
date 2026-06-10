# Context Zero Engine — Benchmarks

This document consolidates the benchmark runs used to validate ContextZero:
a self-ingest run on the engine's own repository, a large-repository run on
VS Code, and a multi-language run across seven well-known open-source
projects. Every number here comes from a recorded run of the benchmark
scripts in [`scripts/`](scripts/), and anyone can reproduce the methodology
on their own machine.

**Hardware note.** All measurements were taken on a typical mid-range
developer laptop (quad-core x86-64) with a local PostgreSQL 16 instance and
Node.js 22 — no server hardware, no clustering. Absolute timings will vary
with disk, CPU, and database configuration; the reduction ratios are the
durable signal.

---

## Methodology

- **Token policy**: tokens are estimated as `ceil(bytes / 4)`. This is a
  deterministic approximation chosen for repeatability — exact tokenizer
  counts differ by model, but the ratios hold.
- **Whole-source baseline**: read every source/document file in the target
  repository into context.
- **Exact-symbol baseline**: find every source/document file containing the
  exact symbol name (grep) and read those files into context. This is the
  stricter, more realistic baseline and the one to pay attention to.
- **ContextZero**: compile one strict context capsule for the same symbol
  (source + dependencies + contracts + effects, token-budgeted).
- A human or agent with good judgment could read fewer files than the
  baseline — or far more when manually tracing transitive dependencies.
  The baselines are defined so the comparison is mechanical and re-runnable.

---

## Headline Results

| Benchmark | Scale | Exact-symbol reduction | Exact-symbol savings | Whole-source reduction |
|---|---|---:|---:|---:|
| Engine self-ingest (8 tasks) | 105 files, 7,753 symbols | **2.71x** | **63.1%** | — |
| VS Code (12 tasks) | 10,386 files, 125,777 symbol versions | **12.44x** | **91.96%** | 1,618x |
| Multi-language, 7 repos (21 tasks) | Django, Prometheus, Tokio, Commons Lang, Serilog, OkHttp, Alamofire | **12.86x** | **92.2%** | 134x (99.26%) |

Savings scale with repository size: the bigger the codebase, the more a
targeted capsule beats reading files. On small repositories or
single-file symbols the gain is modest, and in a few cases (noted below)
a capsule can be larger than the single file it replaces.

---

## Benchmark 1 — Engine Self-Ingest

ContextZero ingesting and analyzing its own repository.

| Metric | Value |
|---|---|
| Source/document files | 139 (72,284 lines, ~3.0 MB) |
| Files indexed | 105 |
| Symbols extracted | 7,753 |
| Symbol versions indexed | 5,017 |
| Relations extracted | 4,568 |
| Behavior hints | 1,288 |
| Contract hints | 716 |
| Deep contracts mined | 6,841 |
| Effect signatures | 5,017 |
| Invariants indexed | 7,889 |
| Dispatch edges | 573 resolved / 466 indexed |
| Concept families | 9 |
| Ingestion wall time | ~47 s |

### Token savings (8 real symbols, exact-symbol baseline)

| Symbol | Baseline tokens | ContextZero tokens | Reduction | Savings |
|---|---:|---:|---:|---:|
| DeepContractSynthesizer | 65,793 | 24,711 | 2.66x | 62.4% |
| Ingestor | 44,945 | 21,430 | 2.10x | 52.3% |
| DispatchResolver | 53,214 | 19,081 | 2.79x | 64.1% |
| RuntimeEvidenceEngine | 36,376 | 16,545 | 2.20x | 54.5% |
| ConceptFamilyEngine | 49,666 | 15,827 | 3.14x | 68.1% |
| EffectEngine | 52,151 | 14,154 | 3.68x | 72.9% |
| CapsuleCompiler | 17,758 | 13,298 | 1.34x | 25.1% |
| SemanticEngine | 53,543 | 12,907 | 4.15x | 75.9% |
| **Total** | **373,446** | **137,953** | **2.71x** | **63.1%** |

### Query latency (self-ingest snapshot)

| Query | Time | Output size |
|---|---:|---:|
| Health check | 3 ms | 123 B |
| Blast radius (depth 2) | 102 ms | 34 KB |
| Strict context capsule | 62 ms | 99 KB |

MCP compatibility: stdio bridge starts, lists all 61 tools, handshake +
`tools/list` in under 1 s.

---

## Benchmark 2 — VS Code (Large Repository)

Target: `https://github.com/microsoft/vscode.git` at commit
`eb840b14a01b070781ad36f6fa4fcc495e1543a6` — about 12,400 source/document
files and 4.1 M lines.

| Metric | Value |
|---|---|
| Source/document estimated tokens | 40,412,590 |
| Files indexed | 10,386 |
| Symbols extracted | 130,714 |
| Symbol versions indexed | 125,777 |
| Structural relations indexed | 230,853 |
| Deep contracts mined | 458,356 |
| Invariants indexed | 479,920 |
| Class hierarchy rows | 35,052 |
| Ingestion wall time | ~37 min (single process) |

### Token savings (12 real symbols)

| Totals | Whole-source | Exact-symbol | ContextZero |
|---|---:|---:|---:|
| Tokens | 484,951,080 | 3,726,330 | **299,569** |
| Reduction vs ContextZero | 1,618.83x | 12.44x | — |
| Savings | 99.94% | **91.96%** | — |

Representative tasks: `CommandCenter` in `extensions/git/src/commands.ts`
(5.67x, 82.4% savings), `completionSpec` in the terminal-suggest extension
(12.44x, 92.0%), and TextMate-grammar data symbols spread across dozens of
files (32–41x where the symbol name appears in many places).

Capsule queries against the 125k-symbol snapshot stayed fast: blast radius
in 164 ms, strict capsule in 49 ms.

---

## Benchmark 3 — Multi-Language (7 Repositories)

End-to-end ingest of cloned public repositories, then 3 real symbol tasks
per repository against the exact-symbol baseline.

| Repo | Language | Files indexed | Symbol versions | Relations | Exact reduction | Exact savings |
|---|---|---:|---:|---:|---:|---:|
| Django | Python | 2,955 | 42,500 | 35,342 | 7.99x | 87.5% |
| Prometheus | Go (+TS UI) | 967 | 12,360 | 25,163 | 27.97x | 96.4% |
| Tokio | Rust | 775 | 9,150 | 7,184 | 27.09x | 96.3% |
| Apache Commons Lang | Java | 606 | 11,628 | 7,210 | 22.57x | 95.6% |
| Serilog | C# | 215 | 1,360 | 355 | 4.74x | 78.9% |
| OkHttp | Kotlin/Java | 644 | 1,272 | 472 | 1.43x | 29.9% |
| Alamofire | Swift | 108 | 1,968 | 3,888 | 1.25x | 20.0% |

**Aggregate across all 21 tasks**: 5,088,582 baseline tokens vs 395,687
ContextZero tokens — **12.86x fewer tokens (92.2% savings)**, and **99.26%
savings (134x)** against whole-source loading.

### Adapter validation

Every advertised language path passes a symbol/relation extraction check:
TypeScript and JavaScript (TypeScript Compiler API), Python (LibCST
subprocess), and C/C++, Go, Rust, Java, C#, Ruby, Kotlin, Swift, PHP, and
Bash (tree-sitter universal adapter).

### Honest caveats from this run

- **Small, self-contained targets gain little.** The OkHttp and Alamofire
  tasks targeted large test classes that live in one or two files; a strict
  capsule has a size floor, so savings were small — and for one
  single-file Prometheus symbol (`getRawProtobufCorpus`) the capsule was
  actually *larger* than the file (0.6x). ContextZero pays off on symbols
  whose context is spread across a codebase, which is the common case in
  real maintenance work.
- **Laravel and nvm** ingested without errors but produced no scoreable
  symbol targets in the recorded run, so no token-savings claims are made
  for PHP and Bash at repository scale (adapter validation passes for
  both).
- **Spring Framework, Rails, and Bitcoin Core** runs were stopped before
  completion (one timed out after about an hour; two were interrupted), so
  no numbers are claimed for them. Java, Ruby, and C++ adapter validation
  passes.

---

## Analysis Quality Snapshot

From an instrumented full-analysis run on the engine's own codebase:

| Aspect | Result |
|---|---|
| Behavioral purity distribution | 95.2% `pure`, 3.2% `read_only`, 1.3% `read_write`, 0.3% `side_effecting` — every symbol profiled |
| Capsule budget utilization | `standard` mode: 99.96% of an 8,000-token budget; `strict`: 99%+ of 20,000 |
| Profile cache hit rate | 97.1% under analytical workloads |
| Semantic search scores | Calibrated TF-IDF cosine scores (e.g. 0.586 for "database transaction with rollback") — no inflated confidence |
| Parse errors | 0 |

---

## Reproducing

All benchmark scripts are in the repository and run with `ts-node` against
your configured database (`DB_*` environment variables):

```bash
# Full single-repo benchmark report (corpus, ingest, queries, token savings)
npx ts-node scripts/bench-report.ts /path/to/repo ./BENCHMARK_REPORT.md

# Head-to-head: grep+read vs capsule for N random symbols
npx ts-node scripts/bench-head-to-head.ts

# Ingest-only timing
npx ts-node scripts/bench-ingest.ts

# Per-mode capsule compilation measurements
npx ts-node scripts/bench-capsule.ts

# Multi-language suite (expects cloned repos under ./benchmarks)
npx ts-node scripts/multi-language-bench-report.ts ./benchmarks
```

Numbers on your machine will differ in absolute terms (disk, CPU,
PostgreSQL configuration); the token-reduction ratios should be closely
reproducible because the token policy is deterministic.
