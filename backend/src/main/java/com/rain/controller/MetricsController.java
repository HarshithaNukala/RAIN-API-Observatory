package com.rain.controller;

import com.rain.dto.ApiMetricsResponse;
import com.rain.dto.DashboardSummaryResponse;
import com.rain.dto.LatencySeriesPoint;
import com.rain.dto.SuccessFailureSeriesPoint;
import com.rain.dto.TimeWindow;
import com.rain.monitoring.MetricsService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api")
@CrossOrigin(origins = "*")
public class MetricsController {

    private final MetricsService metricsService;

    public MetricsController(MetricsService metricsService) {
        this.metricsService = metricsService;
    }

    @GetMapping("/dashboard/summary")
    public ResponseEntity<DashboardSummaryResponse> getDashboardSummary(
            @RequestParam(defaultValue = "24h") String window) {
        TimeWindow timeWindow = TimeWindow.fromValue(window);
        return ResponseEntity.ok(metricsService.getDashboardSummary(timeWindow));
    }

    @GetMapping("/services/{id}/metrics")
    public ResponseEntity<ApiMetricsResponse> getApiMetrics(
            @PathVariable Long id,
            @RequestParam(defaultValue = "24h") String window) {
        TimeWindow timeWindow = TimeWindow.fromValue(window);
        return ResponseEntity.ok(metricsService.getApiMetrics(id, timeWindow));
    }

    @GetMapping("/services/{id}/metrics/latency")
    public ResponseEntity<List<LatencySeriesPoint>> getLatencySeries(
            @PathVariable Long id,
            @RequestParam(defaultValue = "24h") String window) {
        TimeWindow timeWindow = TimeWindow.fromValue(window);
        return ResponseEntity.ok(metricsService.getLatencySeries(id, timeWindow));
    }

    @GetMapping("/services/{id}/metrics/success-failure")
    public ResponseEntity<List<SuccessFailureSeriesPoint>> getSuccessFailureSeries(
            @PathVariable Long id,
            @RequestParam(defaultValue = "24h") String window) {
        TimeWindow timeWindow = TimeWindow.fromValue(window);
        return ResponseEntity.ok(metricsService.getSuccessFailureSeries(id, timeWindow));
    }
}
