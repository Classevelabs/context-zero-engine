# Context Zero Engine — Benchmarks

## What was measured

An AI coding assistant is told: **"change this function."**

To do that without breaking things, it has to see three things:

1. the function itself
2. the code that function uses from other files
3. the code that calls the function

Getting those three things is the job. We measured what that job costs, **1,000
times**, on a real 375,000-line codebase (2,944 files), picking the functions at
random.

> A **token** is the unit AI providers charge for — roughly four characters of
> code. Fewer tokens means a cheaper, faster request that leaves more room for
> the assistant to actually think.

## Without ContextZero

The assistant searches for the function's name and opens the files that come
back. On a typical job:

| | |
|---|---:|
| Files it opens | 2 |
| Lines of code it has to read | 1,290 |
| **Tokens it pays for** | **11,866** |

## With ContextZero

It asks once and gets an answer already assembled:

| | |
|---|---:|
| Requests | 1 |
| Lines of code | 176 |
| **Tokens it pays for** | **2,630** |

### That is 78% fewer tokens for the same job

Across all 1,000 jobs: **28.2 million tokens down to 3.3 million — 8.5× less.**

## The important part: it costs less *without* knowing less

Cheap is easy. Returning nothing would be free. So both sides were given **the
same number of tokens to spend**, and we checked what actually came back
against the real source code on disk.

| Did the answer actually contain… | Without | With ContextZero |
|---|---:|---:|
| the function you asked to change | 1 time in 4 | **every time** |
| the code that calls it | 33% | **82%** |
| the helpers it uses from other files | almost never | **more than half** |
| a test that covers it | — | **1 job in 4** |

So the cheaper answer is also the more complete one. Not a trade.

**Why searching does so badly:** searching for a name finds the places that
*mention* it. The helper functions live in files that never mention it, so no
amount of searching will surface them. And at that budget you can afford about
two files — which are usually the wrong two.

The comparison is deliberately generous to searching: the search costs nothing,
choosing which files to open costs nothing, and it opens the best-matching files
first. It still loses.

## A real example

`commitRecoveryVaultGeneration` — an actual 99-line function that uses nine
things defined in other files.

**Searching:** only three files in the entire codebase mention it. Within the
budget the assistant opens one — the test file. It never sees the function, and
gets none of the nine helpers.

**ContextZero, one request:** the function, eight of its nine helpers with their
real code, the three functions that call it, the test that covers it, and its
input/output contract.

## A second codebase

The same measurement on a different repository — 2,443 files of scripts,
release tooling, a website and this engine's own source:

| One typical job | Without | With ContextZero |
|---|---:|---:|
| Files opened | 3 | 1 request |
| Lines of code | 2,088 | **43** |
| Tokens | 20,909 | **706** |

**97% fewer tokens**, and 29× less across the whole run. The function you asked
about is present every time, against 1 time in 15 by searching.

## What it still does badly

- **It finds just over half the helpers, not all of them.** Most of what it
  misses it simply has no record of — those are gaps in what the indexer
  captures, and each one that gets closed raises this number directly.
- **It finds a caller about four times in five.** On code with little internal
  calling — a folder of scripts — that drops, because there are genuinely fewer
  callers to find.
- **It links a covering test for about 1 job in 4** on the monorepo, where the
  tests are written as `it(...)` blocks the indexer now records as code. On a
  repository whose tests live elsewhere or follow other shapes, the figure is
  lower. This is still the weakest part of the system.
- **It usually uses only about a third of the space it is allowed.** When there
  is nothing more in the index to add, it stops rather than padding. Closing the
  gaps above is what turns that unused space into more answers.

## How it was measured

- **Same files for both sides.** Neither side is credited with reach the other
  did not have.
- **The answers were checked against the source on disk**, not against the
  engine's own database. The function's body is re-read from its file; its
  imports are resolved through the repository's own package files; a helper
  counts only if the code genuinely uses it.
- **Imports from outside the repository** (npm packages, Node built-ins) are
  excluded from both sides — neither approach can supply them.
- **Typical figures are medians**, so half the jobs cost less and half cost
  more. An average would be dragged around by whichever function happened to sit
  next to a very large file.
- **Repeatability.** Two independent 1,000-job runs agreed within a point on
  cost and within two points on helper coverage.
- **An earlier release quoted 33.9×.** That measurement counted duplicate copies
  of the same source tree that happened to sit in the benchmark folder, which
  made searching look about ten times more expensive than it is. The figures
  here come from both sides reading the same set of files.

Run it on your own repository once it is indexed:

```bash
node scripts/bench-context-quality.mjs 1000 /path/to/your/repo
```

It prints every number on this page, including the unflattering ones.

---

This document also records earlier author-reported benchmark runs: a
self-ingest run, a large-repository run on VS Code, and a multi-language run
across seven open-source projects. The benchmark scripts are in [`scripts/`](scripts/),
but the original raw machine-readable outputs and database snapshots are not
committed. Those older tables are historical claims and reproduction
targets, not independently verifiable release evidence or guaranteed field
performance.

**Read every reduction ratio below against the correction above.** Each of them
uses a grep-and-read baseline over whatever source files sat in the target
directory, and none of them checked that directory for duplicate copies of the
same tree. Where a repository was cloned clean the figure is unaffected; where
it was not, the baseline was inflated by however many copies were present. The
quality columns — implementation, interface, caller — are unaffected either way,
because they are properties of one capsule rather than of the pool it was
compared against.

**Hardware note.** All measurements were taken on a typical mid-range
developer laptop (quad-core x86-64), no server hardware and no clustering.
The historical runs below used PostgreSQL 16 and Node.js 22; the 2.6.0 ingest
figures above used PostgreSQL 17 and Node.js 24. Absolute timings and reduction
ratios can vary with corpus revision, selected symbols, disk, CPU, database
configuration, and current engine version.

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

## Current Ingest Throughput (2.6.0)

One full clean ingest, measured on 2026-08-20 against an empty database on the
hardware described above (PostgreSQL 17, Node.js 24):

| Measure | Value |
|---|---:|
| Files indexed | 2,637 |
| Files failed | 0 |
| Symbol versions | 29,791 |
| Structural relations | 34,818 |
| Snapshot status | `complete` |
| Wall clock | 5m 55s |

That is roughly **7.4 files per second end to end**, including symbol
extraction, relation resolution, dispatch resolution, lineage, effect
signatures, contract mining, and concept families. Ingest cost grows with
database size — the LSH change in 2.6.0 exists because the previous schema
slowed down as the index accumulated. Reproduce on your own corpus with
`npx ts-node scripts/bench-ingest.ts`.

The token-reduction tables below are older, from the versions named in each
heading. They were not re-run for 2.6.0.

---

## Historical Headline Results

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

## Fixture-Suite Effect-Analysis Accuracy (v2.5.0)

v2.5.0 replaced pattern-guessed external effects with a type-resolved
analyzer for TypeScript/JavaScript (every call resolved through the
compiler back to its source module). Accuracy is measured against a
hand-labeled fixture suite shipped in the repository — 22 functions across
8 external-effect categories, including the known failure traps of the old
analyzer (`Map.get`, `crypto.update`, effect words in comments and string
literals, calls on untyped local receivers, `WebSocket` as a type
annotation).

| Analyzer | Precision | Recall | F1 |
|---|---:|---:|---:|
| **v2.5 type-resolved** | **100%** | **100%** | **100%** |
| v2.3/v2.4 pattern-based (same suite) | 50.0% | 68.8% | 57.9% |

Honest framing:

- These are **fixture-suite numbers, not a field study**. The suite was
  designed alongside the analyzer; it includes the traps that made the old
  system lie, but the wild contains receiver shapes the suite doesn't.
- **Known recall limit by design**: calls on receivers the checker cannot
  trace to a module (`any`-typed parameters, dependency-injected clients
  without type annotations) produce **no** external-effect tag rather than
  a guess. Transitive propagation usually recovers these when the injected
  implementation lives in the same repository.
- Per-symbol behavioral profiles are now strictly **direct** (what the
  function's own body does); transitive effects are provenance-labeled
  (`direct` vs `transitive`, with hop counts) in effect signatures instead
  of being silently merged in.
- Reproduce: `npx ts-node scripts/effect-eval.ts` (add `--json` for
  machine-readable output). A CI test (`effect-resolver.test.ts`) pins the
  fixture suite so the table above cannot silently rot.

---

## Real-Project Benchmark Refresh (v2.5.0, 2026-07-10)

Author-reported token savings with the v2.5.0 engine on four real, private,
actively developed repositories (same methodology as above: `ceil(bytes/4)`
token policy, 8 real symbols per repository, exact-symbol grep-and-read
baseline vs one strict context capsule per symbol). Run on a freshly
compacted local PostgreSQL 16; the repositories are ClassEve production
codebases, not toy corpora.

Because those repositories and raw run outputs are private and absent from
this repository, these four rows cannot be independently reproduced from the
public checkout. They must not be used as release-gate evidence.

| Repository | Files indexed | Symbols | Exact-symbol baseline (tokens) | ContextZero (tokens) | Reduction | Savings |
|---|---:|---:|---:|---:|---:|---:|
| Engine self-ingest | 122 | 1,785 | 333,000 | 123,323 | **2.7x** | **63.0%** |
| Next.js website (~80 routes) | 141 | 492 | 239,868 | 64,804 | **3.7x** | **73.0%** |
| Cloudflare worker API | 46 | 384 | 4,127,654 | 111,289 | **37.1x** | **97.3%** |
| Desktop-app monorepo | 2,411 | 27,095 | 15,534,914 | 211,613 | **73.4x** | **98.6%** |

Consistent with the earlier runs: savings scale with repository size and
file granularity. The worker's outsized ratio comes from its shape — a few
very large route/webhook files, so the grep-and-read baseline pays for
entire multi-thousand-line files where a capsule pays for one symbol
neighborhood. Whole-source baselines for the same runs: 45.0x / 63.0x /
51.1x / 725.5x.

---

## Reproducing

All benchmark scripts are in the repository and run with `ts-node` against
your configured database (`DB_*` environment variables):

```bash
# Cost AND quality in one run: the numbers in the headline above
node scripts/bench-context-quality.mjs 400 /path/to/indexed/repo

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

Numbers on your machine may differ in both absolute terms and reduction ratios.
The token-counting policy is deterministic, but corpus versions, selected
symbols, ingestion results, and engine changes all affect the comparison.

If a reduction ratio comes back far larger than the ones in the headline, check
the baseline pool before believing it. `bench-context-quality.mjs` restricts both
sides to the files the index covers for exactly this reason; the older scripts
grep the directory as they find it, and a repository with worktrees, vendored
copies or a second checkout inside it will hand the baseline the same file
several times over.
