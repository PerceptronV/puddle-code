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
cp deploy/remote/.env.example deploy/remote/.env
openssl rand -hex 32
```

Edit `.env`: set the origins, hostnames, certificate email, a fresh random
`BETTER_AUTH_SECRET`, SMTP credentials/sender and `PUDDLE_SIGNUP_EMAILS`. Percent
encode special characters in SMTP URL credentials. SMTP must support TLS.
Keep this file private (`chmod 600 deploy/remote/.env`). The default email
allowlist is closed; `PUDDLE_OPEN_SIGNUP=true` explicitly opens registration.
Optional Google/GitHub client credentials enable their buttons. Register these
provider callback URLs, respectively:

- `https://relay.example.com/api/auth/callback/google`
- `https://relay.example.com/api/auth/callback/github`

On DigitalOcean, use a Docker Marketplace Droplet with public DNS for both
origins and inbound TCP 80/443 (SSH restricted to your own address). Copy this
checkout, including the mobile-access commits, onto the Droplet before running
Compose. DigitalOcean [blocks SMTP ports 25, 465 and 587](https://docs.digitalocean.com/support/why-is-smtp-blocked/).
Use a mail server that supports STARTTLS on an alternate port, for example
`PUDDLE_SMTP_URL=smtp://username:password@mail.example.com:2525`.
Puddle requires TLS before SMTP authentication. Verify the sender/domain with
your mail service; an API-only email credential is not an SMTP credential.

```sh
docker compose --env-file deploy/remote/.env -f deploy/remote/compose.yaml up --build -d
```

The example builds a Node service and a static application, with Caddy managing
TLS. Only ingress ports are published. The service runs as an unprivileged user
with a read-only root filesystem; its SQLite state is in `service-data`. Agent
homes, worktrees, SSH sockets and Docker sockets are never mounted into it.
The app's service origin is fixed at build time. Changing it requires rebuilding
the app, not editing a pairing link.

The example has one infrastructure administrator. To protect against a relay
operator, put the application image and its TLS termination on separately
controlled infrastructure: the relay's operator must not be able to replace
its JavaScript or alter its deployment. The browser necessarily trusts the
application distributor with keys, terminal input and decrypted output. Separate
origins alone do not protect against a shared compromised root account.

Open the application, create and verify an account or use a configured provider,
and optionally enable authenticator MFA under Account security. Store the recovery
codes privately. Email recovery and social login restore the service account;
they do not enrol a new browser at any host.

## Register and pair a host

In a Puddle desktop window (local or connected over SSH), open **Settings → Remote
access**. The controls apply to the host open in that window, across its profiles.
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
timings, sizes and availability. Operators own TLS, SMTP/OAuth, capacity,
backups, updates and incident response. Rate limits use the actual peer address,
not caller-supplied forwarding headers; behind the example ingress that is a
shared admission budget. Add edge admission controls before increasing exposure.

After dependency or security changes, run `pnpm build`, `pnpm test:remote`,
`pnpm test:e2e`, `pnpm test:ssh` and `pnpm test:mobile`. Install the test browser
with `pnpm --filter @puddle/web exec playwright install chromium` if needed.
The browser suite creates temporary HTTPS endpoints, isolated homes, fake agents
and email delivery; it does not launch an installed personal daemon. Use the
[physical-device and security acceptance checklist](acceptance/mobile-access.md)
before a production deployment. Automated coverage does not replace those checks.
