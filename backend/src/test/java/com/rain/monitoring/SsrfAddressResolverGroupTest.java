package com.rain.monitoring;

import io.netty.resolver.AddressResolver;
import io.netty.resolver.AddressResolverGroup;
import io.netty.util.concurrent.EventExecutor;
import io.netty.util.concurrent.Future;
import io.netty.util.concurrent.Promise;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.util.Collections;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

public class SsrfAddressResolverGroupTest {

    private SsrfValidator ssrfValidator;
    private EventExecutor executor;
    private AddressResolverGroup<InetSocketAddress> delegateGroup;
    private AddressResolver<InetSocketAddress> delegateResolver;
    private Promise<InetSocketAddress> promise;
    private Future<InetSocketAddress> delegateFuture;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() throws Exception {
        ssrfValidator = new SsrfValidator();
        executor = mock(EventExecutor.class);
        delegateGroup = mock(AddressResolverGroup.class);
        delegateResolver = mock(AddressResolver.class);
        promise = mock(Promise.class);
        delegateFuture = mock(Future.class);

        when(executor.terminationFuture()).thenReturn(mock(Future.class));
        when(delegateGroup.getResolver(executor)).thenReturn(delegateResolver);
        when(executor.<InetSocketAddress>newPromise()).thenReturn(promise);
        when(delegateResolver.resolve(any(SocketAddress.class))).thenReturn(delegateFuture);
        
        // Mock addListener to immediately execute the listener
        doAnswer(invocation -> {
            io.netty.util.concurrent.GenericFutureListener<Future<InetSocketAddress>> listener = invocation.getArgument(0);
            listener.operationComplete(delegateFuture);
            return delegateFuture;
        }).when(delegateFuture).addListener(any());
    }

    @Test
    void testResolveValidAddress() throws Exception {
        SsrfAddressResolverGroup group = new SsrfAddressResolverGroup(ssrfValidator, delegateGroup);
        AddressResolver<InetSocketAddress> resolver = group.getResolver(executor);

        // Simulate Netty resolving to a valid external IP
        InetSocketAddress safeAddress = new InetSocketAddress(InetAddress.getByName("8.8.8.8"), 80);
        when(delegateFuture.isSuccess()).thenReturn(true);
        when(delegateFuture.getNow()).thenReturn(safeAddress);

        resolver.resolve(InetSocketAddress.createUnresolved("example.com", 80));

        verify(promise).setSuccess(safeAddress);
        verify(promise, never()).setFailure(any());
    }

    @Test
    void testResolveForbiddenAddress_DNSRebinding() throws Exception {
        SsrfAddressResolverGroup group = new SsrfAddressResolverGroup(ssrfValidator, delegateGroup);
        AddressResolver<InetSocketAddress> resolver = group.getResolver(executor);

        // Simulate Netty resolving to a loopback IP (DNS Rebinding scenario where it returns 127.0.0.1)
        InetSocketAddress maliciousAddress = new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 80);
        when(delegateFuture.isSuccess()).thenReturn(true);
        when(delegateFuture.getNow()).thenReturn(maliciousAddress);

        resolver.resolve(InetSocketAddress.createUnresolved("example.com", 80));

        verify(promise).setFailure(any(SecurityException.class));
        verify(promise, never()).setSuccess(any());
    }

    @Test
    void testResolveForbiddenAddress_CgnatBoundary() throws Exception {
        SsrfAddressResolverGroup group = new SsrfAddressResolverGroup(ssrfValidator, delegateGroup);
        AddressResolver<InetSocketAddress> resolver = group.getResolver(executor);

        InetSocketAddress cgnatAddress = new InetSocketAddress(InetAddress.getByName("100.64.0.0"), 80);
        when(delegateFuture.isSuccess()).thenReturn(true);
        when(delegateFuture.getNow()).thenReturn(cgnatAddress);

        resolver.resolve(InetSocketAddress.createUnresolved("attacker.internal", 80));

        verify(promise).setFailure(any(SecurityException.class));
        verify(promise, never()).setSuccess(any());
    }

    @Test
    void testResolveForbiddenAddress_CgnatRepresentative() throws Exception {
        SsrfAddressResolverGroup group = new SsrfAddressResolverGroup(ssrfValidator, delegateGroup);
        AddressResolver<InetSocketAddress> resolver = group.getResolver(executor);

        InetSocketAddress cgnatAddress = new InetSocketAddress(InetAddress.getByName("100.100.100.200"), 80);
        when(delegateFuture.isSuccess()).thenReturn(true);
        when(delegateFuture.getNow()).thenReturn(cgnatAddress);

        resolver.resolve(InetSocketAddress.createUnresolved("metadata.cloud", 80));

        verify(promise).setFailure(any(SecurityException.class));
        verify(promise, never()).setSuccess(any());
    }

    @Test
    void testResolveForbiddenAddress_Ipv6UniqueLocal() throws Exception {
        SsrfAddressResolverGroup group = new SsrfAddressResolverGroup(ssrfValidator, delegateGroup);
        AddressResolver<InetSocketAddress> resolver = group.getResolver(executor);

        InetSocketAddress ulaAddress = new InetSocketAddress(InetAddress.getByName("fd00::1"), 80);
        when(delegateFuture.isSuccess()).thenReturn(true);
        when(delegateFuture.getNow()).thenReturn(ulaAddress);

        resolver.resolve(InetSocketAddress.createUnresolved("internal.lan", 80));

        verify(promise).setFailure(any(SecurityException.class));
        verify(promise, never()).setSuccess(any());
    }

    @Test
    void testResolveForbiddenAddress_Ipv4MappedLoopback() throws Exception {
        SsrfAddressResolverGroup group = new SsrfAddressResolverGroup(ssrfValidator, delegateGroup);
        AddressResolver<InetSocketAddress> resolver = group.getResolver(executor);

        byte[] mappedBytes = new byte[16];
        mappedBytes[10] = (byte) 0xFF;
        mappedBytes[11] = (byte) 0xFF;
        mappedBytes[12] = 127;
        mappedBytes[13] = 0;
        mappedBytes[14] = 0;
        mappedBytes[15] = 1;
        java.net.Inet6Address mappedAddr = java.net.Inet6Address.getByAddress("mapped-host", mappedBytes, null);

        InetSocketAddress maliciousAddress = new InetSocketAddress(mappedAddr, 80);
        when(delegateFuture.isSuccess()).thenReturn(true);
        when(delegateFuture.getNow()).thenReturn(maliciousAddress);

        resolver.resolve(InetSocketAddress.createUnresolved("mapped.attack", 80));

        verify(promise).setFailure(any(SecurityException.class));
        verify(promise, never()).setSuccess(any());
    }

    @Test
    @SuppressWarnings("unchecked")
    void testResolveAllWithProhibitedAddress() throws Exception {
        Promise<List<InetSocketAddress>> listPromise = mock(Promise.class);
        Future<List<InetSocketAddress>> delegateListFuture = mock(Future.class);
        when(executor.<List<InetSocketAddress>>newPromise()).thenReturn(listPromise);
        when(delegateResolver.resolveAll(any(SocketAddress.class))).thenReturn(delegateListFuture);

        doAnswer(invocation -> {
            io.netty.util.concurrent.GenericFutureListener<Future<List<InetSocketAddress>>> listener = invocation.getArgument(0);
            listener.operationComplete(delegateListFuture);
            return delegateListFuture;
        }).when(delegateListFuture).addListener(any());

        SsrfAddressResolverGroup group = new SsrfAddressResolverGroup(ssrfValidator, delegateGroup);
        AddressResolver<InetSocketAddress> resolver = group.getResolver(executor);

        List<InetSocketAddress> addrs = List.of(
                new InetSocketAddress(InetAddress.getByName("8.8.8.8"), 80),
                new InetSocketAddress(InetAddress.getByName("100.64.0.1"), 80)
        );
        when(delegateListFuture.isSuccess()).thenReturn(true);
        when(delegateListFuture.getNow()).thenReturn(addrs);

        resolver.resolveAll(InetSocketAddress.createUnresolved("dual.example.com", 80));

        verify(listPromise).setFailure(any(SecurityException.class));
        verify(listPromise, never()).setSuccess(any());
    }

    @Test
    @SuppressWarnings("unchecked")
    void testResolveAllWithValidAddresses() throws Exception {
        Promise<List<InetSocketAddress>> listPromise = mock(Promise.class);
        Future<List<InetSocketAddress>> delegateListFuture = mock(Future.class);
        when(executor.<List<InetSocketAddress>>newPromise()).thenReturn(listPromise);
        when(delegateResolver.resolveAll(any(SocketAddress.class))).thenReturn(delegateListFuture);

        doAnswer(invocation -> {
            io.netty.util.concurrent.GenericFutureListener<Future<List<InetSocketAddress>>> listener = invocation.getArgument(0);
            listener.operationComplete(delegateListFuture);
            return delegateListFuture;
        }).when(delegateListFuture).addListener(any());

        SsrfAddressResolverGroup group = new SsrfAddressResolverGroup(ssrfValidator, delegateGroup);
        AddressResolver<InetSocketAddress> resolver = group.getResolver(executor);

        List<InetSocketAddress> addrs = List.of(
                new InetSocketAddress(InetAddress.getByName("8.8.8.8"), 80),
                new InetSocketAddress(InetAddress.getByName("1.1.1.1"), 80)
        );
        when(delegateListFuture.isSuccess()).thenReturn(true);
        when(delegateListFuture.getNow()).thenReturn(addrs);

        resolver.resolveAll(InetSocketAddress.createUnresolved("dual.example.com", 80));

        verify(listPromise).setSuccess(addrs);
        verify(listPromise, never()).setFailure(any());
    }
}
