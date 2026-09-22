package com.rain.dto;

import java.time.Instant;

public class SuccessFailureSeriesPoint {
    private Instant timestamp;
    private Long successful;
    private Long failed;

    public SuccessFailureSeriesPoint() {}

    public Instant getTimestamp() { return timestamp; }
    public void setTimestamp(Instant timestamp) { this.timestamp = timestamp; }
    public Long getSuccessful() { return successful; }
    public void setSuccessful(Long successful) { this.successful = successful; }
    public Long getFailed() { return failed; }
    public void setFailed(Long failed) { this.failed = failed; }
}
