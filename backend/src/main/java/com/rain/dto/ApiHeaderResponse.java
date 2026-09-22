package com.rain.dto;

public class ApiHeaderResponse {

    private String headerName;
    private boolean configured;

    public ApiHeaderResponse() {
    }

    public ApiHeaderResponse(String headerName, boolean configured) {
        this.headerName = headerName;
        this.configured = configured;
    }

    public String getHeaderName() {
        return headerName;
    }

    public void setHeaderName(String headerName) {
        this.headerName = headerName;
    }

    public boolean isConfigured() {
        return configured;
    }

    public void setConfigured(boolean configured) {
        this.configured = configured;
    }
}
