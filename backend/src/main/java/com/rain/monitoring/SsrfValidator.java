package com.rain.monitoring;

import org.springframework.stereotype.Component;
import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.util.Arrays;

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

            InetAddress[] addresses = InetAddress.getAllByName(host);
            for (InetAddress address : addresses) {
                if (isForbiddenAddress(address)) {
                    throw new SecurityException("SSRF Validation Failed: Destination resolves to a forbidden IP: " + address.getHostAddress());
                }
            }
        } catch (UnknownHostException e) {
            throw new SecurityException("SSRF Validation Failed: Unknown host", e);
        } catch (Exception e) {
            throw new SecurityException("SSRF Validation Failed: Invalid URL syntax", e);
        }
    }

    private boolean isForbiddenAddress(InetAddress address) {
        // Reject Loopback
        if (address.isLoopbackAddress()) {
            return true;
        }
        
        // Reject Link Local
        if (address.isLinkLocalAddress()) {
            return true;
        }

        // Reject Site Local (Private IPv4 ranges like 10.x, 192.168.x, 172.16.x)
        if (address.isSiteLocalAddress()) {
            return true;
        }
        
        // Reject Multicast
        if (address.isMulticastAddress()) {
            return true;
        }
        
        // Reject AnyLocal (0.0.0.0)
        if (address.isAnyLocalAddress()) {
            return true;
        }
        
        return false;
    }
}
