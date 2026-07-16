# Deploy artifacts

- `sov-swap-coordinator.service` → `/etc/systemd/system/`, then
  `systemctl daemon-reload && systemctl enable --now sov-swap-coordinator`.
- `nginx-swap-api.conf` → an nginx sites-available vhost; enable it and run
  `certbot --nginx -d swap-api.sovxus.org` (needs the `swap-api` DNS A record first).

Assumes the repo at `/opt/sov-swap` and the built coordinator (`npm ci && npm run build`).
Secrets live only in `/opt/sov-swap/services/coordinator/.env` (chmod 600).
