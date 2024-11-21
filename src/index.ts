import * as fs from "fs";
import * as path from "path";
import { ExecaChildProcess, Options, execa } from "execa";
import * as yaml from "js-yaml";
import { PRIVATE_TOKEN_ISSUER_DIRECTORY } from "@cloudflare/privacypass-ts";
import { Option, program } from "commander";
import * as dotenv from "dotenv";

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

const DEFAULT_IMMEDIATE_DEPLOYMENT = true;

interface ServiceConfig {
  git?: string;
  url?: string;
  file?: string;
  port?: string;
  test?: {
    hostname: string;
    tlsConfig?: {
      key: string;
      cert: string;
    };
  };
  deploy?: {
    wrangler: string;
    environment?: string;
    envFile?: string;
    immediateDeployment?: boolean;
  };
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
  const parts = gitUrl.split("#");
  if (parts.length > 2) {
    throw new Error(`Invalid git URL: ${gitUrl}`);
  }
  if (parts.length === 2) {
    gitUrl = parts[0];
  }
  if (!fs.existsSync(directory)) {
    await execa("git", ["clone", gitUrl, directory]);
  } else {
    await execa("git", ["fetch", "origin"], { cwd: directory });
  }

  if (parts.length === 2) {
    return execa("git", ["checkout", parts[1]], { cwd: directory });
  } else {
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

async function symlinkFile(filePath: string, file: string) {
  if (fs.existsSync(file)) {
    fs.rmSync(file);
  }
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
  fs.symlinkSync(absolutePath, file, "file");
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

async function getExistingServiceDeployment(path: string) {
  if (!fs.existsSync(path)) {
    return {
      serviceType: "non-initialized",
    };
  }
  const isSymlink = fs.lstatSync(path).isSymbolicLink();

  if (isSymlink) {
    return {
      serviceType: "file",
      value: fs.readlinkSync(path),
    };
  }

  // Run the git rev-parse command to check if the path is a Git repository
  // don't capture the error, let it propagate
  await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd: path });

  const { stdout } = await execa("git", ["remote", "get-url", "origin"], {
    cwd: path,
  });

  return {
    serviceType: "git",
    value: stdout.trim(),
  };
}

function rmDir(path: string) {
  if (!fs.existsSync(path)) {
    return;
  }
  if (fs.lstatSync(path).isSymbolicLink()) {
    return fs.rmSync(path);
  }
  return fs.rmSync(path, { recursive: true, force: true });
}

async function startService(serviceName: ServiceName, app: AppConfig) {
  const cwd = path.join(app.config.directory, serviceName);

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

async function deployService(serviceName: ServiceName, app: AppConfig) {
  const cwd = path.join(app.config.directory, serviceName);

  const { deploy } = app.services[serviceName];

  if (!deploy) {
    throw new Error(`[${serviceName}] should define a 'deploy' section`);
  }

  const {
    wrangler: wranglerConfig,
    environment,
    envFile,
    immediateDeployment,
  } = deploy;

  let options: Options<"utf8"> = { cwd };
  let cronSchedule;
  if (envFile) {
    const env = dotenv.parse(fs.readFileSync(envFile));
    options = { ...options, env: { ...process.env, ...env } };
    if (env.ROTATION_CRON_STRING) {
      cronSchedule = env.ROTATION_CRON_STRING;
    }
  }

  const extraArgs = environment ? ["--env", environment] : [];

  await symlinkFile(wranglerConfig, path.join(cwd, "wrangler.toml"));

  console.log(`cwd: ${cwd}`);

  const immediate = immediateDeployment ?? DEFAULT_IMMEDIATE_DEPLOYMENT;
  const command = immediate
    ? ["deploy"]
    : ["versions", "upload", "--experimental-versions"];

  if (cronSchedule) {
    extraArgs.push("--triggers", cronSchedule);
  }

  return execa(
    "npx",
    ["wrangler", ...command, "--config", "./wrangler.toml", ...extraArgs],
    options,
  ).pipeStdout!(process.stdout);
}

// dev: this method is not designed like I'd like to
// Ideally, this method reads the route from the deployment wrangler config, and test it
// However, this does not seem to be exposed by wrangler (cli/library), and doing a full parsing is too much much
// Therefore, we provide a dedicated key test.hostname in the app config, and test that hostname
async function testService(serviceName: ServiceName, app: AppConfig) {
  const cwd = path.join(app.config.directory, serviceName);
  console.log(`cwd: ${cwd}`);

  const { deploy, test } = app.services[serviceName];

  if (!deploy) {
    throw new Error(`[${serviceName}] should define a 'deploy' section`);
  }

  if (!test) {
    throw new Error(`[${serviceName}] should define a 'test' section`);
  }

  const extraArgs = test.tlsConfig
    ? [
        "--cert",
        path.resolve(test.tlsConfig.cert),
        "--key",
        path.resolve(test.tlsConfig.key),
      ]
    : [];

  switch (serviceName) {
    case "issuer": {
      const result = await execa(
        "npm",
        ["run", "test:e2e", "--", ...extraArgs, test.hostname],
        { cwd },
      ).pipeStdout!(process.stdout).pipeStderr!(process.stderr);
      if (result.exitCode !== 0) {
        throw new Error(`[${serviceName}] end-to-end test failed`);
      }
      break;
    }
    default: {
      console.warn(`[${serviceName}] does not support end-to-end test.`);
      return;
    }
  }
}

async function installService(serviceName: string, app: AppConfig) {
  const cwd = path.join(app.config.directory, serviceName);
  const config = app.services[serviceName];
  const { serviceType, value } = await getExistingServiceDeployment(
    path.resolve(cwd),
  );

  // Check the config is valid
  if ([config.git, config.file, config.url].filter(Boolean).length !== 1) {
    throw new Error(
      `[${serviceName}] should define one and only one of 'git', 'file', or 'url'`,
    );
  }

  if (config.git) {
    // Refresh the service directory if the configuration was different
    if (serviceType !== "git" || value !== config.git) {
      rmDir(cwd);
    }
    await cloneRepo(config.git, cwd);
  } else if (config.file) {
    // Refresh the service directory if the configuration was different
    if (serviceType !== "file" || value !== path.resolve(config.file)) {
      rmDir(cwd);
    }
    await symlinkFolder(config.file, cwd);
  } else if (config.url) {
    rmDir(path.resolve(cwd));
    // nothing to be initialised
    return;
  }

  // Install all dependencies
  await execa("npm", ["install"], { cwd });
}

async function loadConfig(path: string): Promise<AppConfig> {
  const configContent = fs.readFileSync(path, "utf-8");
  return yaml.load(configContent) as AppConfig;
}

async function main() {
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf-8"));
  const version = packageJson.version || "1.0.0";

  program
    .name("privacypass-config")
    .version(version)
    .description(
      "Orchestrate the development and deployment of Privacy Pass services",
    );

  program
    .command("dev")
    .description("Start development server")
    .option("-c, --config <path>", "Path to configuration file", "config.yaml")
    .action(async (options) => {
      try {
        const app = await loadConfig(options.config);

        for (const [serviceName, _] of Object.entries(app.services)) {
          await installService(serviceName, app);
          await startService(serviceName as ServiceName, app);
        }

        console.log("Services started successfully.");
      } catch (error: any) {
        console.error("Error:", error.message);
      }
    });

  const defaultServices = Object.keys(DEFAULT_SERVICES);
  program
    .command("deploy")
    .description("Deploy the application")
    .option("-c, --config <path>", "Path to configuration file", "config.yaml")
    .addOption(
      new Option(
        "--service <name...>",
        "Name of the service to deploy. By default, deploy all services",
      ).choices(defaultServices),
    )
    .action(async (options) => {
      try {
        const app = await loadConfig(options.config);

        const toDeploy = options.service ?? defaultServices;

        for (const serviceName of toDeploy) {
          await installService(serviceName, app);
          await deployService(serviceName, app);
        }

        console.log("Services deployed successfully.");
      } catch (error: any) {
        console.error("Error:", error.message);
      }
    });

  program
    .command("test")
    .description("Test the application end-to-end")
    .option("-c, --config <path>", "Path to configuration file", "config.yaml")
    .addOption(
      new Option(
        "--service <name...>",
        "Name of the service to test. By default, test all services",
      ).choices(defaultServices),
    )
    .action(async (options) => {
      try {
        const app = await loadConfig(options.config);

        const toTest = options.service ?? defaultServices;

        for (const serviceName of toTest) {
          await installService(serviceName, app);
          await testService(serviceName, app);
        }

        console.log("Services tested successfully.");
      } catch (error: any) {
        console.error("Error:", error.message);
      }
    });

  program
    .command("help")
    .description("Display help information")
    .action(() => {
      program.outputHelp();
    });

  program.parse();
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
