import * as fs from "fs";
import * as path from "path";
import { ExecaChildProcess, execa } from "execa";
import * as yaml from "js-yaml";
import { PRIVATE_TOKEN_ISSUER_DIRECTORY } from "@cloudflare/privacypass-ts";

const DEFAULT_SERVICES = {
  attester: {
    port: "8788",
    url: "http://localhost:8788",
  },
  issuer: {
    port: "8787",
    url: "http://localhost:8787",
  },
  origin: {
    port: "8789",
    url: "http://localhost:8789",
  },
};
type ServiceName = keyof typeof DEFAULT_SERVICES;

const runningServices = {
  attester: null as ExecaChildProcess | null,
  issuer: null as ExecaChildProcess | null,
  origin: null as ExecaChildProcess | null,
};

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
    await execa("git", ["clone", gitUrl, directory]);
  } else {
    await execa("git", ["fetch", "origin"], { cwd: directory });
    await execa("git", ["checkout", "origin/main"], { cwd: directory });
  }
}

async function symlinkFolder(filePath: string, directory: string) {
  if (!fs.existsSync(directory)) {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);
    fs.symlinkSync(absolutePath, directory, "dir");
  }
}

function getServiceDeployment(serviceName: ServiceName, config: ServiceConfig) {
  const port = config.port ?? DEFAULT_SERVICES[serviceName].port;
  let url = config.url;
  if (!url) {
    const defaultURL = new URL(DEFAULT_SERVICES[serviceName].url);
    defaultURL.port = port;
    url = defaultURL.toString();
  }
  return { port, url };
}

function getServiceDeployments(app: AppConfig) {
  return {
    attester: getServiceDeployment("attester", app.services["attester"]),
    issuer: getServiceDeployment("issuer", app.services["issuer"]),
    origin: getServiceDeployment("origin", app.services["origin"]),
  };
}

async function startService(serviceName: string, app: AppConfig) {
  const cwd = path.join(app.config.directory, serviceName);
  const config = app.services[serviceName];
  if (config.git) {
    await cloneRepo(config.git, cwd);
  } else if (config.file) {
    await symlinkFolder(config.file, cwd);
  } else if (config.url) {
    // nothing to be initialised
    return;
  }

  // Install all dependencies
  await execa("npm", ["install"], { cwd });

  const deployments = getServiceDeployments(app);
  console.log(`Service ${serviceName}: initialisation`);
  switch (serviceName) {
    case "attester": {
      runningServices.attester = execa(
        "npm",
        [
          "run",
          "dev",
          "--",
          "--port",
          deployments.attester.port,
          "--var",
          `ISSUER_DIRECTORY_URL:${deployments.issuer.url}${PRIVATE_TOKEN_ISSUER_DIRECTORY}`,
          "--var",
          `ISSUER_REQUEST_URL:${deployments.issuer.url}/token-request`,
        ],
        { cwd, detached: true },
      ).pipeStdout!(process.stdout);
      break;
    }
    case "issuer": {
      runningServices.issuer = execa(
        "npm",
        ["run", "dev", "--", "--port", deployments.issuer.port],
        { cwd, detached: true },
      ).pipeStdout!(process.stdout);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      fetch(`${deployments.issuer.url}/admin/rotate`, { method: "POST" });
      break;
    }
    case "origin": {
      runningServices.origin = execa(
        "npm",
        [
          "run",
          "dev",
          "--",
          "--port",
          deployments.origin.port,
          "--var",
          `ISSUER_URL:${deployments.issuer.url}`,
          "--var",
          `ORIGIN_NAME:${new URL(deployments.origin.url).host}`,
        ],
        { cwd, detached: true },
      ).pipeStdout!(process.stdout);
      break;
    }
  }
  console.log(`Service ${serviceName}: initialised`);
}

async function loadConfig(): Promise<AppConfig> {
  const configFile = "config.yaml";
  const configContent = fs.readFileSync(configFile, "utf-8");
  return yaml.load(configContent) as AppConfig;
}

async function main() {
  try {
    const app = await loadConfig();

    for (const [serviceName, _] of Object.entries(app.services)) {
      await startService(serviceName, app);
    }

    console.log("Services started successfully.");
  } catch (error: any) {
    console.error("Error:", error.message);
  }
}

process.on("SIGINT", function () {
  console.log("sigint");
  if (runningServices.attester?.pid) {
    process.kill(-runningServices.attester?.pid);
  }
  if (runningServices.issuer?.pid) {
    process.kill(-runningServices.issuer?.pid);
  }
  if (runningServices.origin?.pid) {
    process.kill(-runningServices.origin?.pid);
  }
  process.exit();
});

main();
