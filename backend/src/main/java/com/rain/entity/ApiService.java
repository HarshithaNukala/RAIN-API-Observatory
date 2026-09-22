package com.rain.entity;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

@Entity
@Table(name = "api_services")
public class ApiService {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String name;

    @Column(nullable = false, length = 2048)
    private String url;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 10)
    private HttpMethod method;

    @Column(columnDefinition = "TEXT")
    private String description;

    @Column(name = "expected_status_code", nullable = false)
    private Integer expectedStatusCode;

    @Column(name = "timeout_ms", nullable = false)
    private Integer timeoutMs;

    @Column(name = "latency_threshold_ms", nullable = false)
    private Integer latencyThresholdMs;

    @Column(name = "check_interval_seconds", nullable = false)
    private Integer checkIntervalSeconds;

    @Column(nullable = false)
    private Boolean enabled = true;

    @Enumerated(EnumType.STRING)
    @Column(name = "current_status", nullable = false, length = 50)
    private ApiStatus currentStatus = ApiStatus.UNKNOWN;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @OneToMany(mappedBy = "apiService", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<ApiHeader> headers = new ArrayList<>();

    public ApiService() {
    }

    @PrePersist
    public void prePersist() {
        if (createdAt == null) {
            createdAt = Instant.now();
        }
        updatedAt = createdAt;
    }

    @PreUpdate
    public void preUpdate() {
        updatedAt = Instant.now();
    }

    public void addHeader(ApiHeader header) {
        headers.add(header);
        header.setApiService(this);
    }

    public void removeHeader(ApiHeader header) {
        headers.remove(header);
        header.setApiService(null);
    }

    // Getters and Setters

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getUrl() { return url; }
    public void setUrl(String url) { this.url = url; }

    public HttpMethod getMethod() { return method; }
    public void setMethod(HttpMethod method) { this.method = method; }

    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }

    public Integer getExpectedStatusCode() { return expectedStatusCode; }
    public void setExpectedStatusCode(Integer expectedStatusCode) { this.expectedStatusCode = expectedStatusCode; }

    public Integer getTimeoutMs() { return timeoutMs; }
    public void setTimeoutMs(Integer timeoutMs) { this.timeoutMs = timeoutMs; }

    public Integer getLatencyThresholdMs() { return latencyThresholdMs; }
    public void setLatencyThresholdMs(Integer latencyThresholdMs) { this.latencyThresholdMs = latencyThresholdMs; }

    public Integer getCheckIntervalSeconds() { return checkIntervalSeconds; }
    public void setCheckIntervalSeconds(Integer checkIntervalSeconds) { this.checkIntervalSeconds = checkIntervalSeconds; }

    public Boolean getEnabled() { return enabled; }
    public void setEnabled(Boolean enabled) { this.enabled = enabled; }

    public ApiStatus getCurrentStatus() { return currentStatus; }
    public void setCurrentStatus(ApiStatus currentStatus) { this.currentStatus = currentStatus; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }

    public List<ApiHeader> getHeaders() { return headers; }
    public void setHeaders(List<ApiHeader> headers) { 
        this.headers.clear();
        if (headers != null) {
            for (ApiHeader header : headers) {
                addHeader(header);
            }
        }
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof ApiService)) return false;
        ApiService that = (ApiService) o;
        return Objects.equals(id, that.id);
    }

    @Override
    public int hashCode() {
        return Objects.hash(id);
    }
}
