# Monitor network security

A monitor makes RAIN send HTTP requests to an address a user chose. Without controls that is a
server-side request forgery (SSRF) primitive: it could reach the cloud metadata service, internal
admin panels or other private networks. This document records what is enforced today, at
monitor **registration**, and what the monitoring **executor** must enforce when it is built.

> **Status (Phase 3):** the executor, its SSRF-safe transport and the monitoring worker that runs
> scheduled and manual checks are implemented. The safe transport is mandatory in every
> environment; there is no switch to disable it. Network-level egress restrictions remain a
> deployment task (section 6).

## 1. Enforced at registration (implemented)

`findMonitorUrlIssue` in `packages/shared/src/monitor-url.ts` runs in the browser form and,
authoritatively, in the API on every create and URL update.

| Rule                   | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheme                 | `http://` and `https://` only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Ports                  | V1 allows only the standard ports: **80 for http, 443 for https**. Implicit and explicit default ports are equivalent (`https://x` = `https://x:443`). Any other explicit port is rejected with `UNSUPPORTED_PORT`.                                                                                                                                                                                                                                                                                                                                       |
| Literal IP addresses   | Loopback, private (10/8, 172.16/12, 192.168/16), link-local and cloud metadata (169.254/16), carrier-grade NAT (100.64/10), "this network" (0/8), benchmarking, documentation, multicast, reserved and broadcast IPv4 ranges are rejected. For IPv6: unspecified, loopback, IPv4-mapped and IPv4-compatible forms, NAT64 (64:ff9b::/96), 6to4 (2002::/16), Teredo, discard-only, unique-local (fc00::/7), link-local, site-local, documentation and multicast. Hex, octal, integer and short IPv4 forms are normalised by the URL parser before checking. |
| Local hostnames        | `localhost` and names under `.local`, `.localdomain`, `.internal`, `.intranet`, `.lan`, `.home`, `.corp`, `.home.arpa` are rejected, as are single-label hostnames.                                                                                                                                                                                                                                                                                                                                                                                       |
| Credentials in the URL | User-info (`user:pass@`) and credential-like query parameters (`token`, `api_key`, `password`, …) are rejected; secrets belong in encrypted headers.                                                                                                                                                                                                                                                                                                                                                                                                      |

### Port policy

The policy is a parameter (`MonitorPortPolicy`, default `DEFAULT_MONITOR_PORT_POLICY`). API
callers cannot change it: no request field or query parameter is read for it. A later release may
support custom ports through an **administrator-controlled allowlist** passed in from server
configuration; until then the standard ports are the only option.

### Origin changes

A monitor's saved headers and request body belong to the origin (scheme, normalised host,
effective port) they were entered for. Moving a monitor to a different origin requires explicit
confirmation and removes them in the same transaction (see
[monitor-management.md](../monitor-management.md#origin-changes)). This prevents a compromised
session or a careless edit from forwarding credentials to a new destination.

### What registration checks can't do

A hostname that looks public can resolve to a private address, for example
`api.example.com → 192.168.1.10`, and DNS answers can change at any time (DNS rebinding).
Registration-time validation therefore **cannot** make a hostname safe, and RAIN deliberately does
**not** resolve DNS when a monitor is saved: a lookup at save time proves nothing about the lookup
made when the request is sent. Hostnames such as `localtest.me` or `10.0.0.1.nip.io`, which
resolve to private addresses, pass registration today. They must be stopped by the executor.

## 2. Threats the executor must handle

- Hostnames resolving to private, loopback, link-local or metadata addresses.
- DNS rebinding: a public answer at check time, a private answer at connect time.
- Mixed answers containing both public and private addresses.
- Address encodings that hide a private target (IPv4-mapped IPv6, NAT64, 6to4).
- Redirects to private targets.
- Retries and new connections that re-resolve to a different address.

## 3. Mandatory requirements for the monitoring executor

These are acceptance criteria for the monitoring-engine phase. The executor is not complete until
each one is implemented and covered by tests.

1. Resolve both A and AAAA records at connection time, for every check.
2. Reject every non-public address.
3. Reject the whole DNS response if it mixes public and non-public addresses.
4. Validate IPv4 and IPv6 addresses with the same rules as registration (one shared classifier).
5. Normalise IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) to IPv4 before checking.
6. Block loopback, private, link-local, unique-local and carrier-grade NAT ranges.
7. Block cloud metadata addresses (169.254.169.254, fd00:ec2::254 and the whole link-local ranges).
8. Block NAT64 (64:ff9b::/96, 64:ff9b:1::/48) and 6to4 (2002::/16) addresses that can embed private
   destinations.
9. Block unspecified, multicast, reserved and broadcast ranges.
10. Connect to the exact address that was validated (pin the socket to it, while sending the
    original `Host` header and TLS SNI).
11. Never perform a second, uncontrolled DNS lookup while connecting (custom `lookup` in the HTTP
    agent, no library-internal resolution).
12. Re-validate on every new connection and every retry.
13. Do not follow redirects in V1; a 3xx response is recorded as the check result.
14. In production, enforce network-level egress restrictions as well (security groups or firewall
    rules denying private ranges and the metadata service), so a bug in the application checks is
    not enough to reach internal networks.

A check whose target resolves to a blocked address must fail with a sanitised error (for example
`SSRF_BLOCKED: destination resolves to a non-public address`). It must not reveal the resolved
address to the user, and logs must use `sanitizeUrlForLog` (no query strings or credentials).

## 4. Verification status

| Control                                                               | Status                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Registration-time URL, IP literal and hostname checks                 | PASS (unit tests in `monitor-url.test.ts`)                                            |
| Standard-ports-only policy, API-enforced                              | PASS (unit and route tests); integration test written, BLOCKED (needs Docker)         |
| Origin-change confirmation and credential removal                     | PASS (service and route unit tests); integration test written, BLOCKED (needs Docker) |
| Connection-time DNS validation, address pinning, rebinding protection | PASS (unit: injected resolver and socket factory; local test servers)                 |
| Redirect policy                                                       | PASS (unit: 3xx recorded, never followed)                                             |
| Safe transport required in every environment (no NODE_ENV reliance)   | PASS (unit: a MockAgent or plain Agent is refused with `OUTBOUND_DISABLED`)           |
| Test doubles unreachable from runtime code                            | PASS (ESLint `no-restricted-imports` on `apps/server/src`, outside tests)             |
| Worker refuses to start without the safe transport                    | Implemented (`worker.ts` exits 1); not runtime-verified (needs a fault to trigger)    |
| SSRF refusals recorded but health-neutral                             | PASS (unit and worker end-to-end); integration test written, BLOCKED (needs Docker)   |
| Network-level egress restrictions                                     | BLOCKED — no production deployment yet                                                |

## 5. Implementation (Phase 3.3)

- **Classifier:** `packages/shared/src/ip-address.ts`, shared with registration checks. IPv6 is allowlisted to global unicast (2000::/3) minus known non-public blocks; IPv4-mapped addresses are judged by their IPv4 address.
- **Connector:** `createSafeConnector` refuses non-HTTP(S) schemes, ports other than 80/443, Unix sockets and pre-opened sockets; classifies IP literals directly; resolves hostnames (all A and AAAA records, CNAMEs followed by the resolver) and refuses the hostname if any answer is non-public; then opens the socket to the validated IP itself, so Node performs no lookup.
- **TLS:** `tlsOptionsFor` connects to the IP with `servername` set to the original hostname and `rejectUnauthorized: true`; Node checks the certificate against that hostname. There is no option to disable verification.
- **Per connection:** every new socket repeats resolution and validation, so DNS rebinding between connections is caught.
- **Proxies and redirects:** the transport is a plain undici `Agent` (no `EnvHttpProxyAgent`, no redirect or retry interceptors) passed explicitly to every request; proxy environment variables have no effect.
- **Production wiring:** `createProductionTransport()` returns the safe transport, or `OUTBOUND_DISABLED` if it cannot be built; the worker exits at startup if it gets `OUTBOUND_DISABLED`. In **every** environment (no `NODE_ENV` check) the executor refuses any dispatcher that was not built by `createSafeDispatcher`, so a MockAgent or a plain Agent can never send a check. Tests reach local servers through the same safe dispatcher, with an injected resolver and socket factory (`test-support/local-target.ts`); ESLint forbids runtime code from importing `test-support` or undici's mock classes.
- **No silent reconnects:** undici treats some connect-time errors (`UND_ERR_SOCKET`, `UND_ERR_INFO`) as retryable and reconnects on its own. The connector converts them into a terminal error (`terminalConnectError`), so one check makes exactly one connection attempt and no request is ever sent twice.
- **HEAD connections:** undici closes the socket after every HEAD response by default, which races into a TCP reset on some platforms (about 10–30% false `CONNECTION_ERROR`s on Windows loopback in testing). HEAD checks are sent with `reset: false`. Trade-off: a non-compliant server that sends a body with a HEAD response could corrupt the next response on that pooled connection; idle connections are closed after 4 s.

## 6. Application-level and infrastructure-level protections

The two layers are independent; production needs both.

**Application level (implemented in RAIN):**

| Layer        | Protection                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration | URL rules (scheme, ports 80/443, IP literals, local hostnames, credentials in URLs). Re-applied by the API before a manual check is queued.    |
| Executor     | Same URL rules again; method policy (POST/PUT/PATCH only with persisted consent); 32 KB request bodies; 64 KB response read limit; no retries. |
| Transport    | Connection-time DNS validation of every answer, IP pinning, TLS verification with SNI, per-connection revalidation, no proxies, no redirects.  |
| Worker       | Refuses to start without the safe transport; refusals are recorded as `BLOCKED_DESTINATION` / `CONFIGURATION_ERROR` and never change health.   |
| Logging      | URLs via `sanitizeUrlForLog`; header values and bodies are never logged; database errors are logged by driver code and message only.           |

**Infrastructure level (deployment tasks, not yet done):**

- Run the worker in its own network segment or container with egress allowed only to the public
  internet on TCP 80/443.
- Deny egress to private ranges (RFC 1918, 100.64/10, link-local), the cloud metadata service
  (169.254.169.254, fd00:ec2::254) and the database's network, except the database port itself.
- Require IMDSv2 (or the platform equivalent) so metadata needs a token the worker never sends.
- Give the worker its own database role with only the privileges it needs (`SELECT/UPDATE` on
  `monitors`, `SELECT` on `monitor_headers`, `INSERT` on `monitor_checks`).
- Keep the API process without outbound access to monitored hosts: it only queues checks.

An application bug would then still not reach internal networks, and a network misconfiguration
would still be caught by the application checks.

## 7. Notification webhooks

Webhook destinations are user-chosen too, so they use the same transport, URL rules and
refusals as monitor checks (see [notifications.md](../notifications.md#ssrf-protection)). The webhook
sender refuses any dispatcher that is not the SSRF-safe one, and never follows redirects.
