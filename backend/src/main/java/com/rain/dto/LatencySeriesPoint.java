package com.rain.dto;

import java.time.Instant;

public class LatencySeriesPoint {
    private Instant timestamp;
    private Double averageResponseLatencyMs;
    private Double p95ResponseLatencyMs;
    private Double minResponseLatencyMs;
    private Double maxResponseLatencyMs;

    public LatencySeriesPoint() {}

    public Instant getTimestamp() { return timestamp; }
    public void setTimestamp(Instant timestamp) { this.timestamp = timestamp; }
    public Double getAverageResponseLatencyMs() { return averageResponseLatencyMs; }
    public void setAverageResponseLatencyMs(Double averageResponseLatencyMs) { this.averageResponseLatencyMs = averageResponseLatencyMs; }
    public Double getP95ResponseLatencyMs() { return p95ResponseLatencyMs; }
    public void setP95ResponseLatencyMs(Double p95ResponseLatencyMs) { this.p95ResponseLatencyMs = p95ResponseLatencyMs; }
    public Double getMinResponseLatencyMs() { return minResponseLatencyMs; }
    public void setMinResponseLatencyMs(Double minResponseLatencyMs) { this.minResponseLatencyMs = minResponseLatencyMs; }
    public Double getMaxResponseLatencyMs() { return maxResponseLatencyMs; }
    public void setMaxResponseLatencyMs(Double maxResponseLatencyMs) { this.maxResponseLatencyMs = maxResponseLatencyMs; }
}
