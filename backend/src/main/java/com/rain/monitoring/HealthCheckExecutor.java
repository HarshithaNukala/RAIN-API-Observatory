package com.rain.monitoring;

import com.rain.entity.ApiHeader;
import com.rain.entity.ApiService;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;
import reactor.core.publisher.Mono;

import java.time.Duration;

@Component
public class HealthCheckExecutor {

    private final WebClient webClient;
    private final SsrfValidator ssrfValidator;

    public HealthCheckExecutor(@Qualifier("monitoringWebClient") WebClient webClient, SsrfValidator ssrfValidator) {
        this.webClient = webClient;
        this.ssrfValidator = ssrfValidator;
    }

    public HealthCheckResult execute(ApiService apiService) {
        long start = System.nanoTime();
        try {
            // 1. SSRF Validation
            ssrfValidator.validateUrl(apiService.getUrl());

            // 2. Build Request
            WebClient.RequestBodySpec request = webClient
                    .method(org.springframework.http.HttpMethod.valueOf(apiService.getMethod().name()))
                    .uri(apiService.getUrl());

            // Add Headers
            if (apiService.getHeaders() != null) {
                for (ApiHeader header : apiService.getHeaders()) {
                    request.header(header.getHeaderName(), header.getHeaderValue());
                }
            }

            // Add Body if present
            if (apiService.getRequestBody() != null && !apiService.getRequestBody().isEmpty()) {
                request.bodyValue(apiService.getRequestBody());
            }

            // 3. Execute with Timeout using Mono block
            var response = request.exchangeToMono(res -> 
                    Mono.just(res.statusCode().value())
            ).timeout(Duration.ofMillis(apiService.getTimeoutMs())).block();

            int latency = (int) ((System.nanoTime() - start) / 1_000_000);
            return new HealthCheckResult(true, response != null ? response : 0, latency, null, null);

        } catch (SecurityException e) {
            int latency = (int) ((System.nanoTime() - start) / 1_000_000);
            return new HealthCheckResult(false, 0, latency, "SSRF_BLOCKED", e.getMessage());
        } catch (Exception e) {
            int latency = (int) ((System.nanoTime() - start) / 1_000_000);
            String errorType = "UNKNOWN_ERROR";
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            
            if (e.getClass().getName().contains("TimeoutException") || cause.getClass().getName().contains("TimeoutException")) {
                return new HealthCheckResult(false, 0, latency, "TIMEOUT", "Request timed out");
            } else if (cause instanceof java.net.ConnectException) {
                errorType = "CONNECTION_REFUSED";
            } else if (cause instanceof java.net.UnknownHostException) {
                errorType = "DNS_ERROR";
            }
            return new HealthCheckResult(false, 0, latency, errorType, e.getMessage());
        }
    }
}
