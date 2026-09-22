package com.rain.monitoring;

public record HealthCheckResult(
        boolean success,
        int httpStatus,
        int latencyMs,
        String errorType,
        String errorMessage
) {}
