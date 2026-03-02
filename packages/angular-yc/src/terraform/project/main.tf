# Read cloud_id and folder_id from provider configuration
data "yandex_client_config" "current" {}

# Load deployment manifest
locals {
  manifest = jsondecode(file(var.manifest_path))

  build_id = local.manifest.buildId

  # Resource naming
  prefix = "${var.app_name}-${var.env}"

  # TLS certificate mode
  external_certificate_id  = trimspace(var.certificate_id)
  use_external_certificate = local.external_certificate_id != ""

  # Bucket mode
  external_assets_bucket     = trimspace(var.assets_bucket_name)
  use_external_assets_bucket = local.external_assets_bucket != ""
  external_cache_bucket      = trimspace(var.cache_bucket_name)
  use_external_cache_bucket  = var.enable_response_cache && local.external_cache_bucket != ""

  # Common tags (for yandex_function - requires set of strings)
  common_tags = [
    "app:${var.app_name}",
    "env:${var.env}",
    "build_id:${local.build_id}",
    "managed_by:terraform"
  ]

  # Common labels (for other resources - requires map of strings)
  common_labels = {
    app        = var.app_name
    env        = var.env
    build_id   = local.build_id
    managed_by = "terraform"
  }
}

# ============================================================================
# Security Module
# ============================================================================

module "security" {
  source = "./modules/core_security"

  app_name = var.app_name
  env      = var.env
  tags     = local.common_labels
}

# ============================================================================
# Storage Resources
# ============================================================================

# Assets bucket for static files
resource "yandex_storage_bucket" "assets" {
  count = local.use_external_assets_bucket ? 0 : 1

  bucket = "${local.prefix}-assets-${random_id.bucket_suffix.hex}"
  force_destroy = true

  # Encryption - Yandex Object Storage encrypts all data at rest by default
  # No need to specify encryption configuration as it's always enabled

  # Versioning for rollback capability
  versioning {
    enabled = true
  }

  # CORS for Angular assets
  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = var.allowed_origins
    max_age_seconds = 3600
  }

  # Lifecycle rules for old versions
  lifecycle_rule {
    enabled = true
    id      = "cleanup-old-versions"

    noncurrent_version_expiration {
      days = 30
    }
  }

  # Access control - bucket is private by default
  acl = "private"

  # Yandex Object Storage enforces HTTPS by default
  # No need for additional policy to force HTTPS

  tags = local.common_labels
}

# Cache bucket for Response cache
resource "yandex_storage_bucket" "cache" {
  count = var.enable_response_cache && !local.use_external_cache_bucket ? 1 : 0

  bucket = "${local.prefix}-cache-${random_id.bucket_suffix.hex}"
  force_destroy = true

  # Encryption - Yandex Object Storage encrypts all data at rest by default
  # No need to specify encryption configuration as it's always enabled

  versioning {
    enabled = true
  }

  # Lifecycle for cache expiry
  lifecycle_rule {
    enabled = true
    id      = "expire-cache"

    expiration {
      days = var.cache_ttl_days
    }

    transition {
      days          = 7
      storage_class = "COLD"
    }
  }

  acl = "private"

  tags = local.common_labels
}

locals {
  assets_bucket = local.use_external_assets_bucket ? local.external_assets_bucket : yandex_storage_bucket.assets[0].bucket
  cache_bucket = var.enable_response_cache ? (
    local.use_external_cache_bucket ? local.external_cache_bucket : yandex_storage_bucket.cache[0].bucket
  ) : ""
}

# ============================================================================
# YDB Serverless Database for Response cache Metadata
# ============================================================================

# Create YDB Serverless database for Response cache metadata
resource "yandex_ydb_database_serverless" "response_cache" {
  count = var.enable_response_cache ? 1 : 0

  name        = "${local.prefix}-response-cache-db"
  description = "Serverless YDB database for Response cache metadata"

  serverless_database {
    enable_throttling_rcu_limit = false
    provisioned_rcu_limit       = 10
    storage_size_limit          = 10 # GB
    throttling_rcu_limit        = 0
  }

  labels = local.common_labels
}

# Service account for YDB access
resource "yandex_iam_service_account" "ydb" {
  count = var.enable_response_cache ? 1 : 0

  name        = "${local.prefix}-ydb-sa"
  description = "Service account for YDB access"
}

# Grant YDB editor role
resource "yandex_resourcemanager_folder_iam_member" "ydb_editor" {
  count = var.enable_response_cache ? 1 : 0

  folder_id = data.yandex_client_config.current.folder_id
  role      = "ydb.editor"
  member    = "serviceAccount:${yandex_iam_service_account.ydb[0].id}"
}

# Create static access key for YDB
resource "yandex_iam_service_account_static_access_key" "ydb" {
  count = var.enable_response_cache ? 1 : 0

  service_account_id = yandex_iam_service_account.ydb[0].id
  description        = "Static key for YDB access"
}

# ============================================================================
# Cloud Functions
# ============================================================================

# Service account for functions
resource "yandex_iam_service_account" "functions" {
  name        = "${local.prefix}-functions-sa"
  description = "Service account for Cloud Functions"
}

# Grant necessary permissions
resource "yandex_resourcemanager_folder_iam_member" "functions_invoker" {
  folder_id = data.yandex_client_config.current.folder_id
  role      = "serverless.functions.invoker"
  member    = "serviceAccount:${yandex_iam_service_account.functions.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "storage_viewer" {
  folder_id = data.yandex_client_config.current.folder_id
  role      = "storage.viewer"
  member    = "serviceAccount:${yandex_iam_service_account.functions.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "storage_editor" {
  folder_id = data.yandex_client_config.current.folder_id
  role      = "storage.editor"
  member    = "serviceAccount:${yandex_iam_service_account.functions.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "lockbox_payload_viewer" {
  folder_id = data.yandex_client_config.current.folder_id
  role      = "lockbox.payloadViewer"
  member    = "serviceAccount:${yandex_iam_service_account.functions.id}"
}

# Server function (SSR/API)
resource "yandex_function" "server" {
  count = local.manifest.capabilities.rendering.needsServer ? 1 : 0

  name               = "${local.prefix}-server-function"
  description        = "Angular SSR and API handler"
  user_hash          = local.build_id
  runtime            = "nodejs${var.nodejs_version}"
  entrypoint         = local.manifest.artifacts.server.entry
  memory             = local.manifest.deployment.functions.server.memory
  execution_timeout  = local.manifest.deployment.functions.server.timeout
  service_account_id = yandex_iam_service_account.functions.id

  # Environment variables
  environment = merge(
    local.manifest.artifacts.server.env,
    {
      BUILD_ID              = local.build_id
      NODE_ENV              = "production"
      CACHE_BUCKET          = local.cache_bucket
      ASSETS_BUCKET         = local.assets_bucket
      YDB_ENDPOINT          = var.enable_response_cache ? yandex_ydb_database_serverless.response_cache[0].ydb_full_endpoint : ""
      YDB_DATABASE          = var.enable_response_cache ? yandex_ydb_database_serverless.response_cache[0].database_path : ""
      YDB_ACCESS_KEY_ID     = var.enable_response_cache ? yandex_iam_service_account_static_access_key.ydb[0].access_key : ""
      YDB_SECRET_KEY        = var.enable_response_cache ? yandex_iam_service_account_static_access_key.ydb[0].secret_key : ""
      REVALIDATE_SECRET_ID  = module.security.revalidate_secret_id
      CACHE_PURGE_SECRET_ID = module.security.revalidate_secret_id
    }
  )

  # Secrets from Lockbox
  secrets {
    id                   = module.security.revalidate_secret_id
    version_id           = module.security.revalidate_secret_version
    key                  = "hmac_secret"
    environment_variable = "REVALIDATE_SECRET"
  }

  secrets {
    id                   = module.security.revalidate_secret_id
    version_id           = module.security.revalidate_secret_version
    key                  = "hmac_secret"
    environment_variable = "CACHE_PURGE_SECRET"
  }

  # Function package
  content {
    zip_filename = var.server_zip_path != "" ? var.server_zip_path : "${var.build_dir}/artifacts/server.zip"
  }

  tags = local.common_tags
}

# Image optimization function
resource "yandex_function" "image" {
  count = local.manifest.capabilities.assets.needsImage ? 1 : 0

  name               = "${local.prefix}-image-function"
  description        = "Angular image optimization handler"
  user_hash          = local.build_id
  runtime            = "nodejs${var.nodejs_version}"
  entrypoint         = local.manifest.artifacts.image.entry
  memory             = local.manifest.deployment.functions.image.memory
  execution_timeout  = local.manifest.deployment.functions.image.timeout
  service_account_id = yandex_iam_service_account.functions.id

  environment = merge(
    local.manifest.artifacts.image.env,
    {
      BUILD_ID      = local.build_id
      NODE_ENV      = "production"
      CACHE_BUCKET  = local.cache_bucket
      ASSETS_BUCKET = local.assets_bucket
    }
  )

  content {
    zip_filename = var.image_zip_path != "" ? var.image_zip_path : "${var.build_dir}/artifacts/image.zip"
  }

  tags = local.common_tags
}

# ============================================================================
# API Gateway
# ============================================================================

# Generate OpenAPI spec from template
locals {
  openapi_spec = templatefile("${path.module}/templates/openapi.yaml.tpl", {
    api_name           = "${local.prefix}-api"
    assets_bucket      = local.assets_bucket
    build_id           = local.build_id
    server_function_id = local.manifest.capabilities.rendering.needsServer ? yandex_function.server[0].id : ""
    server_version_id  = local.manifest.capabilities.rendering.needsServer ? yandex_function.server[0].version : ""
    image_function_id  = local.manifest.capabilities.assets.needsImage ? yandex_function.image[0].id : ""
    image_version_id   = local.manifest.capabilities.assets.needsImage ? yandex_function.image[0].version : ""
    service_account_id = yandex_iam_service_account.functions.id
    has_server         = local.manifest.capabilities.rendering.needsServer
    has_image          = local.manifest.capabilities.assets.needsImage
  })
}

resource "yandex_api_gateway" "main" {
  name        = "${local.prefix}-api-gateway"
  description = "API Gateway for Angular application"

  spec = local.openapi_spec

  labels = local.common_labels
}

# ============================================================================
# DNS and TLS Certificate
# ============================================================================

resource "yandex_dns_zone" "main" {
  count = var.create_dns_zone ? 1 : 0

  name        = "${local.prefix}-zone"
  description = "DNS zone for ${var.domain_name}"
  zone        = "${var.domain_name}."
  public      = true

  labels = local.common_labels
}

resource "yandex_cm_certificate" "main" {
  count = local.use_external_certificate ? 0 : 1

  name    = "${local.prefix}-cert"
  domains = [var.domain_name]

  managed {
    challenge_type = "DNS_CNAME"
  }

  labels = local.common_labels
}

# DNS validation records
resource "yandex_dns_recordset" "validation" {
  for_each = local.use_external_certificate ? {} : { "0" = true }

  zone_id = var.create_dns_zone ? yandex_dns_zone.main[0].id : var.dns_zone_id
  name    = yandex_cm_certificate.main[0].challenges[0].dns_name
  type    = "CNAME"
  ttl     = 60
  data    = [yandex_cm_certificate.main[0].challenges[0].dns_value]
}

# API Gateway custom domain
resource "yandex_dns_recordset" "api_gateway" {
  count = var.create_dns_zone ? 1 : 0

  zone_id = yandex_dns_zone.main[0].id
  name    = var.domain_name
  type    = "CNAME"
  ttl     = 300
  data    = [yandex_api_gateway.main.domain]
}

# ============================================================================
# Monitoring and Logging
# ============================================================================

# Create log group for functions
resource "yandex_logging_group" "functions" {
  name             = "${local.prefix}-functions-logs"
  description      = "Logs for Cloud Functions"
  folder_id        = data.yandex_client_config.current.folder_id
  retention_period = "168h" # 7 days

  labels = local.common_labels
}

# ============================================================================
# Helper Resources
# ============================================================================

resource "random_id" "bucket_suffix" {
  byte_length = 4
}
