package com.rain;

import com.rain.dto.ApiServiceRequest;
import com.rain.dto.ApiServiceResponse;
import com.rain.entity.ApiStatus;
import com.rain.entity.HttpMethod;
import com.rain.service.ApiRegistryService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.transaction.annotation.Transactional;

import com.rain.entity.Incident;
import com.rain.entity.IncidentStatus;
import com.rain.entity.HealthCheck;
import com.rain.repository.ApiServiceRepository;
import com.rain.repository.HealthCheckRepository;
import com.rain.repository.IncidentRepository;

import java.time.Instant;

import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest
@Transactional
public class ApiRegistryIntegrationTest {

    @Autowired
    private ApiRegistryService apiRegistryService;

    @Autowired
    private ApiServiceRepository apiServiceRepository;

    @Autowired
    private HealthCheckRepository healthCheckRepository;

    @Autowired
    private IncidentRepository incidentRepository;

    @Test
    public void testCreateAndRetrieveService() {
        ApiServiceRequest request = new ApiServiceRequest();
        request.setName("Integration Test API");
        request.setUrl("https://jsonplaceholder.typicode.com/posts");
        request.setMethod(HttpMethod.GET);
        request.setExpectedStatusCode(200);
        request.setTimeoutMs(2000);
        request.setLatencyThresholdMs(500);
        request.setCheckIntervalSeconds(30);

        // Create
        ApiServiceResponse created = apiRegistryService.createService(request);
        assertNotNull(created.getId());
        assertEquals("Integration Test API", created.getName());
        assertEquals(ApiStatus.UNKNOWN, created.getCurrentStatus());
        assertTrue(created.getEnabled());

        // Read
        ApiServiceResponse retrieved = apiRegistryService.getServiceById(created.getId());
        assertNotNull(retrieved);
        assertEquals(created.getId(), retrieved.getId());
        
        // Pause
        ApiServiceResponse paused = apiRegistryService.pauseService(created.getId());
        assertFalse(paused.getEnabled());
        assertEquals(ApiStatus.PAUSED, paused.getCurrentStatus());

        // Resume
        ApiServiceResponse resumed = apiRegistryService.resumeService(created.getId());
        assertTrue(resumed.getEnabled());
        assertEquals(ApiStatus.UNKNOWN, resumed.getCurrentStatus());
    }

    @Test
    public void testHasActiveIncidentServiceState() {
        // Create an API Service
        ApiServiceRequest request = new ApiServiceRequest();
        request.setName("Active Incident Test API");
        request.setUrl("https://test.com/api");
        request.setMethod(HttpMethod.GET);
        request.setExpectedStatusCode(200);
        request.setTimeoutMs(1000);
        request.setLatencyThresholdMs(500);
        request.setCheckIntervalSeconds(60);
        ApiServiceResponse api = apiRegistryService.createService(request);

        com.rain.entity.ApiService apiEntity = apiServiceRepository.findById(api.getId()).orElseThrow();

        // CASE A: Service has no OPEN incident -> hasActiveIncident = false
        ApiServiceResponse caseA = apiRegistryService.getServiceById(api.getId());
        assertFalse(caseA.getHasActiveIncident(), "Expected false for new API with no incidents");

        // Create a dummy HealthCheck to satisfy not-null constraint on Incident
        HealthCheck hc = new HealthCheck();
        hc.setApiService(apiEntity);
        hc.setCheckedAt(Instant.now());
        hc.setSuccess(false);
        hc.setStatus(ApiStatus.DOWN);
        hc = healthCheckRepository.save(hc);

        // CASE B: Service has OPEN incident -> hasActiveIncident = true
        Incident incident = new Incident();
        incident.setApiService(apiEntity);
        incident.setStatus(IncidentStatus.OPEN);
        incident.setStartedAt(Instant.now());
        incident.setFailureCount(3);
        incident.setFirstHealthCheck(hc);
        incident.setLatestHealthCheck(hc);
        incident = incidentRepository.save(incident);

        ApiServiceResponse caseB = apiRegistryService.getServiceById(api.getId());
        assertTrue(caseB.getHasActiveIncident(), "Expected true when OPEN incident exists");

        // CASE D: Service is PAUSED but has existing OPEN incident -> hasActiveIncident = true
        apiRegistryService.pauseService(api.getId());
        ApiServiceResponse caseD = apiRegistryService.getServiceById(api.getId());
        assertTrue(caseD.getHasActiveIncident(), "Expected true even if service is PAUSED");

        // Resume for Case C
        apiRegistryService.resumeService(api.getId());

        // CASE C: Service has RESOLVED incident only -> hasActiveIncident = false
        incident.setStatus(IncidentStatus.RESOLVED);
        incident.setResolvedAt(Instant.now());
        incidentRepository.save(incident);

        ApiServiceResponse caseC = apiRegistryService.getServiceById(api.getId());
        assertFalse(caseC.getHasActiveIncident(), "Expected false when incident is RESOLVED");
    }
}
