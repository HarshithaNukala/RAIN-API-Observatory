package com.rain.intelligence.dto;

public class ErrorTypeDto {
    private String errorType;
    private Long count;
    private Double percentage;

    public ErrorTypeDto() {
    }

    public ErrorTypeDto(String errorType, Long count, Double percentage) {
        this.errorType = errorType;
        this.count = count;
        this.percentage = percentage;
    }

    public String getErrorType() {
        return errorType;
    }

    public void setErrorType(String errorType) {
        this.errorType = errorType;
    }

    public Long getCount() {
        return count;
    }

    public void setCount(Long count) {
        this.count = count;
    }

    public Double getPercentage() {
        return percentage;
    }

    public void setPercentage(Double percentage) {
        this.percentage = percentage;
    }
}
