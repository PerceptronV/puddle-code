# Self-hosted mobile access

Puddle runs agents on your machine and connects outward to your own relay. An
ordinary browser uses a separately served application. There is no Puddle-hosted
service, VPN requirement or public daemon port. Use a persistently supervised
daemon; an SSH-attached fallback stops with its cockpit and cannot provide
independent phone access.

## Deploy the service and application

Choose two HTTPS origins under the same site, such as `app.example.com` and
`relay.example.com`, and point their DNS records at your ingress. Ports 80 and
443 must reach that ingress. Keep daemon ports 7433/7434 private.

From a checkout of the version you intend to run:

```sh
install -m 600 deploy/remote/.env.example deploy/remote/.env
openssl rand -hex 32
```

Edit `.env`: set the origins, hostnames, a fresh random `BETTER_AUTH_SECRET` and
OAuth credentials. Keep this file private (`chmod 600 deploy/remote/.env`).
Configure Google, GitHub or both; startup rejects missing or incomplete provider
credentials. Anyone with a provider-verified email can create an account. Host
access still requires explicit browser approval at the host. Puddle sends no email
and has no password login or email recovery. Caddy manages HTTPS without an email
contact setting. Register these provider callback URLs, respectively:

- `https://relay.example.com/api/auth/callback/google`
- `https://relay.example.com/api/auth/callback/github`

Restrict the environment file itself rather than changing the shell's umask for
later Git operations. Runtime images explicitly make application metadata,
configuration and public assets readable by their unprivileged users, even when
the checkout has private file permissions.

On DigitalOcean, use a Docker Marketplace Droplet with public DNS for both
origins and inbound TCP 80/443 (SSH restricted to your own address). Copy this
checkout, including the mobile-access commits, onto the Droplet before running
Compose. Authentication uses outbound HTTPS to the configured providers; no mail
provider, mail server or SMTP port is needed.

```sh
docker compose --env-file deploy/remote/.env -f deploy/remote/compose.yaml up --build -d
```

The example builds a Node service and a static application, with Caddy managing
TLS. Only ingress ports are published. The service runs as an unprivileged user
with a read-only root filesystem; its SQLite state is in `service-data`. Agent
homes, worktrees, SSH sockets and Docker sockets are never mounted into it.
The image creates `/data` with mode `0700`, owned by the service user (UID 10001),
so fresh Docker volumes satisfy the private-storage checks.
The app's service origin is fixed at build time. Changing it requires rebuilding
the app, not editing a pairing link.

CI builds both images from a checkout with private file permissions and runs
`node deploy/remote/test-images.mjs` to check service/database startup with a fresh
Docker volume, restart with retained state, and every static asset under the
production non-root, read-only, capability-free settings.
The application image removes Caddy's privileged-port file capability because it
serves port 8080; retaining that capability prevents execution with `cap_drop: ALL`.

The example has one infrastructure administrator. To protect against a relay
operator, put the application image and its TLS termination on separately
controlled infrastructure: the relay's operator must not be able to replace
its JavaScript or alter its deployment. The browser necessarily trusts the
application distributor with keys, terminal input and decrypted output. Separate
origins alone do not protect against a shared compromised root account.

Open the application and sign in with a configured provider,
and optionally enable authenticator MFA under Account security. Store the recovery
codes privately. Recover a lost provider login through Google or GitHub; signing
in again does not enrol a new browser at any host. Use the original provider:
matching email addresses do not automatically link different provider identities.

### Repair a volume created by an older image

Earlier service images created `/data` with mode `0755`. The private-storage check
rejects this, causing a service restart loop and ingress responses of 502. If
service logs report `Puddle authority storage must be private and owned by the
current user`, tighten the existing volume's directory permissions:

```sh
cd deploy/remote
docker compose stop service
docker compose run --rm --no-deps --entrypoint chmod service 700 /data
docker compose up -d service
```

This runs as the existing service user and preserves the volume's contents. Image
updates do not change an existing volume's permissions, so this repair is needed
once for affected volumes. Keep the private-storage checks enabled; do not delete
the volume to resolve this error.

### Configure Google or GitHub

For Google, create an OAuth client of type **Web application** in your Google
Cloud project's Google Auth Platform. Configure the consent screen with an
**External** audience so people outside your Workspace organisation can sign up,
and register the exact Google callback URL above. Put the client ID in
`GOOGLE_CLIENT_ID` and client secret in `GOOGLE_CLIENT_SECRET`.
A Google Workspace address works as the login identity;
no Gmail API, app password or mail configuration is needed. See
[Google's web application setup](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred)
and [audience settings](https://support.google.com/cloud/answer/15549945).

For GitHub, register an OAuth App in **Settings → Developer settings → OAuth
Apps**. Set the homepage to your application origin and the authorisation callback
to the GitHub URL above. Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from that
app. GitHub must report a verified email address; its primary email is used when
the public profile email is private. See
[GitHub's OAuth app setup](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app).

Leave both credential values empty for a provider you do not use. Credentials
belong only in the private service environment, never the static application's
build arguments. After changing credentials, recreate the service:

```sh
docker compose --env-file deploy/remote/.env -f deploy/remote/compose.yaml up -d service
```

### Upgrade an earlier email-login deployment

Rebuild the service/application and update host connectors together for remote
protocol 2 (daemon/cockpit protocol 19.0). Create fresh pairing invitations;
protocol-1 invitations are rejected. Existing browser keys and approvals survive
for accounts with an existing Google/GitHub binding.

Startup deletes legacy password credentials and, when any are found, invalidates
all service sessions, pending authentication challenges and MFA confirmations.
Provider bindings and host records are preserved. Remove `PUDDLE_SMTP_URL` and
`PUDDLE_EMAIL_FROM` from old environment files. Accounts that only had a password
cannot sign in or be claimed through a matching provider email. If you used such
an account while testing, back up the service state and initialise a fresh service
database, then register the hosts again through local/SSH access and approve the
browsers again. This does not stop daemon-owned work.

## Register and pair a host

In a Puddle desktop window (local or connected over SSH), open **Settings → Remote &
Sync**. The Remote access controls apply to the host open in that window, across
its profiles.
Enter the relay and application origins, open the application to create a host
registration code, and paste it into the masked Registration code field. Choose
**Enable remote access**. An existing registration can be re-enabled directly.
The connector needs persistent systemd/launchd supervision; the settings view
explains when the host needs configuration or an upgrade.

Choose **Pair a browser**, scan the QR code or copy/open the link on the new
browser, and request approval there. Return to the desktop, compare the full
browser identity and choose **Approve this identity**. Status and device requests
refresh automatically while settings are open. Each browser has a Revoke action;
Disable remote access detaches every remote viewer. Under Host identity recovery,
Reset host identity performs the same local/SSH recovery as `puddle remote reset`
after explicit confirmation. Codes and invitations are not stored in cockpit
settings or logs. These controls work even when the relay is unavailable.

Choose **Delete registration…** to disable access, revoke every browser and
invitation, and remove the saved origins and registration credential from this
host. Confirming returns settings to **Not configured**; connecting again needs
a new registration code and fresh approvals. Agents continue running. The host
identity and revoked device records remain for audit/recovery. This local/SSH-only
action requires an updated host connector. It does not sign in to the relay on
your behalf: remove its account-list entry separately with **Your hosts →
Unregister** in the web application.

The equivalent CLI workflow is:

In the application, expand Add a host, enter a name and create a registration
code. On the machine running the daemon:

```sh
puddle remote enable --service https://relay.example.com --app-origin https://app.example.com
```

Or register over SSH:

```sh
puddle remote enable user@host --service https://relay.example.com --app-origin https://app.example.com
```

Paste the five-minute code at the hidden prompt. Do not put it in command-line
arguments, shell history or background logs. For automation the command reads a
single code from stdin. Systemd/launchd supervises the connector independently of
the CLI and laptop. `remote enable` without origins re-enables an existing
registration. Registering again clears previous approvals and invitations. An
upgrade restarts the previously configured connector; daemon removal disables
remote access and removes its supervisor too.

For another persistent supervisor, `remote enable --foreground` writes the
configuration and `puddle remote run` runs the connector in the foreground.
Supervise **both** daemon and connector outside an agent session. No nohup or
cockpit-bound fallback is silently selected for mobile access.

```sh
puddle remote pair                 # add user@host for an SSH host
```

Open the printed link in the intended browser (or use the QR/link from an already
paired browser's Devices page). Give the browser a name and request approval.
Compare the browser identity shown on both devices, then on the host:

```sh
puddle remote devices
puddle remote approve <request-id>
```

The host must approve that exact browser. A copied invitation or successful
service login alone grants no terminal access. An already paired browser can
approve the new browser under Devices instead of using SSH. Invitations expire
in five minutes and can enrol only one identity.

## Use, revoke and recover

Choose a host, project and session. Create an agent session with an existing
account or a shell session; use session actions to resume, stop or archive it.
The phone view has one terminal or text review, explicit terminal keys and a
multiline prompt composer. Send respects the terminal's bracketed-paste mode.
Drafts remain in this tab across reconnect/reload. If delivery is uncertain,
check the terminal before sending again. No operation is replayed automatically.

File and change review renders text only. Remote transfers, source editing,
Git mutations, forwarded applications and executable previews are unavailable.
A paired terminal still has the host owner's execution authority.

```sh
puddle remote status
puddle remote revoke <device-id>
puddle remote disable
```

These commands accept an optional `user@host` and work through local/SSH host
control without the relay. Disable is persisted before viewer shutdown. Revocation
and disconnection detach viewers; agents continue. Service sign-out/unregistration
also closes routed connections. A sleeping host remains unavailable.

Browser grants have a 30-day inactivity limit and a 90-day absolute limit. Renew
by creating another invitation and approving the browser again. Private browsing
or cleared IndexedDB loses the browser key and requires pairing again. Forget
pairing removes a key from that browser; revoke its host record separately.

If every browser is lost, use local/SSH access. To rotate a compromised or missing
host identity and revoke all browser grants:

```sh
puddle remote reset
puddle remote enable
puddle remote pair
```

Forget the old host pairing in each browser before accepting the replacement.
Reset is deliberately absent from the remote application protocol. Back up
`~/.puddle/remote` securely as one unit; restoring an old database can restore
previously revoked grants, so reset when recovery provenance is uncertain.
Back up service SQLite and `BETTER_AUTH_SECRET` privately too. No service backup
can restore missing browser keys or grant replacement host access.

## Operations and validation

The relay holds account/routing metadata and transient bounded ciphertext. It
stores no terminal/source history. Access logging is disabled in the example;
do not add logs of cookies, authorization headers, bodies, codes or pairing URLs.
Expired unused registrations and MFA confirmations are pruned every minute.
Accounts and redeemed host registrations persist until removed; device records
remain on the host for inspection. Relay traffic still reveals addresses,
timings, sizes and availability. Operators own TLS, OAuth, capacity,
backups, updates and incident response. Rate limits use the actual peer address,
not caller-supplied forwarding headers; behind the example ingress that is a
shared admission budget. Add edge admission controls before increasing exposure.

After dependency or security changes, run `pnpm build`, `pnpm test:remote`,
`pnpm test:e2e`, `pnpm test:ssh` and `pnpm test:mobile`. Install the test browser
with `pnpm --filter @puddle/web exec playwright install chromium` if needed.
The browser suite creates temporary HTTPS endpoints, isolated homes, fake agents
and provider responses; it does not launch an installed personal daemon. Use the
[physical-device and security acceptance checklist](acceptance/mobile-access.md)
before a production deployment. Automated coverage does not replace those checks.
