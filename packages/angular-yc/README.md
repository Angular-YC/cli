# @angular-yc/cli

CLI for analyzing, packaging, and uploading Angular SSR deployments to Yandex Cloud.

## Commands

- `angular-yc analyze`
- `angular-yc build`
- `angular-yc bootstrap`
- `angular-yc deploy-manifest`
- `angular-yc upload`
- `angular-yc deploy`
- `angular-yc plan`

`bootstrap` and `deploy` can read options from:

1. CLI flags
2. `AYC_*` environment variables
3. Config files (`angular-yc-cfg.json`, `.angular-yc-cfg`, `angular-yc-cfg.yml`, `angular-yc-cfg.yaml`)

Example (env vars):

```bash
export AYC_PROJECT=.
export AYC_PROJECT_NAME=studio
export AYC_STATE_BUCKET=pchat-terraform
export AYC_STATE_KEY=studio/terraform.tfstate
export AYC_REGION=ru-central1
export AYC_APP_NAME=studio
export AYC_ENV=production
export AYC_DOMAIN_NAME=studio.example.com

angular-yc bootstrap --auto-approve
angular-yc deploy --auto-approve
```

Example (config file):

```bash
angular-yc bootstrap --config ./angular-yc-cfg.json --auto-approve
angular-yc deploy --config ./angular-yc-cfg.json --auto-approve
```

By default, `deploy` uses `assets_bucket`/`cache_bucket` from Terraform outputs created during `bootstrap`.
Use `--bucket`/`--cache-bucket` only when you need explicit overrides.
Terraform root configuration is embedded in the CLI package and generated automatically at runtime.
