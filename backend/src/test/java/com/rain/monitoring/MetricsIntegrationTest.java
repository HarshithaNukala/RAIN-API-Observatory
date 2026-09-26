package com.rain.monitoring;

import com.rain.dto.ApiMetricsResponse;
import com.rain.dto.DashboardSummaryResponse;
import com.rain.dto.TimeWindow;
import com.rain.entity.ApiService;
import com.rain.entity.ApiStatus;
import com.rain.entity.HealthCheck;
import com.rain.entity.HttpMethod;
import com.rain.repository.ApiServiceRepository;
import com.rain.repository.HealthCheckRepository;
import com.rain.repository.IncidentRepository;
import com.rain.entity.Incident;
import com.rain.entity.IncidentStatus;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.time.Instant;
import java.time.temporal.ChronoUnit;

import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest
public class MetricsIntegrationTest {

    @Autowired
    private MetricsService metricsService;

    @Autowired
    private ApiServiceRepository apiServiceRepository;

    @Autowired
    private HealthCheckRepository healthCheckRepository;

    @Autowired
    private IncidentRepository incidentRepository;

    @BeforeEach
    @AfterEach
    void cleanUp() {
        incidentRepository.deleteAll();
        healthCheckRepository.deleteAll();
        apiServiceRepository.deleteAll();
    }

    @Test
    void testGlobalDashboardAggregationMath() {
        // Create API A
        ApiService apiA = new ApiService();
        apiA.setName("API A");
        apiA.setUrl("http://a.com");
        apiA.setMethod(HttpMethod.GET);
        apiA.setExpectedStatusCode(200);
        apiA.setTimeoutMs(5000);
        apiA.setLatencyThresholdMs(5000);
        apiA.setCheckIntervalSeconds(30);
        apiA.setCurrentStatus(ApiStatus.HEALTHY);
        apiA.setEnabled(false);
        apiA = apiServiceRepository.save(apiA);

        // Create API B
        ApiService apiB = new ApiService();
        apiB.setName("API B");
        apiB.setUrl("http://b.com");
        apiB.setMethod(HttpMethod.GET);
        apiB.setExpectedStatusCode(200);
        apiB.setTimeoutMs(5000);
        apiB.setLatencyThresholdMs(5000);
        apiB.setCheckIntervalSeconds(30);
        apiB.setCurrentStatus(ApiStatus.HEALTHY);
        apiB.setEnabled(false);
        apiB = apiServiceRepository.save(apiB);

        Instant now = Instant.now();

        // 100 checks for API A (99 successful)
        for (int i = 0; i < 100; i++) {
            HealthCheck hc = new HealthCheck();
            hc.setApiService(apiA);
            hc.setCheckedAt(now.minusSeconds(i * 10));
            hc.setSuccess(i < 99);
            hc.setStatus(i < 99 ? ApiStatus.HEALTHY : ApiStatus.DOWN);
            hc.setLatencyMs(100);
            healthCheckRepository.save(hc);
        }

        // 10 checks for API B (5 successful)
        for (int i = 0; i < 10; i++) {
            HealthCheck hc = new HealthCheck();
            hc.setApiService(apiB);
            hc.setCheckedAt(now.minusSeconds(i * 10));
            hc.setSuccess(i < 5);
            hc.setStatus(i < 5 ? ApiStatus.HEALTHY : ApiStatus.DOWN);
            hc.setLatencyMs(200);
            healthCheckRepository.save(hc);
        }

        DashboardSummaryResponse summary = metricsService.getDashboardSummary(TimeWindow.W_24H);

        assertEquals(110, summary.getTotalChecks());
        assertEquals(104, summary.getSuccessfulChecks());
        assertEquals(6, summary.getFailedChecks());

        // Expected check-based uptime: 104 / 110 * 100 = 94.5454...
        double expectedUptime = (104.0 / 110.0) * 100.0;
        assertEquals(expectedUptime, summary.getOverallCheckBasedUptimePercentage(), 0.001);
        assertNotEquals((99.0 + 50.0) / 2.0, summary.getOverallCheckBasedUptimePercentage(), 0.001); // NOT average of percentages
        
        // Expected overall average latency: (100 * 100ms + 10 * 200ms) / 110 = 12000 / 110 = 109.09...
        double expectedAvgLatency = (100.0 * 100.0 + 10.0 * 200.0) / 110.0;
        assertEquals(expectedAvgLatency, summary.getOverallAverageResponseLatencyMs(), 0.001);
    }

    @Test
    void testNullLatencyPopulation() {
        ApiService api = new ApiService();
        api.setName("API Null Latency");
        api.setUrl("http://null.com");
        api.setMethod(HttpMethod.GET);
        api.setExpectedStatusCode(200);
        api.setTimeoutMs(5000);
        api.setLatencyThresholdMs(5000);
        api.setCheckIntervalSeconds(30);
        api.setCurrentStatus(ApiStatus.DOWN);
        api.setEnabled(false);
        api = apiServiceRepository.save(api);

        Instant now = Instant.now();

        // 1 successful check with latency 100ms
        HealthCheck hc1 = new HealthCheck();
        hc1.setApiService(api);
        hc1.setCheckedAt(now.minusSeconds(20));
        hc1.setSuccess(true);
        hc1.setStatus(ApiStatus.HEALTHY);
        hc1.setLatencyMs(100);
        healthCheckRepository.save(hc1);

        // 1 timeout check with NO latency (null)
        HealthCheck hc2 = new HealthCheck();
        hc2.setApiService(api);
        hc2.setCheckedAt(now.minusSeconds(10));
        hc2.setSuccess(false);
        hc2.setStatus(ApiStatus.DOWN);
        hc2.setLatencyMs(null);
        hc2.setErrorType("TIMEOUT");
        healthCheckRepository.save(hc2);

        ApiMetricsResponse metrics = metricsService.getApiMetrics(api.getId(), TimeWindow.W_1H);

        assertEquals(2, metrics.getTotalChecks());
        assertEquals(50.0, metrics.getUptimePercentage());
        // The average should be exactly 100.0 because the null latency is EXCLUDED from the population.
        assertEquals(100.0, metrics.getAverageResponseLatencyMs(), 0.001);
        assertEquals(100.0, metrics.getP95ResponseLatencyMs(), 0.001);
    }

    @Test
    void testEmptyDataHandling() {
        ApiService api = new ApiService();
        api.setName("API Empty");
        api.setUrl("http://empty.com");
        api.setMethod(HttpMethod.GET);
        api.setExpectedStatusCode(200);
        api.setTimeoutMs(5000);
        api.setLatencyThresholdMs(5000);
        api.setCheckIntervalSeconds(30);
        api.setCurrentStatus(ApiStatus.UNKNOWN);
        api.setEnabled(false);
        api = apiServiceRepository.save(api);

        ApiMetricsResponse metrics = metricsService.getApiMetrics(api.getId(), TimeWindow.W_1H);

        assertEquals(0, metrics.getTotalChecks());
        assertNull(metrics.getUptimePercentage());
        assertNull(metrics.getAverageResponseLatencyMs());
        assertNull(metrics.getP95ResponseLatencyMs());
        assertEquals(ApiStatus.UNKNOWN, metrics.getCurrentStatus());
    }

    @Test
    void testActiveIncidentsCountIncludesPausedApiWithOpenIncident() {
        // Create API
        ApiService api = new ApiService();
        api.setName("API Incidents");
        api.setUrl("http://incidents.com");
        api.setMethod(HttpMethod.GET);
        api.setExpectedStatusCode(200);
        api.setTimeoutMs(5000);
        api.setLatencyThresholdMs(5000);
        api.setCheckIntervalSeconds(30);
        api.setCurrentStatus(ApiStatus.DOWN); // Start as DOWN
        api.setEnabled(true);
        api = apiServiceRepository.save(api);

        // Create a dummy HealthCheck for the incident
        HealthCheck hc = new HealthCheck();
        hc.setApiService(api);
        hc.setCheckedAt(Instant.now().minusSeconds(100));
        hc.setSuccess(false);
        hc.setStatus(ApiStatus.DOWN);
        hc = healthCheckRepository.save(hc);

        // Create an OPEN incident
        Incident incident = new Incident();
        incident.setApiService(api);
        incident.setStatus(IncidentStatus.OPEN);
        incident.setStartedAt(Instant.now().minusSeconds(100));
        incident.setFailureCount(5);
        incident.setFirstHealthCheck(hc);
        incident.setLatestHealthCheck(hc);
        incidentRepository.save(incident);

        // Check activeIncidents initially
        DashboardSummaryResponse summary = metricsService.getDashboardSummary(TimeWindow.W_1H);
        assertEquals(1, summary.getActiveIncidents());
        assertEquals(1, summary.getDownApis());
        assertEquals(0, summary.getPausedApis());

        // Now PAUSE the API
        api.setCurrentStatus(ApiStatus.PAUSED);
        api.setEnabled(false);
        apiServiceRepository.save(api);

        // Check activeIncidents after pause
        summary = metricsService.getDashboardSummary(TimeWindow.W_1H);
        assertEquals(1, summary.getActiveIncidents()); // The incident is STILL open!
        assertEquals(0, summary.getDownApis());        // But downApis is 0
        assertEquals(1, summary.getPausedApis());      // And pausedApis is 1
    }
}
