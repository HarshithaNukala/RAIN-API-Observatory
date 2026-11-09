package com.rain.intelligence.dto;

import java.time.Instant;

public class AnomalyDto {
    private Long healthCheckId;
    private Instant checkedAt;
    private Integer latencyMs;
    private Double baselineAvgMs;
    private Double baselineStdDevMs;

    public AnomalyDto() {
    }

    public AnomalyDto(Long healthCheckId, Instant checkedAt, Integer latencyMs, Double baselineAvgMs, Double baselineStdDevMs) {
        this.healthCheckId = healthCheckId;
        this.checkedAt = checkedAt;
        this.latencyMs = latencyMs;
        this.baselineAvgMs = baselineAvgMs;
        this.baselineStdDevMs = baselineStdDevMs;
    }

    public Long getHealthCheckId() {
        return healthCheckId;
    }

    public void setHealthCheckId(Long healthCheckId) {
        this.healthCheckId = healthCheckId;
    }

    public Instant getCheckedAt() {
        return checkedAt;
    }

    public void setCheckedAt(Instant checkedAt) {
        this.checkedAt = checkedAt;
    }

    public Integer getLatencyMs() {
        return latencyMs;
    }

    public void setLatencyMs(Integer latencyMs) {
        this.latencyMs = latencyMs;
    }

    public Double getBaselineAvgMs() {
        return baselineAvgMs;
    }

    public void setBaselineAvgMs(Double baselineAvgMs) {
        this.baselineAvgMs = baselineAvgMs;
    }

    public Double getBaselineStdDevMs() {
        return baselineStdDevMs;
    }

    public void setBaselineStdDevMs(Double baselineStdDevMs) {
        this.baselineStdDevMs = baselineStdDevMs;
    }
}
