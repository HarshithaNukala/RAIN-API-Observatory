package com.rain.intelligence.dto;

import java.util.List;

public class ServiceIntelligenceResponse {
    private Double reliabilityScore;
    private String scoreTrend;
    private Integer totalAnomalies;
    private List<AnomalyDto> anomalies;
    private List<ErrorTypeDto> topErrorTypes;
    private Long avgRecoveryTimeMs;
    private List<String> rootCauseHints;

    public Double getReliabilityScore() {
        return reliabilityScore;
    }

    public void setReliabilityScore(Double reliabilityScore) {
        this.reliabilityScore = reliabilityScore;
    }

    public String getScoreTrend() {
        return scoreTrend;
    }

    public void setScoreTrend(String scoreTrend) {
        this.scoreTrend = scoreTrend;
    }

    public Integer getTotalAnomalies() {
        return totalAnomalies;
    }

    public void setTotalAnomalies(Integer totalAnomalies) {
        this.totalAnomalies = totalAnomalies;
    }

    public List<AnomalyDto> getAnomalies() {
        return anomalies;
    }

    public void setAnomalies(List<AnomalyDto> anomalies) {
        this.anomalies = anomalies;
    }

    public List<ErrorTypeDto> getTopErrorTypes() {
        return topErrorTypes;
    }

    public void setTopErrorTypes(List<ErrorTypeDto> topErrorTypes) {
        this.topErrorTypes = topErrorTypes;
    }

    public Long getAvgRecoveryTimeMs() {
        return avgRecoveryTimeMs;
    }

    public void setAvgRecoveryTimeMs(Long avgRecoveryTimeMs) {
        this.avgRecoveryTimeMs = avgRecoveryTimeMs;
    }

    public List<String> getRootCauseHints() {
        return rootCauseHints;
    }

    public void setRootCauseHints(List<String> rootCauseHints) {
        this.rootCauseHints = rootCauseHints;
    }
}
