# Release Readiness

ContextZero distinguishes technical publication from a marketing launch. A
public GitHub repository or release is already technically accessible even if
no launch video or campaign has been published.

Do not create a tag or begin a marketing campaign until all of these gates are
green on the exact candidate commit:

```bash
npm ci
npm run audit
npm run typecheck
npm run lint
npm run build
npm run test:ci
npm run test:db
npm run package:verify
npm run doctor
docker compose config
docker compose build
```

Also verify:

- the candidate version is newer than the latest public tag and the changelog
  describes every user-visible/security change;
- CI is green on Node.js 20, 22, and 24;
- `SCG_API_KEYS` and `SCG_ADMIN_API_KEYS` are strong and distinct in the
  production environment;
- HTTP mutation routes reject regular keys and accept only admin keys;
- MCP mutation access and repository command execution are enabled only when
  explicitly intended;
- a clean database migration and real repository ingest succeed;
- rollback/restore has been rehearsed; and
- public benchmark language is limited to reproducible evidence. Historical
  author-run results without committed raw artifacts are not release gates.

Record the exact commit SHA, tag, CI run URL, audit output, package report,
database test result, container digest, smoke-test result, and approval owner
in the release notes. A date is a target, not a readiness signal; any failed or
unverified gate means no-go.

The supported distribution path is a source clone (or the Docker build) with
`npm ci` at the repository root. `package.json` is private, and no npm package
is published. Do not attach or advertise an npm tarball as an installable
release asset until a clean consumer install of `npm pack` output completes on
every supported Node.js version without `--legacy-peer-deps`. Package-boundary
verification and tarball extraction alone do not satisfy that consumer-install
gate.
