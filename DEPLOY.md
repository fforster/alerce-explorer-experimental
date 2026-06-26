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

## Session-replay analytics

Optional, **off by default**. Records visitor sessions (rrweb) to gzipped daily
JSONL so we can study how the explorer is used. See `src/services/analytics.py`.

Enable on the server:

```bash
ssh explorer-exp
cd alerce-explorer-experimental
git pull                       # make sure the analytics feature is deployed

# 1. Turn it on in .env
#      ANALYTICS_ENABLED=1
#      ANALYTICS_IP_SALT=<a long random string>   # so per-IP hashes aren't reversible
nano .env

# 2. One-time: let the container's non-root appuser (uid 10001) write ./logs.
#    docker-compose bind-mounts ./logs -> /app/logs, so sessions persist on the
#    host next to the code (./logs is git- and docker-ignored, never committed).
mkdir -p logs && sudo chown -R 10001:10001 logs

# 3. Rebuild + restart
docker compose up -d --build
```

Verify it's live:

```bash
docker compose logs app | grep analytics                  # → "[analytics] enabled, logging to /app/logs/analytics"
curl -s https://explorer-experiment.alerce.online/ | grep -o 'ux_recorder.js'   # script is injected
ls logs/analytics/                                        # YYYY-MM-DD.jsonl.gz appears after real traffic
```

Notes:
- **Privacy:** anonymous only; raw IPs are never stored (salted hash). Visitors
  who send **GPC / Do-Not-Track** (Brave default, Firefox with the signal on)
  are intentionally **not** recorded. To turn collection off again, set
  `ANALYTICS_ENABLED=0` in `.env` and `docker compose up -d`.
- **Durability:** logs live on the instance disk only. For long-term retention,
  periodically sync `./logs/analytics/` to S3.
- **Inspect:** `pd.read_json("logs/analytics/<date>.jsonl.gz", lines=True, compression="gzip")`;
  feed a row's `payload.events` into `rrweb-player` (dev tool) to replay a session.

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
