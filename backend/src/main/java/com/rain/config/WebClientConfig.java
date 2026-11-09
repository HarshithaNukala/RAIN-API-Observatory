package com.rain.config;

import com.rain.monitoring.SsrfAddressResolverGroup;
import com.rain.monitoring.SsrfValidator;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.netty.http.client.HttpClient;

@Configuration
public class WebClientConfig {

    @Bean
    public WebClient monitoringWebClient(SsrfValidator ssrfValidator) {
        // Do not follow redirects automatically for SSRF protection
        HttpClient httpClient = HttpClient.create()
                .followRedirect(false)
                .resolver(new SsrfAddressResolverGroup(ssrfValidator));

        return WebClient.builder()
                .clientConnector(new ReactorClientHttpConnector(httpClient))
                .build();
    }
}
