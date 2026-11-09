package com.rain.monitoring;

import org.springframework.stereotype.Component;
import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;

@Component
public class SsrfValidator {

    public void validateUrl(String urlString) {
        try {
            URI uri = new URI(urlString);
            String scheme = uri.getScheme();
            if (scheme == null || (!scheme.equalsIgnoreCase("http") && !scheme.equalsIgnoreCase("https"))) {
                throw new SecurityException("SSRF Validation Failed: Only HTTP and HTTPS are allowed");
            }

            String host = uri.getHost();
            if (host == null) {
                throw new SecurityException("SSRF Validation Failed: Host cannot be null");
            }
        } catch (SecurityException e) {
            throw e;
        } catch (Exception e) {
            throw new SecurityException("SSRF Validation Failed: Invalid URL syntax", e);
        }
    }

    public void validateInetAddress(InetAddress address) {
        if (address == null || isForbiddenAddress(address)) {
            throw new SecurityException("SSRF Validation Failed: Destination resolves to a forbidden IP: " + (address != null ? address.getHostAddress() : "null"));
        }
    }

    private boolean isForbiddenAddress(InetAddress address) {
        if (address == null) {
            return true;
        }

        InetAddress target = normalizeAddress(address);

        // Reject Loopback
        if (target.isLoopbackAddress()) {
            return true;
        }
        
        // Reject Link Local (including 169.254.0.0/16 cloud metadata and fe80::/10)
        if (target.isLinkLocalAddress()) {
            return true;
        }

        // Reject Site Local (Private IPv4 ranges like 10.x, 192.168.x, 172.16.x and fec0::/10)
        if (target.isSiteLocalAddress()) {
            return true;
        }
        
        // Reject Multicast
        if (target.isMulticastAddress()) {
            return true;
        }
        
        // Reject AnyLocal (0.0.0.0, ::)
        if (target.isAnyLocalAddress()) {
            return true;
        }

        byte[] bytes = target.getAddress();

        // Reject IPv4 Carrier-Grade NAT (100.64.0.0/10, covering 100.64.0.0 to 100.127.255.255)
        if (isCarrierGradeNat(bytes)) {
            return true;
        }

        // Reject IPv6 Unique Local Addresses (fc00::/7 covering fc00::/8 and fd00::/8)
        if (isIpv6UniqueLocalAddress(bytes)) {
            return true;
        }
        
        return false;
    }

    private InetAddress normalizeAddress(InetAddress address) {
        byte[] bytes = address.getAddress();
        if (bytes.length == 16) {
            // Check for IPv4-mapped IPv6 (::ffff:x.x.x.x)
            boolean isMapped = true;
            for (int i = 0; i < 10; i++) {
                if (bytes[i] != 0) {
                    isMapped = false;
                    break;
                }
            }
            if (isMapped && bytes[10] == (byte) 0xFF && bytes[11] == (byte) 0xFF) {
                try {
                    byte[] ipv4 = new byte[4];
                    System.arraycopy(bytes, 12, ipv4, 0, 4);
                    return InetAddress.getByAddress(ipv4);
                } catch (UnknownHostException ignored) {
                }
            }

            // Check for IPv4-compatible IPv6 (::x.x.x.x)
            boolean isCompatible = true;
            for (int i = 0; i < 12; i++) {
                if (bytes[i] != 0) {
                    isCompatible = false;
                    break;
                }
            }
            if (isCompatible && !(bytes[12] == 0 && bytes[13] == 0 && bytes[14] == 0 && (bytes[15] == 0 || bytes[15] == 1))) {
                try {
                    byte[] ipv4 = new byte[4];
                    System.arraycopy(bytes, 12, ipv4, 0, 4);
                    return InetAddress.getByAddress(ipv4);
                } catch (UnknownHostException ignored) {
                }
            }
        }
        return address;
    }

    private boolean isCarrierGradeNat(byte[] bytes) {
        if (bytes.length != 4) {
            return false;
        }
        int b0 = bytes[0] & 0xFF;
        int b1 = bytes[1] & 0xFF;
        return b0 == 100 && (b1 & 0xC0) == 0x40;
    }

    private boolean isIpv6UniqueLocalAddress(byte[] bytes) {
        if (bytes.length != 16) {
            return false;
        }
        int b0 = bytes[0] & 0xFF;
        return (b0 & 0xFE) == 0xFC;
    }
}
