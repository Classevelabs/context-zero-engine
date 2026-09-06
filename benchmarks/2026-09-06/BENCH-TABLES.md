### Ingest and storage, 18 repositories, before and after

Cold ingest into a fresh database, wall clock; the incremental pass re-ingests after one file changes; database size against source size. Before = 2026-09-04 sweep, after = 2026-09-06 sweep on the same checkouts and machine.

| Repository | Language | Files | Cold before | Cold after | Incremental before | Incremental after | DB before | DB after | Source | Relations before | Relations after | Query failures after |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| zod | typescript | 507 | 113.7 s | 74.7 s | 11.5 s | 6.8 s | 84.8 MB | 103.4 MB | 3.37 MB | 28606 | 34317 | 0 |
| nest | typescript | 1842 | 153.4 s | 179.6 s | 5.9 s | 9.0 s | 103.2 MB | 139.0 MB | 3.90 MB | 20109 | 31998 | 0 |
| react | javascript | 4574 | 351.7 s | 310.4 s | 23.9 s | 20.8 s | 320.6 MB | 401.8 MB | 25.05 MB | 101775 | 128406 | 0 |
| express | javascript | 141 | 10.4 s | 11.2 s | 2.4 s | 2.5 s | 23.3 MB | 26.7 MB | 0.54 MB | 1495 | 3841 | 0 |
| django | python | 3041 | 1272.3 s | 394.9 s | 10.1 s | 10.1 s | 336.8 MB | 385.9 MB | 20.27 MB | 22117 | 68846 | 0 |
| flask | python | 83 | 30.7 s | 14.8 s | 2.1 s | 2.1 s | 24.3 MB | 25.7 MB | 0.58 MB | 265 | 1688 | 0 |
| gin | go | 99 | 11.0 s | 17.5 s | 1.2 s | 2.1 s | 23.8 MB | 26.0 MB | 0.68 MB | 2009 | 3788 | 0 |
| gh-cli | go | 937 | 67.8 s | 89.9 s | 0.6 s | 0.8 s | 68.0 MB | 91.1 MB | 7.99 MB | 10740 | 25973 | 0 |
| ripgrep | rust | 113 | 25.9 s | 24.1 s | 3.8 s | 3.5 s | 44.3 MB | 48.0 MB | 1.87 MB | 1785 | 6341 | 0 |
| tokio | rust | 790 | 68.9 s | 72.3 s | 0.7 s | 0.8 s | 82.6 MB | 94.9 MB | 5.59 MB | 3956 | 14756 | 0 |
| okhttp | java | 692 | 81.3 s | 66.4 s | 2.5 s | 1.6 s | 82.7 MB | 95.1 MB | 4.45 MB | 5602 | 16370 | 0 |
| gson | java | 264 | 89.6 s | 29.1 s | 2.6 s | 1.4 s | 52.1 MB | 59.1 MB | 1.97 MB | 1518 | 4118 | 0 |
| serilog | csharp | 216 | 14.9 s | 13.2 s | 0.3 s | 0.3 s | 22.6 MB | 25.5 MB | 0.90 MB | 253 | 1059 | 0 |
| sinatra | ruby | 147 | 17.4 s | 8.3 s | 1.5 s | 0.7 s | 19.6 MB | 20.0 MB | 0.67 MB | 437 | 747 | 0 |
| fmt | cpp | 81 | 28.2 s | 27.7 s | 3.0 s | 3.0 s | 42.8 MB | 45.5 MB | 2.55 MB | 3405 | 4917 | 0 |
| guzzle | php | 136 | 40.0 s | 22.2 s | 4.8 s | 3.5 s | 49.2 MB | 46.8 MB | 2.25 MB | 0 | 0 | 0 |
| alamofire | swift | 108 | 145.6 s | 41.4 s | 1.2 s | 0.7 s | 48.3 MB | 48.4 MB | 2.14 MB | 2517 | 4852 | 0 |
| engine-ts | typescript | 169 | — s | 36.4 s | — s | 4.4 s | — MB | 68.4 MB | 2.95 MB | — | 15323 | 0 |

Across the 17 repositories measured in both sweeps: cold ingest 2523 s before, 1397 s after; incremental 78.1 s before, 69.9 s after; database 1429 MB before, 1683 MB after; query failures 0 before, 0 after.

### One typical task, 18 repositories

"Change this function": the function, what it uses, what calls it. Median tokens for reading the files that mention the symbol (best-first, up to 25 files) against one capsule at a 12,000-token budget; the function is one of up to 60 library functions per repository, tests excluded. Dependency recall is the share of the function's indexed imports whose full source arrived in the capsule, and the count of such imports the score rests on; a small count is a thin measurement and is shown so it can be read as one.

| Repository | Language | Tasks | Reading tokens | Capsule tokens | Saved before | Saved after | Deps measured | Recall after | Recall incl. failures | Failed tasks | Beats / loses to reading |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| zod | typescript | 60 | 24284 | 1994 | 85.1% | 91.8% | 172 | 56.7% | 54.1% | 0 | 41 / 0 |
| nest | typescript | 60 | 8681 | 2187 | 68.2% | 74.8% | 338 | 71.1% | 66.9% | 0 | 52 / 0 |
| react | javascript | 60 | 17022 | 2643 | 88.8% | 84.5% | 160 | 65.5% | 64.4% | 0 | 24 / 0 |
| express | javascript | 3 | 926 | 428 | 50.1% | 53.8% | 0 | 0.0% | 0.0% | 0 | 0 / 0 |
| django | python | 60 | 25655 | 1647 | 94.1% | 93.6% | 108 | 62.9% | 43.5% | 0 | 25 / 0 |
| flask | python | 60 | 18221 | 1386 | 96.2% | 92.4% | 122 | 23.1% | 13.1% | 0 | 11 / 4 |
| gin | go | 23 | 6201 | 1820 | 89.1% | 70.6% | 4 | 50.0% | 50.0% | 0 | 2 / 0 |
| gh-cli | go | 60 | 9133 | 2220 | 78.7% | 75.7% | 102 | 79.2% | 78.4% | 0 | 30 / 0 |
| ripgrep | rust | 60 | 15614 | 1506 | 96.9% | 90.4% | 0 | 0.0% | 0.0% | 0 | 0 / 0 |
| tokio | rust | 60 | 9753 | 1236 | 84.2% | 87.3% | 0 | 0.0% | 0.0% | 0 | 0 / 0 |
| okhttp | java | 60 | 10169 | 1194 | 92.7% | 88.3% | 0 | 0.0% | 0.0% | 0 | 0 / 0 |
| gson | java | 60 | 7693 | 1946 | 89.5% | 74.7% | 0 | 0.0% | 0.0% | 0 | 0 / 0 |
| serilog | csharp | 60 | 7086 | 1020 | 88.3% | 85.6% | 0 | 0.0% | 0.0% | 0 | 0 / 0 |
| sinatra | ruby | 29 | 4420 | 864 | 64.6% | 80.5% | 0 | 0.0% | 0.0% | 0 | 0 / 0 |
| fmt | cpp | 60 | 5091 | 1095 | 98.7% | 78.5% | 0 | 0.0% | 0.0% | 0 | 0 / 0 |
| guzzle | php | 60 | 21084 | 484 | 98.7% | 97.7% | 0 | 0.0% | 0.0% | 0 | 0 / 0 |
| alamofire | swift | 60 | 13321 | 2238 | 87.7% | 83.2% | 0 | 0.0% | 0.0% | 0 | 0 / 0 |
| engine-ts | typescript | 60 | 24774 | 2829 | —% | 88.6% | 96 | 61.1% | 58.3% | 0 | 30 / 0 |

Median of the per-repository medians, after: 85.6% of tokens saved; 0 failed tasks of 955 attempted.
Dependency recall across all repositories with a measured population: 680 of 1102 indexed dependencies delivered (61.7%).
