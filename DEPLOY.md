# Deploying to production

Puts the app live at **https://explorer-experiment.alerce.online**.
Caddy handles HTTPS automatically and proxies to the FastAPI app:

```
Internet ──443/80──▶ caddy ──8000──▶ app
```

## Before you start (in the AWS console)

- **DNS:** A record `explorer-experiment.alerce.online` → the instance's public IP.
- **Security group inbound:** open `80` and `443` to the world; restrict `22` to your IP.

## Deploy

```bash
ssh explorer-exp
```

One-time, if Docker isn't installed yet (Ubuntu):

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 git
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"      # then log out and back in
```

Then:

```bash
git clone git@github.com:fforster/alerce-explorer-experimental.git
cd alerce-explorer-experimental
cp .env.example .env
docker compose up -d --build
```

First boot, Caddy fetches the Let's Encrypt cert automatically (needs the DNS +
ports above). Watch it: `docker compose logs -f caddy`.

## Verify

```bash
curl -I https://explorer-experiment.alerce.online      # expect 200
```

Then open it in a browser and run a search.

## Update later

```bash
ssh explorer-exp
cd alerce-explorer-experimental
git pull
docker compose up -d --build
```

## Handy commands

```bash
docker compose ps           # status
docker compose logs -f app  # tail logs
docker compose restart app  # restart the app
docker compose down         # stop (keeps the TLS cert)
```

> The `.pem` to `ssh explorer-exp` stays on your laptop only — never on the
> server, in the repo, or in the image. To drop SSH keys entirely, use AWS SSM
> Session Manager instead.
