package com.rain.intelligence;

import com.rain.entity.ApiService;
import com.rain.entity.ApiStatus;
import com.rain.entity.HealthCheck;
import com.rain.entity.Incident;
import com.rain.entity.IncidentStatus;
import com.rain.intelligence.dto.ServiceIntelligenceResponse;
import com.rain.repository.ApiServiceRepository;
import com.rain.repository.HealthCheckRepository;
import com.rain.repository.IncidentRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.temporal.ChronoUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

@SpringBootTest
@ActiveProfiles("test")
@Transactional
public class IntelligenceIntegrationTest {

    @Autowired
    private IntelligenceService intelligenceService;

    @Autowired
    private ApiServiceRepository apiServiceRepository;

    @Autowired
    private HealthCheckRepository healthCheckRepository;

    @Autowired
    private IncidentRepository incidentRepository;

    private ApiService apiService;
    private Instant now;

    @BeforeEach
    void setUp() {
        incidentRepository.deleteAll();
        healthCheckRepository.deleteAll();
        apiServiceRepository.deleteAll();

        apiService = new ApiService();
        apiService.setName("Test API");
        apiService.setUrl("http://test.api");
        apiService.setMethod(com.rain.entity.HttpMethod.GET);
        apiService.setExpectedStatusCode(200);
        apiService.setTimeoutMs(5000);
        apiService.setLatencyThresholdMs(500);
        apiService.setCheckIntervalSeconds(60);
        apiService.setEnabled(true);
        apiService.setCurrentStatus(ApiStatus.HEALTHY);
        apiService = apiServiceRepository.saveAndFlush(apiService);

        now = Instant.now();
    }

    private HealthCheck createCheck(Instant checkedAt, boolean success, ApiStatus status, Integer latencyMs, String errorType) {
        HealthCheck check = new HealthCheck();
        check.setApiService(apiService);
        check.setCheckedAt(checkedAt);
        check.setSuccess(success);
        check.setStatus(status);
        check.setLatencyMs(latencyMs);
        check.setErrorType(errorType);
        return healthCheckRepository.save(check);
    }

    @Test
    void testANoChecks() {
        ServiceIntelligenceResponse response = intelligenceService.getIntelligence(apiService.getId(), "7d");
        assertThat(response.getReliabilityScore()).isNull();
        assertThat(response.getScoreTrend()).isNull();
        assertThat(response.getTotalAnomalies()).isEqualTo(0);
        assertThat(response.getAvgRecoveryTimeMs()).isNull();
    }

    @Test
    void testBOneCheck() {
        createCheck(now.minusSeconds(10), true, ApiStatus.HEALTHY, 100, null);
        ServiceIntelligenceResponse response = intelligenceService.getIntelligence(apiService.getId(), "7d");
        assertThat(response.getReliabilityScore()).isEqualTo(100.0);
        assertThat(response.getTotalAnomalies()).isEqualTo(0);
    }

    @Test
    void testCStableLatency() {
        for (int i = 0; i < 20; i++) {
            createCheck(now.minusSeconds(200 - i * 10), true, ApiStatus.HEALTHY, 100, null);
        }
        ServiceIntelligenceResponse response = intelligenceService.getIntelligence(apiService.getId(), "7d");
        assertThat(response.getReliabilityScore()).isEqualTo(100.0);
        assertThat(response.getTotalAnomalies()).isEqualTo(0);
    }

    @Test
    void testDZeroStandardDeviationSpike() {
        // 10 checks at 100ms
        for (int i = 0; i < 15; i++) {
            createCheck(now.minusSeconds(200 - i * 10), true, ApiStatus.HEALTHY, 100, null);
        }
        // Spike at 200ms (> 100 * 1.5)
        createCheck(now.minusSeconds(10), true, ApiStatus.HEALTHY, 200, null);
        
        ServiceIntelligenceResponse response = intelligenceService.getIntelligence(apiService.getId(), "7d");
        assertThat(response.getTotalAnomalies()).isEqualTo(1);
    }

    @Test
    void testEInsufficientAnomalyHistory() {
        for (int i = 0; i < 5; i++) {
            createCheck(now.minusSeconds(200 - i * 10), true, ApiStatus.HEALTHY, 100, null);
        }
        createCheck(now.minusSeconds(10), true, ApiStatus.HEALTHY, 500, null);
        ServiceIntelligenceResponse response = intelligenceService.getIntelligence(apiService.getId(), "7d");
        assertThat(response.getTotalAnomalies()).isEqualTo(0); // Needs 10
    }

    @Test
    void testFSingleLatencySpike() {
        for (int i = 0; i < 50; i++) {
            createCheck(now.minusSeconds(600 - i * 10), true, ApiStatus.HEALTHY, 100, null);
        }
        createCheck(now.minusSeconds(10), true, ApiStatus.HEALTHY, 1000, null);
        ServiceIntelligenceResponse response = intelligenceService.getIntelligence(apiService.getId(), "7d");
        assertThat(response.getTotalAnomalies()).isEqualTo(1);
    }

    @Test
    void testHNullLatency() {
        for (int i = 0; i < 15; i++) {
            createCheck(now.minusSeconds(200 - i * 10), true, ApiStatus.HEALTHY, 100, null);
        }
        createCheck(now.minusSeconds(10), false, ApiStatus.DOWN, null, "TIMEOUT");
        ServiceIntelligenceResponse response = intelligenceService.getIntelligence(apiService.getId(), "7d");
        // Null latency doesn't trigger anomaly logic exception, just skipped.
        assertThat(response.getTotalAnomalies()).isEqualTo(0);
        assertThat(response.getTopErrorTypes().get(0).getErrorType()).isEqualTo("TIMEOUT");
    }

    @Test
    void testIRepeatedTimeoutFailures() {
        for (int i = 0; i < 10; i++) {
            createCheck(now.minusSeconds(200 - i * 10), false, ApiStatus.DOWN, null, "TIMEOUT");
        }
        ServiceIntelligenceResponse response = intelligenceService.getIntelligence(apiService.getId(), "7d");
        assertThat(response.getRootCauseHints().get(0)).contains("TIMEOUT failures (100.0% of failures)");
    }

    @Test
    void testJMixedFailureTypes() {
        for (int i = 0; i < 5; i++) {
            createCheck(now.minusSeconds(200 - i * 10), false, ApiStatus.DOWN, null, "TIMEOUT");
            createCheck(now.minusSeconds(200 - i * 10 + 5), false, ApiStatus.DOWN, null, "500_ERROR");
        }
        ServiceIntelligenceResponse response = intelligenceService.getIntelligence(apiService.getId(), "7d");
        // 50% each, threshold is 80%, so no hints
        assertThat(response.getRootCauseHints()).isEmpty();
    }
    
    @Test
    void testKOpenIncident() {
        Incident inc = new Incident();
        inc.setApiService(apiService);
        inc.setStatus(IncidentStatus.OPEN);
        inc.setStartedAt(now.minusSeconds(3600));
        HealthCheck hc = createCheck(now.minusSeconds(3600), false, ApiStatus.DOWN, null, "TIMEOUT");
        inc.setFirstHealthCheck(hc);
        inc.setLatestHealthCheck(hc);
        inc.setFailureCount(1);
        incidentRepository.save(inc);
        
        ServiceIntelligenceResponse response = intelligenceService.getIntelligence(apiService.getId(), "7d");
        assertThat(response.getAvgRecoveryTimeMs()).isNull(); // Ignore OPEN
    }
    
    @Test
    void testLResolvedIncident() {
        Incident inc = new Incident();
        inc.setApiService(apiService);
        inc.setStatus(IncidentStatus.RESOLVED);
        inc.setStartedAt(now.minusSeconds(3600));
        inc.setResolvedAt(now.minusSeconds(1800)); // 30 mins
        HealthCheck hc = createCheck(now.minusSeconds(3600), false, ApiStatus.DOWN, null, "TIMEOUT");
        inc.setFirstHealthCheck(hc);
        inc.setLatestHealthCheck(hc);
        inc.setFailureCount(1);
        incidentRepository.save(inc);
        
        ServiceIntelligenceResponse response = intelligenceService.getIntelligence(apiService.getId(), "7d");
        assertThat(response.getAvgRecoveryTimeMs()).isEqualTo(1800000L); // 30 mins in ms
    }

    @Test
    void testODegradedApi() {
        // threshold is 500ms
        createCheck(now.minusSeconds(10), true, ApiStatus.DEGRADED, 1000, null);
        ServiceIntelligenceResponse response = intelligenceService.getIntelligence(apiService.getId(), "7d");
        // Availability = 1.0, Latency Compliance = 0.0 -> score = 100 * (0.7*1 + 0.3*0) = 70.0
        assertThat(response.getReliabilityScore()).isCloseTo(70.0, within(0.1));
    }

    @Test
    void testPDownApi() {
        createCheck(now.minusSeconds(10), false, ApiStatus.DOWN, null, "TIMEOUT");
        ServiceIntelligenceResponse response = intelligenceService.getIntelligence(apiService.getId(), "7d");
        // Availability = 0.0, Latency Compliance = 1.0 (no valid latency) -> score = 100 * (0.7*0 + 0.3*1) = 30.0
        assertThat(response.getReliabilityScore()).isCloseTo(30.0, within(0.1));
    }
}
