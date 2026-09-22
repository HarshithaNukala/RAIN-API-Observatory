package com.rain.dto;

import jakarta.validation.constraints.NotBlank;

public class ApiHeaderRequest {

    @NotBlank(message = "Header name is required")
    private String headerName;

    @NotBlank(message = "Header value is required")
    private String headerValue;

    public ApiHeaderRequest() {
    }

    public ApiHeaderRequest(String headerName, String headerValue) {
        this.headerName = headerName;
        this.headerValue = headerValue;
    }

    public String getHeaderName() {
        return headerName;
    }

    public void setHeaderName(String headerName) {
        this.headerName = headerName;
    }

    public String getHeaderValue() {
        return headerValue;
    }

    public void setHeaderValue(String headerValue) {
        this.headerValue = headerValue;
    }
}
