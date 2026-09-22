package com.rain.dto;

import com.rain.entity.ApiStatus;
import java.time.Instant;

public class ApiMetricsResponse {
    private String window;
    private Long totalChecks;
    private Long successfulChecks;
    private Long failedChecks;
    private Double uptimePercentage;
    private Double failureRate;
    private Double averageResponseLatencyMs;
    private Double p95ResponseLatencyMs;
    private ApiStatus currentStatus;
    private Instant lastCheckedAt;
    private Instant lastSuccessfulAt;
    private Instant lastFailedAt;

    public ApiMetricsResponse() {}

    public String getWindow() { return window; }
    public void setWindow(String window) { this.window = window; }
    public Long getTotalChecks() { return totalChecks; }
    public void setTotalChecks(Long totalChecks) { this.totalChecks = totalChecks; }
    public Long getSuccessfulChecks() { return successfulChecks; }
    public void setSuccessfulChecks(Long successfulChecks) { this.successfulChecks = successfulChecks; }
    public Long getFailedChecks() { return failedChecks; }
    public void setFailedChecks(Long failedChecks) { this.failedChecks = failedChecks; }
    public Double getUptimePercentage() { return uptimePercentage; }
    public void setUptimePercentage(Double uptimePercentage) { this.uptimePercentage = uptimePercentage; }
    public Double getFailureRate() { return failureRate; }
    public void setFailureRate(Double failureRate) { this.failureRate = failureRate; }
    public Double getAverageResponseLatencyMs() { return averageResponseLatencyMs; }
    public void setAverageResponseLatencyMs(Double averageResponseLatencyMs) { this.averageResponseLatencyMs = averageResponseLatencyMs; }
    public Double getP95ResponseLatencyMs() { return p95ResponseLatencyMs; }
    public void setP95ResponseLatencyMs(Double p95ResponseLatencyMs) { this.p95ResponseLatencyMs = p95ResponseLatencyMs; }
    public ApiStatus getCurrentStatus() { return currentStatus; }
    public void setCurrentStatus(ApiStatus currentStatus) { this.currentStatus = currentStatus; }
    public Instant getLastCheckedAt() { return lastCheckedAt; }
    public void setLastCheckedAt(Instant lastCheckedAt) { this.lastCheckedAt = lastCheckedAt; }
    public Instant getLastSuccessfulAt() { return lastSuccessfulAt; }
    public void setLastSuccessfulAt(Instant lastSuccessfulAt) { this.lastSuccessfulAt = lastSuccessfulAt; }
    public Instant getLastFailedAt() { return lastFailedAt; }
    public void setLastFailedAt(Instant lastFailedAt) { this.lastFailedAt = lastFailedAt; }
}
