package com.rain.monitoring;

import io.netty.resolver.AddressResolver;
import io.netty.resolver.AddressResolverGroup;
import io.netty.resolver.DefaultAddressResolverGroup;
import io.netty.util.concurrent.EventExecutor;
import io.netty.util.concurrent.Future;
import io.netty.util.concurrent.Promise;
import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.util.List;

public class SsrfAddressResolverGroup extends AddressResolverGroup<InetSocketAddress> {

    private final SsrfValidator validator;
    private final AddressResolverGroup<InetSocketAddress> delegate;

    public SsrfAddressResolverGroup(SsrfValidator validator) {
        this(validator, DefaultAddressResolverGroup.INSTANCE);
    }

    public SsrfAddressResolverGroup(SsrfValidator validator, AddressResolverGroup<InetSocketAddress> delegate) {
        this.validator = validator;
        this.delegate = delegate;
    }

    @Override
    protected AddressResolver<InetSocketAddress> newResolver(EventExecutor executor) throws Exception {
        AddressResolver<InetSocketAddress> defaultResolver = delegate.getResolver(executor);
        return new AddressResolver<InetSocketAddress>() {
            @Override
            public boolean isSupported(SocketAddress address) {
                return defaultResolver.isSupported(address);
            }

            @Override
            public boolean isResolved(SocketAddress address) {
                return defaultResolver.isResolved(address);
            }

            @Override
            public Future<InetSocketAddress> resolve(SocketAddress address) {
                return resolve(address, executor.newPromise());
            }

            @Override
            public Future<InetSocketAddress> resolve(SocketAddress address, Promise<InetSocketAddress> promise) {
                Future<InetSocketAddress> future = defaultResolver.resolve(address);
                future.addListener(f -> {
                    if (f.isSuccess()) {
                        InetSocketAddress addr = (InetSocketAddress) f.getNow();
                        try {
                            validator.validateInetAddress(addr.getAddress());
                            promise.setSuccess(addr);
                        } catch (Exception e) {
                            promise.setFailure(e);
                        }
                    } else {
                        promise.setFailure(f.cause());
                    }
                });
                return promise;
            }

            @Override
            public Future<List<InetSocketAddress>> resolveAll(SocketAddress address) {
                return resolveAll(address, executor.newPromise());
            }

            @Override
            public Future<List<InetSocketAddress>> resolveAll(SocketAddress address, Promise<List<InetSocketAddress>> promise) {
                Future<List<InetSocketAddress>> future = defaultResolver.resolveAll(address);
                future.addListener(f -> {
                    if (f.isSuccess()) {
                        @SuppressWarnings("unchecked")
                        List<InetSocketAddress> addrs = (List<InetSocketAddress>) f.getNow();
                        try {
                            for (InetSocketAddress addr : addrs) {
                                validator.validateInetAddress(addr.getAddress());
                            }
                            promise.setSuccess(addrs);
                        } catch (Exception e) {
                            promise.setFailure(e);
                        }
                    } else {
                        promise.setFailure(f.cause());
                    }
                });
                return promise;
            }

            @Override
            public void close() {
                defaultResolver.close();
            }
        };
    }
}
