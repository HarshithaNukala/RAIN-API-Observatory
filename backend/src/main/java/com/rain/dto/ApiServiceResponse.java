package com.rain.dto;

import com.rain.entity.ApiStatus;
import com.rain.entity.HttpMethod;

import java.time.Instant;
import java.util.List;

public class ApiServiceResponse {

    private Long id;
    private String name;
    private String url;
    private HttpMethod method;
    private String description;
    private Integer expectedStatusCode;
    private Integer timeoutMs;
    private Integer latencyThresholdMs;
    private Integer checkIntervalSeconds;
    private Boolean enabled;
    private ApiStatus currentStatus;
    private Instant createdAt;
    private Instant updatedAt;
    private List<ApiHeaderResponse> headers;

    public ApiServiceResponse() {
    }

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

    public List<ApiHeaderResponse> getHeaders() { return headers; }
    public void setHeaders(List<ApiHeaderResponse> headers) { this.headers = headers; }
}
