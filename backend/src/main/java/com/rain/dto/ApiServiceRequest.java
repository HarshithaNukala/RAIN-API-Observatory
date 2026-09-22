package com.rain.dto;

import com.rain.entity.HttpMethod;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.util.List;

public class ApiServiceRequest {

    @NotBlank(message = "Name is required")
    private String name;

    @NotBlank(message = "URL is required")
    @Pattern(regexp = "^https?://.*", message = "URL must start with http:// or https://")
    private String url;

    @NotNull(message = "HTTP Method is required")
    private HttpMethod method;

    private String description;

    @NotNull(message = "Expected status code is required")
    @Min(value = 100, message = "Expected status code must be at least 100")
    @Max(value = 599, message = "Expected status code must be at most 599")
    private Integer expectedStatusCode;

    @NotNull(message = "Timeout is required")
    @Min(value = 1, message = "Timeout must be greater than 0")
    private Integer timeoutMs;

    @NotNull(message = "Latency threshold is required")
    @Min(value = 0, message = "Latency threshold must be non-negative")
    private Integer latencyThresholdMs;

    @NotNull(message = "Check interval is required")
    @Min(value = 1, message = "Check interval must be greater than 0")
    private Integer checkIntervalSeconds;

    @Valid
    private List<ApiHeaderRequest> headers;

    public ApiServiceRequest() {
    }

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

    public List<ApiHeaderRequest> getHeaders() { return headers; }
    public void setHeaders(List<ApiHeaderRequest> headers) { this.headers = headers; }
}
