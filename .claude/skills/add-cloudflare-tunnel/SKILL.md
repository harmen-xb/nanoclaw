---
name: add-cloudflare-tunnel
description: Set up a named Cloudflare Tunnel to expose a local port (e.g. Teams bot on port 3978) to a permanent public HTTPS URL. One Cloudflare account can host multiple named tunnels for multiple nanoclaw instances. Requires a Cloudflare account and a domain added to Cloudflare.
---

# Add Cloudflare Tunnel

This skill sets up a **named Cloudflare Tunnel** — a permanent, fixed HTTPS URL that forwards traffic to a local port. Unlike quick tunnels (`trycloudflare.com`), named tunnels survive restarts and have a stable URL.

## Use cases
- Expose the Teams bot HTTP server (port 3978) to Azure Bot Service
- One Cloudflare account → multiple tunnels for multiple nanoclaw instances

## Prerequisites

- A Cloudflare account (free at cloudflare.com)
- A domain added to Cloudflare (nameservers pointing to Cloudflare)
- `cloudflared` installed in WSL2

## Step 1 — Install cloudflared in WSL2

```bash
# Download latest cloudflared for Linux
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /tmp/cloudflared
chmod +x /tmp/cloudflared
# Optional: move to a permanent location
sudo mv /tmp/cloudflared /usr/local/bin/cloudflared
```

## Step 2 — Get Cloudflare API Token

Tell the user:

> I need a Cloudflare API token to manage tunnels. Here's how to create one:
>
> 1. Go to **dash.cloudflare.com** → Profile → **API Tokens**
> 2. Click **Create Token**
> 3. Use template: **Edit Cloudflare Tunnel** (or create custom with: Zone DNS Edit + Account Tunnel Edit)
> 4. Set Account Resources: your account
> 5. Set Zone Resources: your domain (e.g. `crossmodel.org`)
> 6. Click **Create Token** — copy the token value

Store in `.env`:
```
CLOUDFLARE_API_TOKEN=<token>
CLOUDFLARE_ACCOUNT_ID=<account-id>
CLOUDFLARE_TUNNEL_DOMAIN=<your-domain>       # e.g. crossmodel.org
CLOUDFLARE_TUNNEL_SUBDOMAIN=<subdomain>      # e.g. clai (→ clai.crossmodel.org)
CLOUDFLARE_TUNNEL_PORT=3978                  # local port to expose
```

**Finding your Account ID:** Go to dash.cloudflare.com → select your domain → right sidebar shows Account ID.

## Step 3 — Login and create tunnel

Run in WSL2 (or wherever nanoclaw runs):

```bash
# Login (opens browser, select your domain)
cloudflared tunnel login

# Create a named tunnel (pick a name per instance, e.g. nanoclaw-home, nanoclaw-work)
cloudflared tunnel create <tunnel-name>
```

This prints the **Tunnel ID** (UUID like `abc12345-...`). Note it — you need it for the config.

## Step 4 — Create tunnel config file

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /home/<user>/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: <subdomain>.<domain>     # e.g. clai.crossmodel.org
    service: http://localhost:3978
  - service: http_status:404
```

Example:
```yaml
tunnel: abc12345-xxxx-xxxx-xxxx-xxxxxxxxxxxx
credentials-file: /home/harmen/.cloudflared/abc12345-xxxx-xxxx-xxxx-xxxxxxxxxxxx.json

ingress:
  - hostname: clai.crossmodel.org
    service: http://localhost:3978
  - service: http_status:404
```

## Step 5 — Create DNS record

```bash
cloudflared tunnel route dns <tunnel-name> <subdomain>.<domain>
# e.g.
cloudflared tunnel route dns nanoclaw-home clai.crossmodel.org
```

This creates a CNAME record in Cloudflare DNS automatically.

## Step 6 — Start the tunnel

```bash
cloudflared tunnel run <tunnel-name>
```

Or with config file:
```bash
cloudflared tunnel --config ~/.cloudflared/config.yml run
```

The tunnel URL is now permanently: `https://<subdomain>.<domain>` (e.g. `https://clai.crossmodel.org`)

## Step 7 — Update Azure Bot Service

In Azure Portal → Bot Service → Configuration, set the messaging endpoint to:
```
https://<subdomain>.<domain>/api/messages
```

e.g. `https://clai.crossmodel.org/api/messages`

## Step 8 — Run as a service (auto-start on boot)

To make the tunnel start automatically when WSL2 starts, add to `~/.bashrc` or create a systemd service:

```bash
# Add to ~/.bashrc (simple approach)
nohup cloudflared tunnel run <tunnel-name> > ~/cloudflared.log 2>&1 &
```

Or install as systemd service (requires systemd in WSL2):
```bash
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

## Multiple instances

For multiple nanoclaw instances, each gets its own named tunnel:

| Instance | Tunnel name | Subdomain | Port |
|----------|-------------|-----------|------|
| Home | nanoclaw-home | clai-home.crossmodel.org | 3978 |
| Work | nanoclaw-work | clai-work.crossmodel.org | 3979 |

Each instance sets a different `TEAMS_PORT` in its `.env` and the tunnel config points to that port.

## Troubleshooting

- *Tunnel not connecting:* Check `~/.cloudflared/<tunnel-id>.json` exists
- *DNS not resolving:* Wait a few minutes after `tunnel route dns` — Cloudflare propagates fast but not instant
- *Port not reachable:* Confirm the service (e.g. nanoclaw) is running and listening on the configured port with `curl http://localhost:3978/health`
- *Multiple config files:* Use `--config` flag to specify which config file to use if you have multiple tunnels
