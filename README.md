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
- `bootstrap`: initialize Terraform backend and create required assets/cache buckets
- `deploy-manifest`: validate or reconstruct `deploy.manifest.json`
- `upload`: upload artifacts to Object Storage
- `deploy`: run build -> upload -> terraform apply
- `plan`: preview deployment footprint

## Bootstrap/Deploy Config

`angular-yc bootstrap` and `angular-yc deploy` support three input layers:

1. CLI flags (highest priority)
2. `AYC_*` environment variables
3. Config file values

Built-in config file discovery (current dir and project dir):

- `angular-yc-cfg.json`
- `.angular-yc-cfg`
- `angular-yc-cfg.yml`
- `angular-yc-cfg.yaml`

You can also pass a custom file with `--config <path>`.

Common env vars:

- `AYC_PROJECT`, `AYC_PROJECT_NAME`, `AYC_OUTPUT`, `AYC_TERRAFORM_DIR`
- `AYC_STATE_BUCKET`, `AYC_STATE_KEY`, `AYC_STATE_REGION`, `AYC_STATE_ENDPOINT`
- `AYC_STATE_ACCESS_KEY`, `AYC_STATE_SECRET_KEY`
- `AYC_PREFIX`, `AYC_REGION`, `AYC_ENDPOINT`
- `AYC_APP_NAME`, `AYC_ENV`, `AYC_DOMAIN_NAME`
- `AYC_AUTO_APPROVE`, `AYC_SKIP_BUILD`
- `AYC_TF_VAR_<name>` for arbitrary Terraform vars (maps to `TF_VAR_<name>`)

Example with environment variables:

```bash
export AYC_PROJECT=.
export AYC_PROJECT_NAME=studio
export AYC_OUTPUT=./build
export AYC_TERRAFORM_DIR=./infra/yandex
export AYC_STATE_BUCKET=pchat-terraform
export AYC_STATE_KEY=studio/terraform.tfstate
export AYC_REGION=ru-central1
export AYC_APP_NAME=studio
export AYC_ENV=production
export AYC_DOMAIN_NAME=studio.example.com

angular-yc bootstrap --auto-approve
angular-yc deploy --auto-approve
```

Config file example (`angular-yc-cfg.json`):

```json
{
  "project": ".",
  "projectName": "studio",
  "output": "./build",
  "terraformDir": "./infra/yandex",
  "stateBucket": "pchat-terraform",
  "stateKey": "studio/terraform.tfstate",
  "appName": "studio",
  "environment": "production",
  "domainName": "studio.example.com",
  "tfVars": {
    "dns_zone_id": "dnscxxxx",
    "certificate_id": "fpqxxxxx"
  }
}
```

Then run:

```bash
angular-yc bootstrap --config ./angular-yc-cfg.json --auto-approve
angular-yc deploy --config ./angular-yc-cfg.json --auto-approve
```

By default, `deploy` reads `assets_bucket`/`cache_bucket` from Terraform outputs produced during `bootstrap`.
Use `--bucket`/`--cache-bucket` only for explicit overrides.
