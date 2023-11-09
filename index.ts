import * as fs from 'fs';
import * as path from 'path';
import { execa } from 'execa';
import * as yaml from 'js-yaml';

interface ServiceConfig {
  git?: string;
  url?: string;
  file?: string;
  port?: string;
}

interface AppConfig {
  services: {
    [key: string]: ServiceConfig;
  };
  config: {
    directory: string;
  };
}

async function cloneRepo(gitUrl: string, directory: string) {
  if (!fs.existsSync(directory)) {
    await execa('git', ['clone', gitUrl, directory]);
  }
}

async function startService(serviceName: string, config: ServiceConfig) {
  if (config.git) {
    await cloneRepo(config.git, serviceName);
  }

  if (serviceName === 'issuer') {
    // Additional configuration for the issuer
    // Perform key rotation logic here
    console.log('Key rotation logic for issuer');
  }

  // Start the service
  const cwd = path.resolve(config.file || serviceName);
  await execa('npm', ['run', 'dev'], { cwd });
}

async function loadConfig(): Promise<AppConfig> {
  const configFile = 'config.yaml';
  const configContent = fs.readFileSync(configFile, 'utf-8');
  return yaml.load(configContent) as AppConfig;
}

async function main() {
  try {
    const config = await loadConfig();

    for (const [serviceName, serviceConfig] of Object.entries(config.services)) {
      await startService(serviceName, serviceConfig);
    }

    console.log('Services started successfully.');
  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

main();

