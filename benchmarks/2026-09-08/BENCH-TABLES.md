# Benchmark sweep — 2026-09-08

Every repository is a public checkout pinned by commit in `.bench-corpus/corpus.lock.tsv`. Reproduce with:

```bash
node scripts/bench-corpus.mjs      # clone and pin the corpus
node scripts/bench-sweep.mjs       # ingest and measure every repository
node scripts/bench-tables.mjs      # render this file from the JSON
```

18 repositories, 955 tasks, **0 failed**. The job is "change this function": the function, what it uses from other files, and what calls it. The capsule gets a 8,000-token budget. The baseline greps for the symbol and reads up to 25 of the files that mention it, best-first, charged nothing for the search or for deciding what to open.

## 1. What it saves

Median tokens for one job. `vs reading` is against the grep-and-read baseline; `vs oracle` is against a
baseline given perfect foreknowledge of which files it needs — the honest floor, and the ratio worth quoting.

| Repository | Language | Commit | Reading | Capsule | Saved | vs reading | vs oracle |
|---|---|---|---:|---:|---:|---:|---:|
| alamofire | swift | `0455bfb650` | 13,321 | 2,221 | 83.3% | 5.4x | 4.3x |
| django | python | `e2a3da1426` | 16,296 | 1,757 | 89.2% | 16.5x | 5.1x |
| engine-ts | typescript | `local` | 27,135 | 3,147 | 88.4% | 9x | 6.7x |
| express | javascript | `023767fe98` | 926 | 428 | 53.8% | 2.6x | 1.9x |
| flask | python | `d318b68347` | 16,775 | 1,437 | 91.4% | 14.2x | 7.2x |
| fmt | cpp | `44f2c7ae01` | 3,951 | 1,233 | 68.8% | 13.8x | 11.7x |
| gh-cli | go | `0d121e8c31` | 8,581 | 2,513 | 70.7% | 5x | 2.8x |
| gin | go | `dcaa4296d1` | 6,201 | 1,927 | 68.9% | 4.5x | 3.8x |
| gson | java | `b3f4ca2008` | 8,908 | 2,157 | 75.8% | 7.3x | 2.3x |
| guzzle | php | `9393947095` | 29,862 | 2,043 | 93.2% | 15.1x | 10.4x |
| nest | typescript | `39fbddae51` | 6,702 | 2,839 | 57.6% | 2.9x | 1.5x |
| okhttp | java | `dfcfab3824` | 11,577 | 1,150 | 90.1% | 9.4x | 7.1x |
| react | javascript | `9b7a0d4029` | 40,075 | 2,597 | 93.5% | 14.3x | 9.1x |
| ripgrep | rust | `3fce3b5bb0` | 35,069 | 1,410 | 96% | 15.6x | 12.5x |
| serilog | csharp | `49b5339ce8` | 7,634 | 1,294 | 83% | 9.1x | 1.7x |
| sinatra | ruby | `cb22afd790` | 4,420 | 879 | 80.1% | 10.5x | 9.3x |
| tokio | rust | `13d4800fb7` | 5,867 | 1,217 | 79.3% | 6.1x | 3.8x |
| zod | typescript | `804e0f5227` | 36,624 | 2,233 | 93.9% | 14.6x | 12.2x |

**Medians:** 83.3% of tokens saved, 9.4x fewer than reading files, 6.7x fewer than an oracle that already knows which files to open.

## 2. Where it does not save

A capsule carries callers, effects and contracts that the source file does not, so on a short symbol in a
small file that overhead can cost more than simply reading. These are the cases where that happens.

| Repository | Tasks | Costs more than reading | Costs more than the oracle | Worst comparable case | Reading found nothing | Over budget |
|---|---:|---:|---:|---:|---:|---:|
| alamofire | 60 | 4 | 2 | 1.72x | 2 | 0 |
| django | 60 | 2 | 5 | 1.2x | 0 | 0 |
| engine-ts | 60 | 0 | 1 | 0.99x | 0 | 0 |
| express | 3 | 0 | 0 | 1x | 0 | 0 |
| flask | 60 | 0 | 1 | 0.79x | 0 | 0 |
| fmt | 60 | 25 | 2 | 1.39x | 24 | 0 |
| gh-cli | 60 | 4 | 13 | 1.66x | 0 | 0 |
| gin | 23 | 3 | 4 | 2.36x | 0 | 0 |
| gson | 60 | 4 | 19 | 2.1x | 0 | 0 |
| guzzle | 60 | 0 | 4 | 0.52x | 0 | 0 |
| nest | 60 | 14 | 22 | 13.14x | 0 | 0 |
| okhttp | 60 | 9 | 7 | 5.68x | 3 | 0 |
| react | 60 | 9 | 3 | 4.1x | 0 | 0 |
| ripgrep | 60 | 1 | 1 | 0.86x | 1 | 0 |
| serilog | 60 | 2 | 28 | 1.66x | 0 | 0 |
| sinatra | 29 | 5 | 3 | 0.42x | 5 | 0 |
| tokio | 60 | 15 | 7 | 4.79x | 11 | 0 |
| zod | 60 | 4 | 5 | 4.09x | 0 | 0 |

Across all 955 tasks the capsule cost more than reading **101 times** (10.6%), and more than the oracle **127 times** (13.3%).

## 3. Does the smaller context still carry the work

Both sides get the same number of tokens to spend. Ground truth is read off disk, not taken from the graph.
`Deps scored` is the size of the population the recall column rests on; a small count is a thin measurement.

| Repository | Deps scored | Recall | Has implementation | Has caller | Linked test | Facts per 1k tokens |
|---|---:|---:|---:|---:|---:|---:|
| alamofire | 0 | 0% | 100% vs 3.3% | 10% vs 0% | 3.3% | 0.74 vs 0.02 |
| django | 156 | 69.4% | 100% vs 16.7% | 50% vs 35% | 30% | 1.47 vs 0.3 |
| engine-ts | 92 | 41.6% | 100% vs 5% | 90% vs 25% | 30% | 1.02 vs 0.1 |
| express | 0 | 0% | 100% vs 0% | 0% vs 0% | 33.3% | 4.17 vs 0 |
| flask | 97 | 28.9% | 100% vs 1.7% | 53.3% vs 38.3% | 48.3% | 1.72 vs 0.33 |
| fmt | 0 | 0% | 100% vs 1.7% | 30% vs 6.7% | 5% | 1.43 vs 0.06 |
| gh-cli | 112 | 72.3% | 100% vs 33.3% | 81.7% vs 43.3% | 38.3% | 1.35 vs 0.36 |
| gin | 4 | 50% | 100% vs 34.8% | 91.3% vs 13% | 52.2% | 1.25 vs 0.35 |
| gson | 0 | 0% | 100% vs 28.3% | 40% vs 26.7% | 18.3% | 1.01 vs 0.35 |
| guzzle | 0 | 0% | 100% vs 11.7% | 93.3% vs 16.7% | 28.3% | 1.13 vs 0.15 |
| nest | 283 | 74.5% | 100% vs 53.3% | 76.7% vs 65% | 50% | 1.67 vs 0.49 |
| okhttp | 0 | 0% | 100% vs 18.3% | 16.7% vs 5% | 3.3% | 1.15 vs 0.22 |
| react | 165 | 70.1% | 100% vs 25% | 68.3% vs 38.3% | 5% | 1.33 vs 0.26 |
| ripgrep | 0 | 0% | 100% vs 6.7% | 26.7% vs 8.3% | 0% | 1.07 vs 0.1 |
| serilog | 0 | 0% | 100% vs 38.3% | 30% vs 38.3% | 45% | 1.42 vs 0.71 |
| sinatra | 0 | 0% | 100% vs 6.9% | 41.4% vs 27.6% | 27.6% | 2.16 vs 0.37 |
| tokio | 0 | 0% | 100% vs 10% | 40% vs 18.3% | 10% | 1.58 vs 0.25 |
| zod | 155 | 57.6% | 100% vs 10% | 75% vs 20% | 13.3% | 1.54 vs 0.15 |

## 4. What it costs to run

Indexing is paid once, then incrementally. The database is the price of not re-reading files.

| Repository | Files | Symbols | Relations | Cold index | Re-index | One-file edit | Peak RSS | Database | Source |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| alamofire | 108 | 2,314 | 4,852 | 67.3 s | 0.4 s | 2.1 s | 353.7 MB | 51.0 MB | 2.1 MB |
| django | 3,043 | 45,942 | 68,965 | 560.5 s | 5.6 s | 47.5 s | 928.5 MB | 407.1 MB | 20.3 MB |
| engine-ts | 176 | 6,576 | 15,564 | 64.8 s | 0.5 s | 7.3 s | 405.6 MB | 74.2 MB | 3.0 MB |
| express | 141 | 1,860 | 3,841 | 12.6 s | 0.2 s | 3.4 s | 238.2 MB | 26.9 MB | 0.5 MB |
| flask | 83 | 1,660 | 1,688 | 17.2 s | 0.1 s | 3.0 s | 245.0 MB | 25.8 MB | 0.6 MB |
| fmt | 81 | 4,087 | 4,920 | 45.6 s | 0.2 s | 7.7 s | 339.5 MB | 50.6 MB | 2.6 MB |
| gh-cli | 937 | 8,822 | 26,030 | 114.6 s | 2.3 s | 4.2 s | 435.6 MB | 99.9 MB | 8.0 MB |
| gin | 99 | 1,813 | 3,788 | 12.4 s | 0.2 s | 2.1 s | 240.7 MB | 28.1 MB | 0.7 MB |
| gson | 264 | 4,994 | 4,118 | 42.3 s | 0.6 s | 4.6 s | 393.4 MB | 60.4 MB | 2.0 MB |
| guzzle | 136 | 3,329 | 6,316 | 27.5 s | 0.3 s | 5.9 s | 347.0 MB | 53.5 MB | 2.3 MB |
| nest | 1,842 | 15,484 | 31,998 | 190.1 s | 10.9 s | 11.1 s | 662.1 MB | 141.7 MB | 3.9 MB |
| okhttp | 692 | 10,741 | 16,370 | 65.7 s | 1.1 s | 4.5 s | 463.6 MB | 107.0 MB | 4.5 MB |
| react | 4,575 | 49,545 | 128,424 | 361.5 s | 7.3 s | 26.6 s | 1118.0 MB | 408.0 MB | 25.0 MB |
| ripgrep | 113 | 3,788 | 6,347 | 26.5 s | 0.3 s | 4.4 s | 308.8 MB | 48.2 MB | 1.9 MB |
| serilog | 216 | 1,575 | 1,059 | 14.6 s | 0.4 s | 1.2 s | 241.3 MB | 26.2 MB | 0.9 MB |
| sinatra | 147 | 1,256 | 747 | 10.0 s | 0.4 s | 1.6 s | 205.1 MB | 20.3 MB | 0.7 MB |
| tokio | 793 | 10,299 | 14,909 | 74.4 s | 2.6 s | 5.3 s | 374.8 MB | 106.2 MB | 5.6 MB |
| zod | 507 | 9,648 | 34,610 | 110.0 s | 1.2 s | 7.7 s | 573.0 MB | 106.4 MB | 3.4 MB |

Totals: 13,953 files indexed, 30.3 minutes of cold indexing, 1.8 GB of database for 88 MB of source.

## 5. Answer latency and integrity

Every read path, many iterations over rotating inputs. A handler that errors immediately benchmarks well,
so the failure count is reported beside the timing.

| Query | p50 | p95 | p99 | Calls | Failed | Empty answers |
|---|---:|---:|---:|---:|---:|---:|
| `scg_snapshot_stats` | 11.3 ms | 15.5 ms | 22.8 ms | 720 | 0 | 0 of 18 repos |
| `scg_codebase_overview` | 31.3 ms | 41.4 ms | 49.3 ms | 720 | 0 | 0 of 18 repos |
| `scg_resolve_symbol` | 15.9 ms | 43.9 ms | 77.9 ms | 720 | 0 | 0 of 18 repos |
| `scg_get_symbol_details` | 2.1 ms | 3.3 ms | 4.4 ms | 720 | 0 | 0 of 18 repos |
| `scg_get_neighbors` | 6.9 ms | 13.2 ms | 16.7 ms | 720 | 0 | 0 of 18 repos |
| `scg_get_symbol_relations` | 0.7 ms | 5.2 ms | 5.8 ms | 720 | 0 | 0 of 18 repos |
| `scg_get_behavioral_profile` | 0.3 ms | 0.5 ms | 0.6 ms | 720 | 0 | 0 of 18 repos |
| `scg_get_contract_profile` | 0.7 ms | 1.2 ms | 1.5 ms | 720 | 0 | 0 of 18 repos |
| `scg_get_effect_signature` | 0.3 ms | 0.8 ms | 1.0 ms | 720 | 0 | 0 of 18 repos |
| `scg_get_tests` | 4.7 ms | 5.9 ms | 6.5 ms | 720 | 0 | 15 of 18 repos |
| `scg_get_invariants` | 1.2 ms | 1.8 ms | 2.3 ms | 720 | 0 | 1 of 18 repos |
| `scg_get_temporal_risk` | 0.4 ms | 0.7 ms | 0.8 ms | 720 | 0 | 0 of 18 repos |
| `scg_read_source` | 1.3 ms | 2.0 ms | 2.7 ms | 720 | 0 | 0 of 18 repos |
| `scg_search_code` | 22.8 ms | 72.5 ms | 80.5 ms | 720 | 0 | 0 of 18 repos |
| `scg_semantic_search` | 12.3 ms | 44.8 ms | 53.3 ms | 720 | 0 | 0 of 18 repos |
| `scg_find_homologs` | 71.9 ms | 122.5 ms | 152.6 ms | 720 | 0 | 14 of 18 repos |
| `scg_blast_radius` | 7.0 ms | 12.7 ms | 16.4 ms | 720 | 0 | 0 of 18 repos |
| `scg_compile_context_capsule` | 8.5 ms | 13.3 ms | 17.9 ms | 720 | 0 | 0 of 18 repos |
| `scg_smart_context` | 9.8 ms | 21.0 ms | 28.8 ms | 720 | 0 | 0 of 18 repos |

Capsule compile time, median across repositories: 15 ms average, 18 ms at p90.

## 6. What is still thin

- **Every repository in the corpus produces a call graph.**
- **Dependency recall is scored on 8 of 18 repositories.** The rest resolve no internal imports the harness can score, so their recall cell is an empty measurement, not a failure: alamofire, express, fmt, gson, guzzle, okhttp, ripgrep, serilog, sinatra, tokio.
- **1 of 18 repositories link no test to any symbol** — ripgrep.
- **Inline Rust `#[cfg(test)]` modules are invisible to a path-based test rule**, so a crate that keeps its tests beside the code links fewer of them than one using `tests/`.
