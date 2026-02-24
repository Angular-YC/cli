# Local Development

## Workspace Setup

```bash
pnpm install
pnpm build
pnpm test
```

## Running CLI from Source

```bash
pnpm cli:dev -- analyze --project ../examples/angular18-ssr-prerender --verbose
pnpm cli:dev -- build --project ../examples/angular18-ssr-prerender --output /tmp/angular-build-yc
```

## Test Layout

- `src/analyze/analyze.test.ts` (10 tests)
- `src/build/build.test.ts` (8 tests)
- `src/upload/upload.test.ts` (9 tests)
- `src/compat/compat.test.ts` (21 tests)
