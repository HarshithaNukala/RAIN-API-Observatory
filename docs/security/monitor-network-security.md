# Monitor network security

A monitor makes RAIN send HTTP requests to an address a user chose. Without controls that is a
server-side request forgery (SSRF) primitive: it could reach the cloud metadata service, internal
admin panels or other private networks. This document records what is enforced today, at
monitor **registration**, and what the monitoring **executor** must enforce when it is built.

> **Status:** the monitoring executor does not exist yet. No outbound health-check request is ever
> made by the current code. Full DNS/SSRF runtime protection is **BLOCKED** until the executor is
> implemented and tested against the requirements in §3.

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
| Connection-time DNS validation, address pinning, rebinding protection | BLOCKED — monitoring executor not implemented                                         |
| Redirect policy                                                       | BLOCKED — monitoring executor not implemented                                         |
| Network-level egress restrictions                                     | BLOCKED — no production deployment yet                                                |
