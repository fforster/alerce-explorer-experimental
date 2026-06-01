# Deploying to production

Runbook for putting the ALeRCE Explorer (experimental) live at
**https://explorer-experiment.alerce.online** on an AWS EC2 instance.

```
Internet ──443/80──▶ [caddy container] ──8000──▶ [app container]
                     auto Let's Encrypt          FastAPI / uvicorn
                     TLS + reverse proxy         (not exposed to host)
```

The app is built and run with `docker compose`. Caddy terminates HTTPS and
proxies to the app over a private compose network — the app port (8000) is
never published to the host or the internet.

---

## 0. Prerequisites (one-time, before touching the server)

### 0.1 The SSH key (`.pem`)

You log into the box with `ssh explorer-exp` (alias already in `~/.ssh/config`).

- The `.pem` lives **only on your laptop**, `chmod 400`, never on the server,
  never in this repo, never in the Docker image. The `.gitignore` /
  `.dockerignore` in this repo guard against committing or building it in.
- If the key was ever emailed / pasted into chat, treat it as compromised and
  rotate the EC2 key pair.

### 0.2 DNS

Create an **A record** pointing the domain at the instance's **public IP**
(or Elastic IP — recommended so it survives a stop/start):

```
explorer-experiment.alerce.online.   A   <EC2 public IP>
```

Verify from your laptop before continuing (TLS issuance depends on it):

```bash
dig +short explorer-experiment.alerce.online
```

### 0.3 AWS Security Group (firewall)

Inbound rules on the instance's security group:

| Port | Source | Why |
|------|--------|-----|
| 443  | 0.0.0.0/0 (+ ::/0) | HTTPS |
| 80   | 0.0.0.0/0 (+ ::/0) | HTTP→HTTPS redirect **and** Let's Encrypt ACME challenge |
| 22   | **your IP only** (`x.x.x.x/32`) | SSH — never leave open to the world |

> Better: drop port 22 entirely and use **AWS SSM Session Manager** for shell
> access (see Appendix B). Then there is no SSH key to leak at all.

---

## 1. Prepare the server (one-time)

SSH in:

```bash
ssh explorer-exp
```

### 1.1 Install Docker Engine + Compose plugin

**Amazon Linux 2023:**

```bash
sudo dnf update -y
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"      # run docker without sudo
```

**Ubuntu:**

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo tee /etc/apt/keyrings/docker.asc > /dev/null
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

**Log out and back in** (`exit`, then `ssh explorer-exp`) so the docker group
membership takes effect. Verify:

```bash
docker version
docker compose version
```

---

## 2. Get the code onto the server

```bash
# on the server
git clone <this-repo-url> alerce-explorer-experimental
cd alerce-explorer-experimental
```

> If the repo is private, prefer a **deploy key** (read-only SSH key generated
> *on the server* with `ssh-keygen -t ed25519`, public half added to the repo's
> Deploy Keys). Do **not** copy your personal `.pem` or GitHub key to the box.

---

## 3. Configure runtime environment

```bash
cp .env.example .env
```

For this app the only required value is already correct:

```ini
API_URL=https://explorer-experiment.alerce.online
```

`.env` is git-ignored and is never copied into the image. If/when real
secrets appear, move them to AWS Secrets Manager / SSM (Appendix C) instead of
leaving them in `.env`.

---

## 4. Build and launch

```bash
docker compose up -d --build
```

This builds three stages (Tailwind CSS → Poetry deps → slim runtime) and
starts `app` + `caddy`. First boot, Caddy obtains the Let's Encrypt certificate
automatically (needs DNS + ports 80/443 from steps 0.2–0.3).

Watch it come up:

```bash
docker compose ps
docker compose logs -f caddy     # look for "certificate obtained successfully"
docker compose logs -f app       # uvicorn startup
```

---

## 5. Verify

From your laptop:

```bash
curl -I https://explorer-experiment.alerce.online        # expect HTTP/2 200
curl -I http://explorer-experiment.alerce.online         # expect 308 -> https
```

Then open **https://explorer-experiment.alerce.online** in a browser, confirm
the padlock, run a search, and open an object detail view (light curve, stamps,
radar) to confirm the upstream ALeRCE calls work from the server.

---

## 6. Updating to a new version

```bash
ssh explorer-exp
cd alerce-explorer-experimental
git pull
docker compose up -d --build      # rebuilds, recreates only what changed
docker image prune -f             # reclaim old layers (optional)
```

Caddy keeps its certificate across restarts (persisted in the `caddy_data`
volume), so updates don't re-trigger ACME.

---

## 7. Operations cheatsheet

```bash
docker compose ps                 # status
docker compose logs -f app        # tail app logs
docker compose logs -f caddy      # tail proxy / TLS logs
docker compose restart app        # restart just the app
docker compose down               # stop everything (keeps volumes/certs)
docker compose down -v            # stop AND delete volumes (loses the cert!)
docker stats                      # live resource usage
```

`restart: unless-stopped` in `docker-compose.yml` means both containers come
back automatically after a reboot or crash (Docker starts on boot via
`systemctl enable docker`).

---

## Appendix A — Troubleshooting TLS

- **Cert not issued / "challenge failed":** port 80 must be reachable from the
  internet and DNS must already resolve to this host. Re-check the security
  group and `dig +short explorer-experiment.alerce.online`.
- **Rate limits while testing:** Let's Encrypt limits failed issuances. To
  experiment without burning quota, temporarily add to the top of `Caddyfile`:
  `{ acme_ca https://acme-staging-v02.api.letsencrypt.org/directory }`,
  `docker compose restart caddy`, then remove it for the real cert.
- **Inspect what Caddy is doing:** `docker compose logs caddy | grep -i acme`.

## Appendix B — Keyless access with SSM (recommended)

Removes the `.pem` from the picture entirely:

1. Attach an IAM role with `AmazonSSMManagedInstanceCore` to the instance.
2. Ensure the SSM agent is running (preinstalled on AL2023 and recent Ubuntu AMIs).
3. From your laptop (with AWS CLI + the Session Manager plugin):
   ```bash
   aws ssm start-session --target <instance-id>
   ```
4. Once confirmed working, remove the inbound port-22 rule from the security
   group. No SSH key, no key to leak, and every session is logged in CloudTrail.

## Appendix C — Real secrets later (AWS Secrets Manager / SSM)

When the app needs actual credentials, don't grow `.env`. Instead:

1. Store each secret in **AWS Secrets Manager** or **SSM Parameter Store**
   (`SecureString`).
2. Give the instance an IAM role allowing `ssm:GetParameter` /
   `secretsmanager:GetSecretValue` for those paths.
3. Fetch them at container start (entrypoint script) and export as env vars, so
   nothing sensitive is written to disk or baked into the image.

This keeps the security posture identical to the `.pem` rule: secrets live in a
managed store gated by IAM, never in the repo, never in an image layer.
