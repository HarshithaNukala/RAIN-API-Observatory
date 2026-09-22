package com.rain.dto;

import java.time.Instant;

public class IncidentDto {
    private Long id;
    private Long apiServiceId;
    private String status;
    private Instant startedAt;
    private Instant resolvedAt;
    private Integer failureCount;

    // Projected from latest_health_check_id
    private String latestErrorType;
    private String latestErrorMessage;
    private Integer latestHttpStatus;
    private Integer latestLatencyMs;

    public IncidentDto() {
    }

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public Long getApiServiceId() {
        return apiServiceId;
    }

    public void setApiServiceId(Long apiServiceId) {
        this.apiServiceId = apiServiceId;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public Instant getStartedAt() {
        return startedAt;
    }

    public void setStartedAt(Instant startedAt) {
        this.startedAt = startedAt;
    }

    public Instant getResolvedAt() {
        return resolvedAt;
    }

    public void setResolvedAt(Instant resolvedAt) {
        this.resolvedAt = resolvedAt;
    }

    public Integer getFailureCount() {
        return failureCount;
    }

    public void setFailureCount(Integer failureCount) {
        this.failureCount = failureCount;
    }

    public String getLatestErrorType() {
        return latestErrorType;
    }

    public void setLatestErrorType(String latestErrorType) {
        this.latestErrorType = latestErrorType;
    }

    public String getLatestErrorMessage() {
        return latestErrorMessage;
    }

    public void setLatestErrorMessage(String latestErrorMessage) {
        this.latestErrorMessage = latestErrorMessage;
    }

    public Integer getLatestHttpStatus() {
        return latestHttpStatus;
    }

    public void setLatestHttpStatus(Integer latestHttpStatus) {
        this.latestHttpStatus = latestHttpStatus;
    }

    public Integer getLatestLatencyMs() {
        return latestLatencyMs;
    }

    public void setLatestLatencyMs(Integer latestLatencyMs) {
        this.latestLatencyMs = latestLatencyMs;
    }
}
