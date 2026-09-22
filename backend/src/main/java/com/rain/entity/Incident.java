package com.rain.entity;

import jakarta.persistence.*;
import java.time.Instant;

@Entity
@Table(name = "incidents")
public class Incident {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "api_service_id", nullable = false)
    private ApiService apiService;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 32)
    private IncidentStatus status;

    @Column(name = "started_at", nullable = false)
    private Instant startedAt;

    @Column(name = "resolved_at")
    private Instant resolvedAt;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "first_health_check_id", nullable = false)
    private HealthCheck firstHealthCheck;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "latest_health_check_id", nullable = false)
    private HealthCheck latestHealthCheck;

    @Column(name = "failure_count", nullable = false)
    private Integer failureCount = 1;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public ApiService getApiService() {
        return apiService;
    }

    public void setApiService(ApiService apiService) {
        this.apiService = apiService;
    }

    public IncidentStatus getStatus() {
        return status;
    }

    public void setStatus(IncidentStatus status) {
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

    public HealthCheck getFirstHealthCheck() {
        return firstHealthCheck;
    }

    public void setFirstHealthCheck(HealthCheck firstHealthCheck) {
        this.firstHealthCheck = firstHealthCheck;
    }

    public HealthCheck getLatestHealthCheck() {
        return latestHealthCheck;
    }

    public void setLatestHealthCheck(HealthCheck latestHealthCheck) {
        this.latestHealthCheck = latestHealthCheck;
    }

    public Integer getFailureCount() {
        return failureCount;
    }

    public void setFailureCount(Integer failureCount) {
        this.failureCount = failureCount;
    }
}
