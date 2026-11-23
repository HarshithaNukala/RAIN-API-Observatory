/**
 * TEST ONLY. A throwaway self-signed certificate for api.example.com (EC P-256, valid until 2036),
 * generated with openssl for these tests. It is trusted by nothing, guards nothing, and lets the
 * safe-transport tests run a real TLS handshake against a local server.
 */
export const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBpTCCAUugAwIBAgIUAbUIGpYkEqborL6frelfnp/i49QwCgYIKoZIzj0EAwIw
GjEYMBYGA1UEAwwPYXBpLmV4YW1wbGUuY29tMB4XDTI2MTExNzE3NDMzMFoXDTM2
MTExNDE3NDMzMFowGjEYMBYGA1UEAwwPYXBpLmV4YW1wbGUuY29tMFkwEwYHKoZI
zj0CAQYIKoZIzj0DAQcDQgAEynMLmU9V+apMGNfogdC4MVgQDQbX6pWdlqv8hfqh
ZuzcitU/ZOtb9uqFumWzQKPBOblkDQaLSMxXUja9vXLM4aNvMG0wHQYDVR0OBBYE
FJpFyj03RKnTZ3PwhI1dpY+79DPhMB8GA1UdIwQYMBaAFJpFyj03RKnTZ3PwhI1d
pY+79DPhMA8GA1UdEwEB/wQFMAMBAf8wGgYDVR0RBBMwEYIPYXBpLmV4YW1wbGUu
Y29tMAoGCCqGSM49BAMCA0gAMEUCIALT9uPTQACvELe0oU0rPmS6COT+orxuX9IF
dCr+CXnpAiEA/wMN37mswBDRNYnjmfMbwM5hXuSa0I5dGLeMk9DahG0=
-----END CERTIFICATE-----
`;

export const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgBwjPZSg4/n+XZmGD
Ju+LrldjEvbafDni5GeZl//hs6OhRANCAATKcwuZT1X5qkwY1+iB0LgxWBANBtfq
lZ2Wq/yF+qFm7NyK1T9k61v26oW6ZbNAo8E5uWQNBotIzFdSNr29cszh
-----END PRIVATE KEY-----
`;
