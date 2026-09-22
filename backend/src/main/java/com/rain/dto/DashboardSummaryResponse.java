package com.rain.dto;

public class DashboardSummaryResponse {
    private String window;
    private Long totalApis;
    private Long enabledApis;
    private Long pausedApis;
    private Long healthyApis;
    private Long degradedApis;
    private Long downApis;
    private Long unknownApis;
    private Long totalChecks;
    private Long successfulChecks;
    private Long failedChecks;
    private Double overallCheckBasedUptimePercentage;
    private Double overallAverageResponseLatencyMs;
    private Double overallP95ResponseLatencyMs;

    public DashboardSummaryResponse() {}

    public String getWindow() { return window; }
    public void setWindow(String window) { this.window = window; }
    public Long getTotalApis() { return totalApis; }
    public void setTotalApis(Long totalApis) { this.totalApis = totalApis; }
    public Long getEnabledApis() { return enabledApis; }
    public void setEnabledApis(Long enabledApis) { this.enabledApis = enabledApis; }
    public Long getPausedApis() { return pausedApis; }
    public void setPausedApis(Long pausedApis) { this.pausedApis = pausedApis; }
    public Long getHealthyApis() { return healthyApis; }
    public void setHealthyApis(Long healthyApis) { this.healthyApis = healthyApis; }
    public Long getDegradedApis() { return degradedApis; }
    public void setDegradedApis(Long degradedApis) { this.degradedApis = degradedApis; }
    public Long getDownApis() { return downApis; }
    public void setDownApis(Long downApis) { this.downApis = downApis; }
    public Long getUnknownApis() { return unknownApis; }
    public void setUnknownApis(Long unknownApis) { this.unknownApis = unknownApis; }
    public Long getTotalChecks() { return totalChecks; }
    public void setTotalChecks(Long totalChecks) { this.totalChecks = totalChecks; }
    public Long getSuccessfulChecks() { return successfulChecks; }
    public void setSuccessfulChecks(Long successfulChecks) { this.successfulChecks = successfulChecks; }
    public Long getFailedChecks() { return failedChecks; }
    public void setFailedChecks(Long failedChecks) { this.failedChecks = failedChecks; }
    public Double getOverallCheckBasedUptimePercentage() { return overallCheckBasedUptimePercentage; }
    public void setOverallCheckBasedUptimePercentage(Double overallCheckBasedUptimePercentage) { this.overallCheckBasedUptimePercentage = overallCheckBasedUptimePercentage; }
    public Double getOverallAverageResponseLatencyMs() { return overallAverageResponseLatencyMs; }
    public void setOverallAverageResponseLatencyMs(Double overallAverageResponseLatencyMs) { this.overallAverageResponseLatencyMs = overallAverageResponseLatencyMs; }
    public Double getOverallP95ResponseLatencyMs() { return overallP95ResponseLatencyMs; }
    public void setOverallP95ResponseLatencyMs(Double overallP95ResponseLatencyMs) { this.overallP95ResponseLatencyMs = overallP95ResponseLatencyMs; }
}
