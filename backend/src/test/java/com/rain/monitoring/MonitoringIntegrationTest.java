package com.rain.monitoring;

import com.rain.entity.ApiService;
import com.rain.entity.ApiStatus;
import com.rain.entity.HealthCheck;
import com.rain.entity.HttpMethod;
import com.rain.repository.ApiServiceRepository;
import com.rain.repository.HealthCheckRepository;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doNothing;

@SpringBootTest
class MonitoringIntegrationTest {

    private static MockWebServer mockWebServer;

    @Autowired
    private MonitoringEngineService monitoringEngineService;

    @Autowired
    private ApiServiceRepository apiServiceRepository;

    @Autowired
    private HealthCheckRepository healthCheckRepository;

    @MockBean
    private SsrfValidator ssrfValidator;

    @BeforeAll
    static void setUp() throws IOException {
        mockWebServer = new MockWebServer();
        mockWebServer.start();
    }

    @AfterAll
    static void tearDown() throws IOException {
        mockWebServer.shutdown();
    }

    @Test
    void testEndToEndMonitoringExecution() {
        // Mock SSRF for localhost testing
        doNothing().when(ssrfValidator).validateUrl(anyString());

        // Enqueue a successful response
        mockWebServer.enqueue(new MockResponse().setResponseCode(200).setBody("{\"status\":\"UP\"}"));

        // 1. Configure API
        ApiService api = new ApiService();
        api.setName("Test Integration API");
        api.setUrl(mockWebServer.url("/health").toString());
        api.setMethod(HttpMethod.GET);
        api.setExpectedStatusCode(200);
        api.setTimeoutMs(5000);
        api.setLatencyThresholdMs(5000);
        api.setCheckIntervalSeconds(30);
        api.setEnabled(true);
        api.setCurrentStatus(ApiStatus.UNKNOWN);
        
        ApiService savedApi = apiServiceRepository.save(api);

        // 2. Execute Monitoring
        HealthCheck result = monitoringEngineService.executeAndSaveCheck(savedApi.getId());

        // 3. Verify Result
        assertNotNull(result);
        assertTrue(result.getSuccess(), "Check failed: " + result.getErrorType() + " - " + result.getErrorMessage());
        assertEquals(ApiStatus.HEALTHY, result.getStatus());
        assertEquals(200, result.getHttpStatus());

        // 4. Verify PostgreSQL persistence of HealthCheck
        List<HealthCheck> checks = healthCheckRepository.findAll();
        assertFalse(checks.isEmpty());
        HealthCheck persistedCheck = checks.get(checks.size() - 1);
        assertEquals(savedApi.getId(), persistedCheck.getApiService().getId());
        assertEquals(ApiStatus.HEALTHY, persistedCheck.getStatus());

        // 5. Verify ApiService current status and timestamps
        ApiService updatedApi = apiServiceRepository.findById(savedApi.getId()).orElseThrow();
        assertEquals(ApiStatus.HEALTHY, updatedApi.getCurrentStatus());
        assertNotNull(updatedApi.getLastCheckedAt());
        assertNotNull(updatedApi.getNextCheckAt());
        assertTrue(updatedApi.getNextCheckAt().isAfter(updatedApi.getLastCheckedAt()));
        
        // Cleanup
        healthCheckRepository.delete(persistedCheck);
        apiServiceRepository.delete(updatedApi);
    }
}
