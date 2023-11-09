# pp-config

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
  directory: ".dist"
```

The service must have:

* load the above yaml configuration
* Clone repos if they don't exist
* Start services on their respective port. This imply configuring them if needed (issuer needs a key rotation at start)



It would be good if the service:

* Started pp-browser-extension in a headless browser
* For local files, listen to modification and restart the service
* Checks the configuration
