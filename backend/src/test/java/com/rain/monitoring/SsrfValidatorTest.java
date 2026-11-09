package com.rain.monitoring;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.net.Inet6Address;
import java.net.InetAddress;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class SsrfValidatorTest {

    private SsrfValidator validator;

    @BeforeEach
    void setUp() {
        validator = new SsrfValidator();
    }

    private InetAddress createInet6Address(byte[] bytes) throws Exception {
        return Inet6Address.getByAddress("test-host", bytes, null);
    }

    private InetAddress createMappedIpv6Address(int b0, int b1, int b2, int b3) throws Exception {
        byte[] bytes = new byte[16];
        bytes[10] = (byte) 0xFF;
        bytes[11] = (byte) 0xFF;
        bytes[12] = (byte) b0;
        bytes[13] = (byte) b1;
        bytes[14] = (byte) b2;
        bytes[15] = (byte) b3;
        return createInet6Address(bytes);
    }

    @Nested
    @DisplayName("Carrier-Grade NAT (CGNAT) 100.64.0.0/10")
    class CgnatTests {

        @Test
        @DisplayName("Lower boundary 100.64.0.0 is blocked")
        void testLowerBoundaryBlocked() throws Exception {
            InetAddress addr = InetAddress.getByName("100.64.0.0");
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @Test
        @DisplayName("Upper boundary 100.127.255.255 is blocked")
        void testUpperBoundaryBlocked() throws Exception {
            InetAddress addr = InetAddress.getByName("100.127.255.255");
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @Test
        @DisplayName("Representative address 100.100.100.200 (Alibaba metadata) is blocked")
        void testRepresentativeAddressBlocked() throws Exception {
            InetAddress addr = InetAddress.getByName("100.100.100.200");
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @ParameterizedTest
        @ValueSource(strings = {
                "100.64.0.1",
                "100.70.1.2",
                "100.90.200.1",
                "100.127.0.1",
                "100.127.255.254"
        })
        @DisplayName("Internal CGNAT range addresses are blocked")
        void testInternalCgnatAddressesBlocked(String ip) throws Exception {
            InetAddress addr = InetAddress.getByName(ip);
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @Test
        @DisplayName("Immediately outside lower boundary 100.63.255.255 is permitted")
        void testOutsideLowerBoundaryPermitted() throws Exception {
            InetAddress addr = InetAddress.getByName("100.63.255.255");
            assertThatCode(() -> validator.validateInetAddress(addr))
                    .doesNotThrowAnyException();
        }

        @Test
        @DisplayName("Immediately outside upper boundary 100.128.0.0 is permitted")
        void testOutsideUpperBoundaryPermitted() throws Exception {
            InetAddress addr = InetAddress.getByName("100.128.0.0");
            assertThatCode(() -> validator.validateInetAddress(addr))
                    .doesNotThrowAnyException();
        }

        @ParameterizedTest
        @ValueSource(strings = {
                "99.64.0.0",
                "101.64.0.0",
                "100.0.0.1",
                "100.63.0.1",
                "100.128.0.1",
                "100.200.0.1"
        })
        @DisplayName("Other addresses outside 100.64.0.0/10 are not rejected by CGNAT rule")
        void testOutsideCgnatPermitted(String ip) throws Exception {
            InetAddress addr = InetAddress.getByName(ip);
            assertThatCode(() -> validator.validateInetAddress(addr))
                    .doesNotThrowAnyException();
        }
    }

    @Nested
    @DisplayName("IPv6 Unique Local Addresses (fc00::/7)")
    class Ipv6UniqueLocalTests {

        @Test
        @DisplayName("fc00:: lower range is blocked")
        void testFc00Blocked() throws Exception {
            InetAddress addr = InetAddress.getByName("fc00::");
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @Test
        @DisplayName("fc00::1 is blocked")
        void testFc001Blocked() throws Exception {
            InetAddress addr = InetAddress.getByName("fc00::1");
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @Test
        @DisplayName("fcff:ffff:ffff:ffff:ffff:ffff:ffff:ffff (upper fc00::/8) is blocked")
        void testFcffBlocked() throws Exception {
            InetAddress addr = InetAddress.getByName("fcff:ffff:ffff:ffff:ffff:ffff:ffff:ffff");
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @Test
        @DisplayName("fd00:: is blocked")
        void testFd00Blocked() throws Exception {
            InetAddress addr = InetAddress.getByName("fd00::");
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @Test
        @DisplayName("fd00::1 is blocked")
        void testFd001Blocked() throws Exception {
            InetAddress addr = InetAddress.getByName("fd00::1");
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @Test
        @DisplayName("fd00:ec2::254 (AWS IPv6 IMDS metadata) is blocked")
        void testAwsIpv6MetadataBlocked() throws Exception {
            InetAddress addr = InetAddress.getByName("fd00:ec2::254");
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @Test
        @DisplayName("fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff (upper fd00::/8) is blocked")
        void testFdffBlocked() throws Exception {
            InetAddress addr = InetAddress.getByName("fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff");
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @Test
        @DisplayName("Immediately outside lower boundary fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff is permitted")
        void testOutsideLowerBoundaryPermitted() throws Exception {
            InetAddress addr = InetAddress.getByName("fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff");
            assertThatCode(() -> validator.validateInetAddress(addr))
                    .doesNotThrowAnyException();
        }

        @Test
        @DisplayName("Immediately outside upper boundary fe00::1 is permitted by ULA rule")
        void testOutsideUpperBoundaryPermitted() throws Exception {
            InetAddress addr = InetAddress.getByName("fe00::1");
            assertThatCode(() -> validator.validateInetAddress(addr))
                    .doesNotThrowAnyException();
        }
    }

    @Nested
    @DisplayName("IPv4-Mapped and IPv4-Compatible IPv6 Handling")
    class Ipv4MappedIpv6Tests {

        @Test
        @DisplayName("IPv4-mapped loopback ::ffff:127.0.0.1 is blocked (String parsing)")
        void testMappedLoopbackStringBlocked() throws Exception {
            InetAddress addr = InetAddress.getByName("::ffff:127.0.0.1");
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @Test
        @DisplayName("IPv4-mapped loopback as explicit Inet6Address object is blocked")
        void testMappedLoopbackInet6Blocked() throws Exception {
            InetAddress addr = createMappedIpv6Address(127, 0, 0, 1);
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @ParameterizedTest
        @ValueSource(strings = {
                "::ffff:10.0.0.1",
                "::ffff:172.16.0.1",
                "::ffff:172.31.255.254",
                "::ffff:192.168.1.1"
        })
        @DisplayName("IPv4-mapped RFC 1918 private addresses are blocked")
        void testMappedPrivateAddressesBlocked(String ip) throws Exception {
            InetAddress addr = InetAddress.getByName(ip);
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @Test
        @DisplayName("IPv4-mapped RFC 1918 as explicit Inet6Address object is blocked")
        void testMappedPrivateInet6Blocked() throws Exception {
            InetAddress addr = createMappedIpv6Address(10, 0, 0, 1);
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @Test
        @DisplayName("IPv4-mapped link-local / metadata ::ffff:169.254.169.254 is blocked")
        void testMappedMetadataBlocked() throws Exception {
            InetAddress addr = InetAddress.getByName("::ffff:169.254.169.254");
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @Test
        @DisplayName("IPv4-mapped link-local as explicit Inet6Address object is blocked")
        void testMappedMetadataInet6Blocked() throws Exception {
            InetAddress addr = createMappedIpv6Address(169, 254, 169, 254);
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @Test
        @DisplayName("IPv4-mapped CGNAT lower boundary ::ffff:100.64.0.0 is blocked")
        void testMappedCgnatLowerBoundaryBlocked() throws Exception {
            InetAddress addr = createMappedIpv6Address(100, 64, 0, 0);
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @Test
        @DisplayName("IPv4-mapped CGNAT upper boundary ::ffff:100.127.255.255 is blocked")
        void testMappedCgnatUpperBoundaryBlocked() throws Exception {
            InetAddress addr = createMappedIpv6Address(100, 127, 255, 255);
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @Test
        @DisplayName("IPv4-mapped CGNAT representative ::ffff:100.100.100.200 is blocked")
        void testMappedCgnatRepresentativeBlocked() throws Exception {
            InetAddress addr = createMappedIpv6Address(100, 100, 100, 200);
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @Test
        @DisplayName("IPv4-mapped anylocal ::ffff:0.0.0.0 is blocked")
        void testMappedAnyLocalBlocked() throws Exception {
            InetAddress addr = createMappedIpv6Address(0, 0, 0, 0);
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @Test
        @DisplayName("IPv4-mapped multicast ::ffff:224.0.0.1 is blocked")
        void testMappedMulticastBlocked() throws Exception {
            InetAddress addr = createMappedIpv6Address(224, 0, 0, 1);
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @Test
        @DisplayName("IPv4-compatible loopback ::127.0.0.1 as Inet6Address is blocked")
        void testCompatibleLoopbackBlocked() throws Exception {
            byte[] bytes = new byte[16];
            bytes[12] = 127;
            bytes[13] = 0;
            bytes[14] = 0;
            bytes[15] = 1;
            InetAddress addr = createInet6Address(bytes);
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @Test
        @DisplayName("IPv4-mapped public address ::ffff:8.8.8.8 is permitted")
        void testMappedPublicAddressPermitted() throws Exception {
            InetAddress addr = createMappedIpv6Address(8, 8, 8, 8);
            assertThatCode(() -> validator.validateInetAddress(addr))
                    .doesNotThrowAnyException();
        }

        @Test
        @DisplayName("IPv4-mapped outside CGNAT ::ffff:100.63.255.255 is permitted")
        void testMappedOutsideCgnatLowerPermitted() throws Exception {
            InetAddress addr = createMappedIpv6Address(100, 63, 255, 255);
            assertThatCode(() -> validator.validateInetAddress(addr))
                    .doesNotThrowAnyException();
        }

        @Test
        @DisplayName("IPv4-mapped outside CGNAT ::ffff:100.128.0.0 is permitted")
        void testMappedOutsideCgnatUpperPermitted() throws Exception {
            InetAddress addr = createMappedIpv6Address(100, 128, 0, 0);
            assertThatCode(() -> validator.validateInetAddress(addr))
                    .doesNotThrowAnyException();
        }
    }

    @Nested
    @DisplayName("Existing Prohibited Destinations (Loopback, Link-Local, Private, Multicast, AnyLocal)")
    class ExistingProhibitedDestinationsTests {

        @ParameterizedTest
        @ValueSource(strings = {
                "127.0.0.1",
                "127.0.0.2",
                "127.255.255.255",
                "::1"
        })
        @DisplayName("Loopback addresses are blocked")
        void testLoopbackBlocked(String ip) throws Exception {
            InetAddress addr = InetAddress.getByName(ip);
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @ParameterizedTest
        @ValueSource(strings = {
                "169.254.169.254",
                "169.254.0.1",
                "169.254.255.255",
                "fe80::1",
                "fe80::ec2:254"
        })
        @DisplayName("Link-local and cloud metadata addresses are blocked")
        void testLinkLocalBlocked(String ip) throws Exception {
            InetAddress addr = InetAddress.getByName(ip);
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @ParameterizedTest
        @ValueSource(strings = {
                "10.0.0.1",
                "10.255.255.255",
                "172.16.0.1",
                "172.31.255.255",
                "192.168.0.1",
                "192.168.255.255",
                "fec0::1"
        })
        @DisplayName("Private site-local networks are blocked")
        void testPrivateNetworksBlocked(String ip) throws Exception {
            InetAddress addr = InetAddress.getByName(ip);
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @ParameterizedTest
        @ValueSource(strings = {
                "0.0.0.0",
                "::"
        })
        @DisplayName("AnyLocal addresses are blocked")
        void testAnyLocalBlocked(String ip) throws Exception {
            InetAddress addr = InetAddress.getByName(ip);
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @ParameterizedTest
        @ValueSource(strings = {
                "224.0.0.1",
                "239.255.255.250",
                "ff02::1"
        })
        @DisplayName("Multicast addresses are blocked")
        void testMulticastBlocked(String ip) throws Exception {
            InetAddress addr = InetAddress.getByName(ip);
            assertThatThrownBy(() -> validator.validateInetAddress(addr))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }

        @Test
        @DisplayName("Null address is rejected")
        void testNullAddressRejected() {
            assertThatThrownBy(() -> validator.validateInetAddress(null))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("SSRF Validation Failed");
        }
    }

    @Nested
    @DisplayName("Allowed Public Destinations")
    class AllowedDestinationsTests {

        @ParameterizedTest
        @ValueSource(strings = {
                "8.8.8.8",
                "1.1.1.1",
                "93.184.216.34",
                "104.244.42.1",
                "142.250.190.46"
        })
        @DisplayName("Valid public IPv4 addresses are permitted")
        void testPublicIpv4Permitted(String ip) throws Exception {
            InetAddress addr = InetAddress.getByName(ip);
            assertThatCode(() -> validator.validateInetAddress(addr))
                    .doesNotThrowAnyException();
        }

        @ParameterizedTest
        @ValueSource(strings = {
                "2607:f8b0:4005:805::200e",
                "2001:4860:4860::8888",
                "2606:4700:4700::1111"
        })
        @DisplayName("Valid public IPv6 addresses are permitted")
        void testPublicIpv6Permitted(String ip) throws Exception {
            InetAddress addr = InetAddress.getByName(ip);
            assertThatCode(() -> validator.validateInetAddress(addr))
                    .doesNotThrowAnyException();
        }
    }

    @Nested
    @DisplayName("URL Scheme and Syntax Validation")
    class UrlValidationTests {

        @ParameterizedTest
        @ValueSource(strings = {
                "http://example.com/health",
                "https://example.com/api/v1/status",
                "HTTP://API.TEST.COM:8080/PING",
                "https://104.244.42.1/check"
        })
        @DisplayName("Valid HTTP and HTTPS URLs pass URL validation")
        void testValidUrlsPass(String url) {
            assertThatCode(() -> validator.validateUrl(url))
                    .doesNotThrowAnyException();
        }

        @ParameterizedTest
        @ValueSource(strings = {
                "ftp://example.com/file",
                "gopher://example.com",
                "file:///etc/passwd",
                "file://c:/windows/win.ini",
                "dict://example.com",
                "ldap://example.com",
                "javascript:alert(1)"
        })
        @DisplayName("Prohibited URL schemes are rejected")
        void testProhibitedSchemesRejected(String url) {
            assertThatThrownBy(() -> validator.validateUrl(url))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("Only HTTP and HTTPS are allowed");
        }

        @Test
        @DisplayName("Missing host is rejected")
        void testMissingHostRejected() {
            assertThatThrownBy(() -> validator.validateUrl("http:///path"))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("Host cannot be null");
        }

        @Test
        @DisplayName("Invalid URL syntax is rejected")
        void testInvalidSyntaxRejected() {
            assertThatThrownBy(() -> validator.validateUrl("not a valid url ://"))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("Invalid URL syntax");
        }
    }
}
