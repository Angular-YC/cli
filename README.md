# Angular-YC CLI Workspace

TypeScript pnpm workspace containing:

- `@angular-yc/cli` (`packages/angular-yc`)
- `@angular-yc/runtime` (`packages/runtime-yc`)

## Commands

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm format:check
pnpm ci
```

Run the CLI locally:

```bash
pnpm cli:dev -- analyze --project ../examples/angular20-zoneless-signals
```

## CLI Commands

- `analyze`: parse `angular.json` and detect deployment capabilities
- `build`: package server/image zips + static assets + OpenAPI template + manifest
- `deploy-manifest`: validate or reconstruct `deploy.manifest.json`
- `upload`: upload artifacts to Object Storage
- `plan`: preview deployment footprint
