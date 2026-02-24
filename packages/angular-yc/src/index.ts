#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import { Analyzer } from './analyze/index.js';
import { Builder } from './build/index.js';
import { ManifestGenerator } from './manifest/index.js';
import { Uploader } from './upload/index.js';

const program = new Command();

program
  .name('angular-yc')
  .description('CLI tool for deploying Angular applications to Yandex Cloud')
  .version('1.0.0');

program
  .command('analyze')
  .description('Analyze Angular project capabilities')
  .requiredOption('-p, --project <path>', 'Path to Angular project')
  .option('--project-name <name>', 'Angular project name from angular.json')
  .option('-o, --output <dir>', 'Output directory for analysis results')
  .option('-v, --verbose', 'Verbose output')
  .action(async (options) => {
    try {
      const analyzer = new Analyzer();
      const projectPath = path.resolve(options.project);

      await analyzer.analyze({
        projectPath,
        projectName: options.projectName,
        outputDir: options.output ? path.resolve(options.output) : undefined,
        verbose: options.verbose,
      });

      console.log(chalk.green('✅ Analysis complete'));
    } catch (error) {
      console.error(
        chalk.red('❌ Analysis failed:'),
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('build')
  .description('Build and package Angular app for YC deployment')
  .requiredOption('-p, --project <path>', 'Path to Angular project')
  .requiredOption('-o, --output <dir>', 'Output directory for build artifacts')
  .option('--project-name <name>', 'Angular project name from angular.json')
  .option('-b, --build-id <id>', 'Custom build ID')
  .option('-v, --verbose', 'Verbose output')
  .option('--skip-build', 'Skip Angular build and package existing dist')
  .action(async (options) => {
    try {
      const builder = new Builder();
      const projectPath = path.resolve(options.project);
      const outputDir = path.resolve(options.output);

      const manifest = await builder.build({
        projectPath,
        outputDir,
        projectName: options.projectName,
        buildId: options.buildId,
        verbose: options.verbose,
        skipBuild: options.skipBuild,
      });

      console.log(chalk.green('✅ Build complete'));
      console.log(chalk.cyan('📦 Artifacts:'), outputDir);
      console.log(chalk.cyan('🆔 Build ID:'), manifest.buildId);
    } catch (error) {
      console.error(
        chalk.red('❌ Build failed:'),
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('deploy-manifest')
  .description('Generate deployment manifest from build artifacts')
  .requiredOption('-b, --build-dir <dir>', 'Build artifacts directory')
  .requiredOption('-o, --out <path>', 'Output manifest path')
  .option('-v, --verbose', 'Verbose output')
  .action(async (options) => {
    try {
      const generator = new ManifestGenerator();
      const buildDir = path.resolve(options.buildDir);
      const outputPath = path.resolve(options.out);

      await generator.generate({
        buildDir,
        outputPath,
        verbose: options.verbose,
      });

      console.log(chalk.green('✅ Manifest generated'));
      console.log(chalk.cyan('📋 Manifest:'), outputPath);
    } catch (error) {
      console.error(
        chalk.red('❌ Manifest generation failed:'),
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('upload')
  .description('Upload build artifacts to Yandex Cloud Object Storage')
  .requiredOption('-b, --build-dir <dir>', 'Build artifacts directory')
  .requiredOption('--bucket <name>', 'S3 bucket name for assets')
  .requiredOption('--prefix <prefix>', 'S3 key prefix (usually build ID)')
  .option('--cache-bucket <name>', 'S3 bucket for response cache')
  .option('--region <region>', 'YC region', 'ru-central1')
  .option('--endpoint <url>', 'S3 endpoint URL')
  .option('-v, --verbose', 'Verbose output')
  .option('--dry-run', 'Show what would be uploaded without uploading')
  .action(async (options) => {
    try {
      const uploader = new Uploader();
      const buildDir = path.resolve(options.buildDir);

      await uploader.upload({
        buildDir,
        assetsBucket: options.bucket,
        prefix: options.prefix,
        cacheBucket: options.cacheBucket,
        region: options.region,
        endpoint: options.endpoint,
        verbose: options.verbose,
        dryRun: options.dryRun,
      });

      if (!options.dryRun) {
        console.log(chalk.green('✅ Upload complete'));
      }
    } catch (error) {
      console.error(
        chalk.red('❌ Upload failed:'),
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('plan')
  .description('Show deployment plan without building or uploading')
  .requiredOption('-p, --project <path>', 'Path to Angular project')
  .option('--project-name <name>', 'Angular project name from angular.json')
  .option('-v, --verbose', 'Verbose output')
  .action(async (options) => {
    try {
      const analyzer = new Analyzer();
      const projectPath = path.resolve(options.project);

      const capabilities = await analyzer.analyze({
        projectPath,
        projectName: options.projectName,
        verbose: false,
      });

      console.log(chalk.cyan('\n📋 Deployment Plan'));
      console.log(chalk.gray('─'.repeat(60)));
      console.log(chalk.white('Angular version:'), capabilities.angularVersion);
      console.log(
        chalk.white('Deployment mode:'),
        capabilities.rendering.needsServer ? 'Dynamic SSR/API' : 'Static only',
      );

      console.log(chalk.white('\nComponents:'));
      if (capabilities.rendering.needsServer) {
        console.log(chalk.gray('  • Server function (SSR + Express API routes)'));
      }
      if (capabilities.assets.needsImage) {
        console.log(chalk.gray('  • Image optimization function'));
      }
      console.log(chalk.gray('  • Static assets (Object Storage)'));

      if (capabilities.prerender.enabled) {
        console.log(chalk.white('\nPrerendering:'));
        console.log(chalk.gray(`  • Routes detected: ${capabilities.prerender.routes.length}`));
      }

      if (capabilities.responseCache.enabled) {
        console.log(chalk.white('\nResponse cache:'));
        console.log(
          chalk.gray(
            `  • TTL: ${capabilities.responseCache.defaultTtlSeconds}s (+${capabilities.responseCache.staleWhileRevalidateSeconds}s SWR)`,
          ),
        );
        console.log(chalk.gray(`  • Purge endpoint: ${capabilities.responseCache.purgePath}`));
      }

      if (capabilities.notes.length > 0) {
        console.log(chalk.yellow('\nWarnings:'));
        for (const note of capabilities.notes) {
          console.log(chalk.yellow(`  • ${note}`));
        }
      }

      console.log(chalk.gray('─'.repeat(60)));
      console.log(chalk.green('✅ Plan complete. Run "angular-yc build" to proceed.'));
    } catch (error) {
      console.error(
        chalk.red('❌ Planning failed:'),
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
