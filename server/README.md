# WS Lab Auth Sidecar

This folder contains the optional standalone login service for WS Lab. It is useful when `dev/ws-lab` is deployed as an independent static site and should not depend on AI Server configuration.

## Generate Password Hashes

```bash
node server/hash-password.js --random PXLab@Ext-En
node server/hash-password.js --random PXLab@Ext-Ja
node server/hash-password.js --random PXLab@Internal
```

Copy `users.example.json` to `users.json`, then paste the generated `password` and `password_hash` values. The `password` field is only for local maintainers to read; login verification uses `password_hash`. Do not commit real passwords or real hashes.

## Run

Local development, when you only want to see the login page:

```bash
cp server/users.example.json server/users.json
node server/start-local-auth.js
```

Production or shared deployment:

```bash
export WS_LAB_AUTH_SESSION_SECRET="$(openssl rand -hex 32)"
export WS_LAB_AUTH_USERS_FILE="/srv/patchx-ws-lab/server/users.json"
node server/ws-lab-auth-server.js
```

Or install/update it as a systemd service after pulling the latest repository:

```bash
cd /srv/patchx-ws-lab
sudo bash server/deploy-sidecar.sh
```

The script creates `/etc/patchx-ws-lab-auth.env` when missing, installs
`patchx-ws-lab-auth.service`, restarts it, and checks local health.

Default address:

```text
http://127.0.0.1:8787/api/ws-lab-auth
```

Production deployments should keep this service private on localhost and expose it through the same public domain as WS Lab, for example `/api/ws-lab-auth/*`.
