# pp-config

This service allows you to start a Privacy Pass stack locally: an attester, an origin, and an issuer. It leverages Cloudflare repositories.

## Config

Example config files are available in [./examples](./examples). You need to place one in the root folder with the name `config.yaml`. For instance, `cp examples/git.config.yaml config.yaml`.

The configuration can be a file, a url, or a git. In the case of a file or a git, the local port can be specified.

```yaml
services:
  attester:
    git: "https://github.com/cloudflare/pp-attester"
    port: "8788"
  issuer:
  	url: "https://pp-issuer-public.research.cloudflare.com"
  origin:
  	file: "./pp-origin"
  	port: "8789"

config:
  directory: "dist"
```

## Features

* Load the above yaml configuration
* Clone repos if they don't exist
* Start services on their respective port. This imply configuring them if needed (issuer needs a key rotation at start)

## Next features

* Started pp-browser-extension in a headless browser

