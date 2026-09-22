package com.rain.monitoring;

import com.rain.entity.ApiService;
import com.rain.entity.ApiStatus;
import com.rain.entity.HealthCheck;
import com.rain.entity.Incident;
import com.rain.entity.IncidentStatus;
import com.rain.repository.ApiServiceRepository;
import com.rain.repository.HealthCheckRepository;
import com.rain.repository.IncidentRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

@SpringBootTest(properties = {
    "monitoring.scheduler.enabled=false" // Prevent scheduler from running automatically during tests
})
public class IncidentEngineIntegrationTest {

    @Autowired
    private MonitoringEngineService monitoringEngineService;

    @Autowired
    private ApiServiceRepository apiServiceRepository;

    @Autowired
    private IncidentRepository incidentRepository;

    @Autowired
    private HealthCheckRepository healthCheckRepository;

    @MockBean
    private HealthCheckExecutor healthCheckExecutor;

    private ApiService apiService;
    private ApiService pausedApi;

    @BeforeEach
    void setUp() {
        incidentRepository.deleteAll();
        healthCheckRepository.deleteAll();
        apiServiceRepository.deleteAll();

        ApiService api = new ApiService();
        api.setName("Test API");
        api.setUrl("https://test.com");
        api.setMethod(com.rain.entity.HttpMethod.GET);
        api.setExpectedStatusCode(200);
        api.setTimeoutMs(5000);
        api.setLatencyThresholdMs(500);
        api.setCheckIntervalSeconds(60);
        api.setEnabled(true);
        api.setCurrentStatus(ApiStatus.UNKNOWN);
        this.apiService = apiServiceRepository.save(api);

        ApiService paused = new ApiService();
        paused.setName("Paused API");
        paused.setUrl("https://paused.com");
        paused.setMethod(com.rain.entity.HttpMethod.GET);
        paused.setExpectedStatusCode(200);
        paused.setTimeoutMs(5000);
        paused.setLatencyThresholdMs(500);
        paused.setCheckIntervalSeconds(60);
        paused.setEnabled(false);
        paused.setCurrentStatus(ApiStatus.UNKNOWN);
        this.pausedApi = apiServiceRepository.save(paused);
    }

    private void mockExecutor(boolean success, int status, int latency, String error) {
        HealthCheckResult result = new HealthCheckResult(
                success,
                status,
                latency,
                error,
                error != null ? "Mock error" : null
        );
        when(healthCheckExecutor.execute(any(ApiService.class))).thenReturn(result);
    }

    @Test
    void testIncidentLifecycle() {
        // 1. First DOWN
        mockExecutor(false, 500, 100, "SERVER_ERROR");
        HealthCheck check1 = monitoringEngineService.executeAndSaveCheck(apiService.getId());
        
        List<Incident> incidents = incidentRepository.findAll();
        assertThat(incidents).hasSize(1);
        Incident incident = incidents.get(0);
        assertThat(incident.getStatus()).isEqualTo(IncidentStatus.OPEN);
        assertThat(incident.getFailureCount()).isEqualTo(1);
        assertThat(incident.getStartedAt()).isNotNull(); // Real time observation used
        assertThat(incident.getResolvedAt()).isNull();

        // 2. Repeated DOWN
        mockExecutor(false, 502, 120, "BAD_GATEWAY");
        HealthCheck check2 = monitoringEngineService.executeAndSaveCheck(apiService.getId());
        
        incidents = incidentRepository.findAll();
        assertThat(incidents).hasSize(1); // Still exactly one incident
        incident = incidents.get(0);
        assertThat(incident.getStatus()).isEqualTo(IncidentStatus.OPEN);
        assertThat(incident.getFailureCount()).isEqualTo(2); // Count increments
        assertThat(incident.getLatestHealthCheck().getId()).isEqualTo(check2.getId()); // Latest changes

        // 3. Recovery (HEALTHY)
        mockExecutor(true, 200, 100, null);
        HealthCheck check3 = monitoringEngineService.executeAndSaveCheck(apiService.getId());
        
        incident = incidentRepository.findById(incident.getId()).get();
        assertThat(incident.getStatus()).isEqualTo(IncidentStatus.RESOLVED);
        assertThat(incident.getResolvedAt()).isNotNull(); // Check3 time

        // 4. Later DOWN creates NEW incident
        mockExecutor(false, 503, 100, "SERVICE_UNAVAILABLE");
        monitoringEngineService.executeAndSaveCheck(apiService.getId());
        
        incidents = incidentRepository.findAll();
        assertThat(incidents).hasSize(2);
        long openCount = incidents.stream().filter(i -> i.getStatus() == IncidentStatus.OPEN).count();
        assertThat(openCount).isEqualTo(1); // The new one is OPEN
        long resolvedCount = incidents.stream().filter(i -> i.getStatus() == IncidentStatus.RESOLVED).count();
        assertThat(resolvedCount).isEqualTo(1); // The old one remains RESOLVED
    }

    @Test
    void testDegradedDoesNotCreateIncident() {
        // DEGRADED: success=true, correct status, but slow latency
        mockExecutor(true, 200, 1000, null); 
        monitoringEngineService.executeAndSaveCheck(apiService.getId());

        List<Incident> incidents = incidentRepository.findAll();
        assertThat(incidents).isEmpty(); // No incident created

        ApiService updated = apiServiceRepository.findById(apiService.getId()).get();
        assertThat(updated.getCurrentStatus()).isEqualTo(ApiStatus.DEGRADED);
    }

    @Test
    void testDegradedResolvesOpenIncident() {
        // 1. OPEN incident
        mockExecutor(false, 500, 100, "ERROR");
        monitoringEngineService.executeAndSaveCheck(apiService.getId());
        assertThat(incidentRepository.findAll()).hasSize(1);
        assertThat(incidentRepository.findAll().get(0).getStatus()).isEqualTo(IncidentStatus.OPEN);

        // 2. DEGRADED (success=true, slow latency)
        mockExecutor(true, 200, 1000, null);
        monitoringEngineService.executeAndSaveCheck(apiService.getId());

        Incident incident = incidentRepository.findAll().get(0);
        assertThat(incident.getStatus()).isEqualTo(IncidentStatus.RESOLVED);
    }

    @Test
    void testPausedApiProducesNoNewIncidents() {
        mockExecutor(false, 500, 100, "ERROR");
        // Because the API is paused, execution is skipped (returns null)
        HealthCheck check = monitoringEngineService.executeAndSaveCheck(pausedApi.getId());
        assertThat(check).isNull();
        
        List<Incident> incidents = incidentRepository.findAll();
        assertThat(incidents).isEmpty();
    }

    @Test
    void testPausedApiLeavesOpenIncidentOpen() {
        // First it's enabled, fail it to create incident
        mockExecutor(false, 500, 100, "ERROR");
        monitoringEngineService.executeAndSaveCheck(apiService.getId());

        // Then pause it
        ApiService api = apiServiceRepository.findById(apiService.getId()).get();
        api.setEnabled(false);
        apiServiceRepository.save(api);

        // Run check (will skip)
        mockExecutor(true, 200, 100, null); // Even if it recovered, it skips
        monitoringEngineService.executeAndSaveCheck(apiService.getId());

        Incident incident = incidentRepository.findAll().get(0);
        assertThat(incident.getStatus()).isEqualTo(IncidentStatus.OPEN); // Stays OPEN!
    }

    @Test
    void testMultipleApisAreIndependent() {
        ApiService api2 = new ApiService();
        api2.setName("API 2");
        api2.setUrl("http://api2");
        api2.setMethod(com.rain.entity.HttpMethod.GET);
        api2.setExpectedStatusCode(200);
        api2.setTimeoutMs(5000);
        api2.setLatencyThresholdMs(500);
        api2.setCheckIntervalSeconds(60);
        api2.setEnabled(true);
        api2 = apiServiceRepository.save(api2);

        // Fail API 1
        mockExecutor(false, 500, 100, "ERR");
        monitoringEngineService.executeAndSaveCheck(apiService.getId());

        // Fail API 2
        monitoringEngineService.executeAndSaveCheck(api2.getId());

        List<Incident> incidents = incidentRepository.findAll();
        assertThat(incidents).hasSize(2);
        assertThat(incidents.get(0).getApiService().getId()).isNotEqualTo(incidents.get(1).getApiService().getId());
    }
}
