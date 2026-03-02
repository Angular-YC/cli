import fs from 'fs-extra';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import archiver from 'archiver';
import chalk from 'chalk';
import ora from 'ora';
import { Analyzer } from '../analyze/index.js';
import { createDefaultManifest, DeployManifest } from '../manifest/schema.js';

const execAsync = promisify(exec);
const require = createRequire(import.meta.url);

interface AngularWorkspace {
  defaultProject?: string;
  projects?: Record<string, AngularProject>;
}

interface AngularProject {
  architect?: Record<string, AngularTarget>;
}

interface AngularTarget {
  builder?: string;
  options?: Record<string, unknown>;
}

interface BuildOutputs {
  projectName: string;
  browserOutput: string;
  serverOutput?: string;
  prerenderOutput?: string;
}

export interface BuildOptions {
  projectPath: string;
  outputDir: string;
  buildId?: string;
  verbose?: boolean;
  skipBuild?: boolean;
  projectName?: string;
}

export class Builder {
  private readonly analyzer: Analyzer;

  constructor() {
    this.analyzer = new Analyzer();
  }

  async build(options: BuildOptions): Promise<DeployManifest> {
    const spinner = ora();
    const { projectPath, outputDir, verbose } = options;

    try {
      await fs.ensureDir(outputDir);
      const artifactsDir = path.join(outputDir, 'artifacts');
      await fs.ensureDir(artifactsDir);

      if (!options.skipBuild) {
        spinner.start('Building Angular application...');
        await this.runAngularBuild(projectPath);
        spinner.succeed('Angular build complete');
      }

      spinner.start('Analyzing Angular capabilities...');
      const capabilities = await this.analyzer.analyze({
        projectPath,
        outputDir,
        verbose: false,
        projectName: options.projectName,
      });
      spinner.succeed('Analysis complete');

      const outputs = await this.detectBuildOutputs(projectPath, options.projectName);
      const buildId = options.buildId || this.generateBuildId();

      if (verbose) {
        console.log(chalk.gray(`  Build ID: ${buildId}`));
        console.log(chalk.gray(`  Project: ${outputs.projectName}`));
      }

      if (capabilities.rendering.needsServer) {
        spinner.start('Packaging server function...');
        await this.packageServer(projectPath, artifactsDir, capabilities, outputs);
        spinner.succeed('Server function packaged');
      }

      if (capabilities.assets.needsImage) {
        spinner.start('Packaging image optimizer...');
        await this.packageImageOptimizer(artifactsDir);
        spinner.succeed('Image optimizer packaged');
      }

      spinner.start('Copying static assets...');
      await this.copyStaticAssets(projectPath, artifactsDir, outputs, buildId);
      spinner.succeed('Static assets copied');

      spinner.start('Generating API Gateway spec...');
      await this.generateOpenAPISpec(outputDir, capabilities, buildId);
      spinner.succeed('API Gateway spec generated');

      spinner.start('Creating deployment manifest...');
      const manifest = await this.createManifest(buildId, outputs.projectName, capabilities, outputDir);
      spinner.succeed('Deployment manifest created');

      if (verbose) {
        console.log(chalk.green('\n✅ Build complete!'));
        console.log(chalk.cyan('📦 Output directory:'), outputDir);
        console.log(chalk.cyan('📋 Manifest:'), path.join(outputDir, 'deploy.manifest.json'));
      }

      return manifest;
    } catch (error) {
      spinner.fail('Build failed');
      throw error;
    }
  }

  private async runAngularBuild(projectPath: string): Promise<void> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (!(await fs.pathExists(packageJsonPath))) {
      throw new Error('package.json not found in Angular project');
    }

    const packageJson = await fs.readJson(packageJsonPath);
    const scripts = packageJson.scripts || {};

    if (!scripts.build) {
      throw new Error('No build script found in package.json. Expected "build" script.');
    }

    const commands: string[] = ['npm run build'];
    if (scripts['build:ssr']) {
      commands.push('npm run build:ssr');
    }
    if (scripts['prerender']) {
      commands.push('npm run prerender');
    }

    for (const command of commands) {
      const { stderr } = await execAsync(command, {
        cwd: projectPath,
        env: { ...process.env, NODE_ENV: 'production' },
      });

      if (stderr && !stderr.toLowerCase().includes('warn')) {
        console.error(chalk.red(`Build output (${command}):`), stderr);
      }
    }
  }

  private async detectBuildOutputs(projectPath: string, explicitProjectName?: string): Promise<BuildOutputs> {
    const angularJsonPath = path.join(projectPath, 'angular.json');
    if (!(await fs.pathExists(angularJsonPath))) {
      throw new Error('angular.json not found');
    }

    const workspace = (await fs.readJson(angularJsonPath)) as AngularWorkspace;
    const projectName =
      explicitProjectName || workspace.defaultProject || Object.keys(workspace.projects || {})[0];

    if (!projectName) {
      throw new Error('Could not detect Angular project name from angular.json');
    }

    const project = workspace.projects?.[projectName] || {};
    const targets = project.architect || {};

    const buildOptions = targets.build?.options || {};
    const serverOptions = targets.server?.options || targets.ssr?.options || {};
    const prerenderOptions = targets.prerender?.options || {};

    const browserOutput = path.resolve(
      projectPath,
      this.resolveBuildOutputPath(buildOptions.outputPath, projectName, 'browser'),
    );

    const possibleServerOutput = path.resolve(
      projectPath,
      this.resolveBuildOutputPath(serverOptions.outputPath, projectName, 'server'),
    );

    const possiblePrerenderOutput = path.resolve(
      projectPath,
      this.resolveBuildOutputPath(prerenderOptions.outputPath, projectName, 'prerender'),
    );

    const serverOutput = (await fs.pathExists(possibleServerOutput)) ? possibleServerOutput : undefined;
    const prerenderOutput = (await fs.pathExists(possiblePrerenderOutput))
      ? possiblePrerenderOutput
      : undefined;

    return {
      projectName,
      browserOutput,
      serverOutput,
      prerenderOutput,
    };
  }

  private resolveBuildOutputPath(
    outputPath: unknown,
    projectName: string,
    segment: 'browser' | 'server' | 'prerender',
  ): string {
    if (typeof outputPath === 'string' && outputPath.length > 0) {
      return outputPath;
    }

    if (outputPath && typeof outputPath === 'object') {
      const objectOutput = outputPath as Record<string, unknown>;
      const base = typeof objectOutput.base === 'string' ? objectOutput.base : `dist/${projectName}`;
      const segmentValue = objectOutput[segment];
      if (typeof segmentValue === 'string' && segmentValue.length > 0) {
        return path.join(base, segmentValue);
      }
      return path.join(base, segment);
    }

    return `dist/${projectName}/${segment}`;
  }

  private async packageServer(
    projectPath: string,
    artifactsDir: string,
    capabilities: DeployManifest['capabilities'],
    outputs: BuildOutputs,
  ): Promise<void> {
    const serverDir = path.join(artifactsDir, 'server');
    await fs.ensureDir(serverDir);

    await this.copyRuntimePackage(serverDir);

    const handlerCode = `
import { createServerHandler } from '@angular-yc/runtime';

export const handler = createServerHandler({
  dir: __dirname,
  trustProxy: true,
  responseCache: {
    enabled: ${capabilities.responseCache.enabled ? 'true' : 'false'},
    driver: process.env.RESPONSE_CACHE_DRIVER || 'memory',
    defaultTtlSeconds: Number(process.env.RESPONSE_CACHE_TTL || ${capabilities.responseCache.defaultTtlSeconds}),
  },
});
`;
    await fs.writeFile(path.join(serverDir, 'index.js'), handlerCode.trimStart());

    if (outputs.serverOutput && (await fs.pathExists(outputs.serverOutput))) {
      await fs.copy(outputs.serverOutput, path.join(serverDir, 'server'));
    }

    if (await fs.pathExists(outputs.browserOutput)) {
      await fs.copy(outputs.browserOutput, path.join(serverDir, 'browser'));
    }

    const packageJsonPath = path.join(projectPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      await fs.copy(packageJsonPath, path.join(serverDir, 'package.json'));
      await this.copyDependencies(projectPath, serverDir);
    }

    await this.createZipArchive(serverDir, path.join(artifactsDir, 'server.zip'));
    await fs.remove(serverDir);
  }

  private async packageImageOptimizer(artifactsDir: string): Promise<void> {
    const imageDir = path.join(artifactsDir, 'image');
    await fs.ensureDir(imageDir);

    await this.copyRuntimePackage(imageDir);

    const handlerCode = `
import { createImageHandler } from '@angular-yc/runtime';

export const handler = createImageHandler({
  cacheBucket: process.env.CACHE_BUCKET,
  sourcesBucket: process.env.ASSETS_BUCKET,
});
`;

    await fs.writeFile(path.join(imageDir, 'index.js'), handlerCode.trimStart());

    await this.createZipArchive(imageDir, path.join(artifactsDir, 'image.zip'));
    await fs.remove(imageDir);
  }

  private async copyRuntimePackage(targetDir: string): Promise<void> {
    const nodeModulesDest = path.join(targetDir, 'node_modules');
    await fs.ensureDir(nodeModulesDest);
    await this.copyPackageWithDependencies('@angular-yc/runtime', nodeModulesDest, new Set());
  }

  private async copyPackageWithDependencies(
    packageName: string,
    nodeModulesDest: string,
    copiedPackages: Set<string>,
  ): Promise<void> {
    if (copiedPackages.has(packageName)) {
      return;
    }

    copiedPackages.add(packageName);

    const packageJsonPath = await this.resolvePackageJsonPath(packageName);
    const packageDir = path.dirname(packageJsonPath);
    const packageJson = await fs.readJson(packageJsonPath);

    await fs.copy(packageDir, path.join(nodeModulesDest, packageName), {
      dereference: true,
      filter: (src) => !src.includes('.cache'),
    });

    const dependencies = Object.keys(packageJson.dependencies || {});
    for (const dependency of dependencies) {
      await this.copyPackageWithDependencies(dependency, nodeModulesDest, copiedPackages);
    }

    const optionalDependencies = Object.keys(packageJson.optionalDependencies || {});
    for (const dependency of optionalDependencies) {
      try {
        await this.copyPackageWithDependencies(dependency, nodeModulesDest, copiedPackages);
      } catch (error) {
        if (this.isMissingModule(error)) {
          continue;
        }
        throw error;
      }
    }
  }

  private isMissingModule(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    const moduleError = error as { code?: string; message?: string };
    return (
      moduleError.code === 'MODULE_NOT_FOUND' ||
      Boolean(moduleError.message?.includes('Cannot find module'))
    );
  }

  private async resolvePackageJsonPath(packageName: string): Promise<string> {
    try {
      return require.resolve(`${packageName}/package.json`);
    } catch {
      const entryPath = require.resolve(packageName);
      const packageRoot = await this.findPackageRootFromEntry(entryPath, packageName);
      if (!packageRoot) {
        throw new Error(
          `Unable to resolve package.json for "${packageName}" (resolved entry: ${entryPath})`,
        );
      }
      return path.join(packageRoot, 'package.json');
    }
  }

  private async findPackageRootFromEntry(
    entryPath: string,
    packageName: string,
  ): Promise<string | undefined> {
    let currentDir = path.dirname(entryPath);
    const filesystemRoot = path.parse(currentDir).root;

    while (true) {
      const candidatePackageJson = path.join(currentDir, 'package.json');
      if (await fs.pathExists(candidatePackageJson)) {
        try {
          const candidatePackage = await fs.readJson(candidatePackageJson);
          if (candidatePackage?.name === packageName) {
            return currentDir;
          }
        } catch {
          // Ignore invalid package metadata while walking up.
        }
      }

      if (currentDir === filesystemRoot || path.basename(currentDir) === 'node_modules') {
        break;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    const nodeModulesSegment = path.join('node_modules', packageName);
    const segmentIndex = entryPath.lastIndexOf(nodeModulesSegment);
    if (segmentIndex >= 0) {
      return entryPath.slice(0, segmentIndex + nodeModulesSegment.length);
    }

    return undefined;
  }

  private async resolvePackageJsonPath(packageName: string): Promise<string> {
    try {
      return require.resolve(`${packageName}/package.json`);
    } catch {
      const entryPath = require.resolve(packageName);
      const packageRoot = await this.findPackageRootFromEntry(entryPath, packageName);
      if (!packageRoot) {
        throw new Error(
          `Unable to resolve package.json for "${packageName}" (resolved entry: ${entryPath})`,
        );
      }
      return path.join(packageRoot, 'package.json');
    }
  }

  private async findPackageRootFromEntry(
    entryPath: string,
    packageName: string,
  ): Promise<string | undefined> {
    let currentDir = path.dirname(entryPath);
    const filesystemRoot = path.parse(currentDir).root;

    while (true) {
      const candidatePackageJson = path.join(currentDir, 'package.json');
      if (await fs.pathExists(candidatePackageJson)) {
        try {
          const candidatePackage = await fs.readJson(candidatePackageJson);
          if (candidatePackage?.name === packageName) {
            return currentDir;
          }
        } catch {
          // Ignore invalid package metadata while walking up.
        }
      }

      if (currentDir === filesystemRoot || path.basename(currentDir) === 'node_modules') {
        break;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    const nodeModulesSegment = path.join('node_modules', packageName);
    const segmentIndex = entryPath.lastIndexOf(nodeModulesSegment);
    if (segmentIndex >= 0) {
      return entryPath.slice(0, segmentIndex + nodeModulesSegment.length);
    }

    return undefined;
  }

  private async copyStaticAssets(
    projectPath: string,
    artifactsDir: string,
    outputs: BuildOutputs,
    buildId: string,
  ): Promise<void> {
    const assetsDir = path.join(artifactsDir, 'assets');
    await fs.ensureDir(assetsDir);

    if (!(await fs.pathExists(outputs.browserOutput))) {
      throw new Error(
        `Browser output directory not found: ${outputs.browserOutput}. Run build before packaging.`,
      );
    }

    await fs.copy(outputs.browserOutput, path.join(assetsDir, 'browser'));

    if (outputs.prerenderOutput && (await fs.pathExists(outputs.prerenderOutput))) {
      await fs.copy(outputs.prerenderOutput, path.join(assetsDir, 'prerender'));
    }

    const publicDir = path.join(projectPath, 'public');
    if (await fs.pathExists(publicDir)) {
      await fs.copy(publicDir, path.join(assetsDir, 'public'));
    }

    await fs.writeFile(path.join(assetsDir, 'BUILD_ID'), buildId);
  }

  private async copyDependencies(projectPath: string, targetDir: string): Promise<void> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (!(await fs.pathExists(packageJsonPath))) {
      return;
    }

    const packageJson = await fs.readJson(packageJsonPath);
    const dependencies = Object.keys(packageJson.dependencies || {});

    const nodeModulesSource = path.join(projectPath, 'node_modules');
    if (!(await fs.pathExists(nodeModulesSource))) {
      return;
    }

    const nodeModulesDest = path.join(targetDir, 'node_modules');
    await fs.ensureDir(nodeModulesDest);

    for (const dependency of dependencies) {
      const depSource = path.join(nodeModulesSource, dependency);
      if (await fs.pathExists(depSource)) {
        await fs.copy(depSource, path.join(nodeModulesDest, dependency), {
          filter: (src) => !src.includes('.cache'),
        });
      }
    }
  }

  private async createZipArchive(sourceDir: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver('zip', {
        zlib: { level: 9 },
      });

      output.on('close', resolve);
      archive.on('error', reject);

      archive.pipe(output);
      archive.directory(sourceDir, false);
      void archive.finalize();
    });
  }

  private async generateOpenAPISpec(
    outputDir: string,
    capabilities: DeployManifest['capabilities'],
    buildId: string,
  ): Promise<void> {
    const spec: Record<string, unknown> = {
      openapi: '3.0.0',
      info: {
        title: 'Angular App API Gateway',
        version: '1.0.0',
      },
      paths: {
        '/browser/{proxy+}': {
          get: {
            'x-yc-apigateway-integration': {
              type: 'object_storage',
              bucket: '${var.assets_bucket}',
              object: `assets/${buildId}/browser/{proxy}`,
              service_account_id: '${var.service_account_id}',
            },
            parameters: [
              {
                name: 'proxy',
                in: 'path',
                required: true,
                schema: { type: 'string' },
              },
            ],
          },
        },
        '/assets/{proxy+}': {
          get: {
            'x-yc-apigateway-integration': {
              type: 'object_storage',
              bucket: '${var.assets_bucket}',
              object: `assets/${buildId}/browser/assets/{proxy}`,
              service_account_id: '${var.service_account_id}',
            },
            parameters: [
              {
                name: 'proxy',
                in: 'path',
                required: true,
                schema: { type: 'string' },
              },
            ],
          },
        },
        '/favicon.ico': {
          get: {
            'x-yc-apigateway-integration': {
              type: 'object_storage',
              bucket: '${var.assets_bucket}',
              object: `assets/${buildId}/browser/favicon.ico`,
              service_account_id: '${var.service_account_id}',
            },
          },
        },
        '/robots.txt': {
          get: {
            'x-yc-apigateway-integration': {
              type: 'object_storage',
              bucket: '${var.assets_bucket}',
              object: `assets/${buildId}/browser/robots.txt`,
              service_account_id: '${var.service_account_id}',
            },
          },
        },
      },
    };

    const paths = spec.paths as Record<string, unknown>;

    if (capabilities.assets.needsImage) {
      paths['/_image'] = {
        get: {
          'x-yc-apigateway-integration': {
            type: 'cloud_functions',
            function_id: '${var.image_function_id}',
            service_account_id: '${var.service_account_id}',
            payload_format_version: '1.0',
          },
          parameters: [
            {
              name: 'url',
              in: 'query',
              required: true,
              schema: { type: 'string' },
            },
            {
              name: 'w',
              in: 'query',
              required: false,
              schema: { type: 'integer' },
            },
            {
              name: 'q',
              in: 'query',
              required: false,
              schema: { type: 'integer' },
            },
          ],
        },
      };
    }

    if (capabilities.rendering.needsServer) {
      paths['/api/{proxy+}'] = {
        any: {
          'x-yc-apigateway-integration': {
            type: 'cloud_functions',
            function_id: '${var.server_function_id}',
            service_account_id: '${var.service_account_id}',
            payload_format_version: '1.0',
          },
          parameters: [
            {
              name: 'proxy',
              in: 'path',
              required: false,
              schema: { type: 'string' },
            },
          ],
        },
      };

      paths['/{proxy+}'] = {
        any: {
          'x-yc-apigateway-integration': {
            type: 'cloud_functions',
            function_id: '${var.server_function_id}',
            service_account_id: '${var.service_account_id}',
            payload_format_version: '1.0',
          },
          parameters: [
            {
              name: 'proxy',
              in: 'path',
              required: false,
              schema: { type: 'string' },
            },
          ],
        },
      };

      paths['/'] = {
        any: {
          'x-yc-apigateway-integration': {
            type: 'cloud_functions',
            function_id: '${var.server_function_id}',
            service_account_id: '${var.service_account_id}',
            payload_format_version: '1.0',
          },
        },
      };
    }

    await fs.writeJson(path.join(outputDir, 'openapi-template.json'), spec, { spaces: 2 });
  }

  private async createManifest(
    buildId: string,
    projectName: string,
    capabilities: DeployManifest['capabilities'],
    outputDir: string,
  ): Promise<DeployManifest> {
    const manifest = createDefaultManifest(buildId, projectName, capabilities);
    manifest.routing.openapiTemplatePath = './openapi-template.json';

    const manifestPath = path.join(outputDir, 'deploy.manifest.json');
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    return manifest;
  }

  private generateBuildId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `build-${timestamp}-${random}`;
  }
}
