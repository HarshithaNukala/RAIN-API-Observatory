package com.rain.monitoring;

import com.rain.dto.*;
import com.rain.entity.ApiService;
import com.rain.entity.ApiStatus;
import com.rain.repository.ApiServiceRepository;
import com.rain.repository.MetricsRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Service
public class MetricsService {

    private final MetricsRepository metricsRepository;
    private final ApiServiceRepository apiServiceRepository;

    public MetricsService(MetricsRepository metricsRepository, ApiServiceRepository apiServiceRepository) {
        this.metricsRepository = metricsRepository;
        this.apiServiceRepository = apiServiceRepository;
    }

    @Transactional(readOnly = true)
    public DashboardSummaryResponse getDashboardSummary(TimeWindow window) {
        Instant cutoff = Instant.now().minus(window.getDuration());
        
        DashboardSummaryResponse summary = metricsRepository.getDashboardSummary(cutoff);
        summary.setWindow(window.getValue());

        // Get Registry Metrics
        List<ApiService> allApis = apiServiceRepository.findAll();
        long totalApis = allApis.size();
        long enabledApis = allApis.stream().filter(ApiService::getEnabled).count();
        long pausedApis = allApis.stream().filter(api -> !api.getEnabled() || api.getCurrentStatus() == ApiStatus.PAUSED).count();
        long healthyApis = allApis.stream().filter(api -> api.getCurrentStatus() == ApiStatus.HEALTHY).count();
        long degradedApis = allApis.stream().filter(api -> api.getCurrentStatus() == ApiStatus.DEGRADED).count();
        long downApis = allApis.stream().filter(api -> api.getCurrentStatus() == ApiStatus.DOWN).count();
        long unknownApis = allApis.stream().filter(api -> api.getCurrentStatus() == ApiStatus.UNKNOWN).count();

        summary.setTotalApis(totalApis);
        summary.setEnabledApis(enabledApis);
        summary.setPausedApis(pausedApis);
        summary.setHealthyApis(healthyApis);
        summary.setDegradedApis(degradedApis);
        summary.setDownApis(downApis);
        summary.setUnknownApis(unknownApis);

        return summary;
    }

    @Transactional(readOnly = true)
    public ApiMetricsResponse getApiMetrics(Long id, TimeWindow window) {
        Optional<ApiService> apiOpt = apiServiceRepository.findById(id);
        if (apiOpt.isEmpty()) {
            throw new IllegalArgumentException("API not found: " + id);
        }
        
        Instant cutoff = Instant.now().minus(window.getDuration());
        ApiMetricsResponse response = metricsRepository.getApiMetrics(id, cutoff);
        response.setWindow(window.getValue());
        response.setCurrentStatus(apiOpt.get().getCurrentStatus());
        
        return response;
    }

    @Transactional(readOnly = true)
    public List<LatencySeriesPoint> getLatencySeries(Long id, TimeWindow window) {
        Instant cutoff = Instant.now().minus(window.getDuration());
        String interval = getPostgresInterval(window);
        return metricsRepository.getLatencySeries(id, cutoff, interval);
    }

    @Transactional(readOnly = true)
    public List<SuccessFailureSeriesPoint> getSuccessFailureSeries(Long id, TimeWindow window) {
        Instant cutoff = Instant.now().minus(window.getDuration());
        String interval = getPostgresInterval(window);
        return metricsRepository.getSuccessFailureSeries(id, cutoff, interval);
    }

    private String getPostgresInterval(TimeWindow window) {
        return switch (window) {
            case W_1H, W_6H -> "minute"; // 1-minute buckets
            case W_24H, W_7D -> "hour"; // 1-hour buckets
            case W_30D -> "day"; // 1-day buckets
        };
    }
}
