package com.rain.dto;

import java.time.Duration;

public enum TimeWindow {
    W_1H("1h", Duration.ofHours(1)),
    W_6H("6h", Duration.ofHours(6)),
    W_24H("24h", Duration.ofHours(24)),
    W_7D("7d", Duration.ofDays(7)),
    W_30D("30d", Duration.ofDays(30));

    private final String value;
    private final Duration duration;

    TimeWindow(String value, Duration duration) {
        this.value = value;
        this.duration = duration;
    }

    public String getValue() {
        return value;
    }

    public Duration getDuration() {
        return duration;
    }

    public static TimeWindow fromValue(String value) {
        for (TimeWindow window : values()) {
            if (window.value.equals(value)) {
                return window;
            }
        }
        throw new IllegalArgumentException("Invalid time window: " + value);
    }
}
