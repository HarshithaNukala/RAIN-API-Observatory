package com.rain.monitoring;

import com.rain.entity.ApiService;
import com.rain.entity.ApiStatus;
import com.rain.entity.HealthCheck;
import com.rain.entity.HttpMethod;
import com.rain.repository.ApiServiceRepository;
import com.rain.repository.HealthCheckRepository;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doNothing;

@SpringBootTest
class MonitoringIntegrationTest {

    private MockWebServer mockWebServer;

    @Autowired
    private MonitoringEngineService monitoringEngineService;

    @Autowired
    private ApiServiceRepository apiServiceRepository;

    @Autowired
    private HealthCheckRepository healthCheckRepository;

    @Autowired
    private MonitoringScheduler monitoringScheduler;

    @MockBean
    private SsrfValidator ssrfValidator;

    @BeforeEach
    void setUp() throws IOException {
        mockWebServer = new MockWebServer();
        mockWebServer.start();
    }

    @AfterEach
    void tearDown() throws IOException {
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

    @Test
    void testFailureCase_500Response() {
        doNothing().when(ssrfValidator).validateUrl(anyString());
        mockWebServer.enqueue(new MockResponse().setResponseCode(500).setBody("Internal Error"));

        ApiService api = new ApiService();
        api.setName("Test Failure API");
        api.setUrl(mockWebServer.url("/fail").toString());
        api.setMethod(HttpMethod.GET);
        api.setExpectedStatusCode(200);
        api.setTimeoutMs(5000);
        api.setLatencyThresholdMs(5000);
        api.setCheckIntervalSeconds(30);
        api.setEnabled(true);
        api.setCurrentStatus(ApiStatus.UNKNOWN);
        ApiService savedApi = apiServiceRepository.save(api);

        HealthCheck result = monitoringEngineService.executeAndSaveCheck(savedApi.getId());

        assertNotNull(result);
        assertFalse(result.getSuccess());
        assertEquals(ApiStatus.DOWN, result.getStatus());
        assertEquals(500, result.getHttpStatus());
        assertEquals("HTTP_STATUS_MISMATCH", result.getErrorType());

        ApiService updatedApi = apiServiceRepository.findById(savedApi.getId()).orElseThrow();
        assertEquals(ApiStatus.DOWN, updatedApi.getCurrentStatus());
    }

    @Test
    void testSlowCase_Degraded() {
        doNothing().when(ssrfValidator).validateUrl(anyString());
        mockWebServer.enqueue(new MockResponse().setResponseCode(200).setBody("OK").setBodyDelay(200, TimeUnit.MILLISECONDS));

        ApiService api = new ApiService();
        api.setName("Test Slow API");
        api.setUrl(mockWebServer.url("/slow").toString());
        api.setMethod(HttpMethod.GET);
        api.setExpectedStatusCode(200);
        api.setTimeoutMs(5000);
        api.setLatencyThresholdMs(100); // Strict threshold
        api.setCheckIntervalSeconds(30);
        api.setEnabled(true);
        api.setCurrentStatus(ApiStatus.UNKNOWN);
        ApiService savedApi = apiServiceRepository.save(api);

        HealthCheck result = monitoringEngineService.executeAndSaveCheck(savedApi.getId());

        assertNotNull(result);
        assertTrue(result.getSuccess());
        assertEquals(ApiStatus.DEGRADED, result.getStatus());

        ApiService updatedApi = apiServiceRepository.findById(savedApi.getId()).orElseThrow();
        assertEquals(ApiStatus.DEGRADED, updatedApi.getCurrentStatus());
    }

    @Test
    void testTimeoutCase() {
        doNothing().when(ssrfValidator).validateUrl(anyString());
        mockWebServer.enqueue(new MockResponse().setResponseCode(200).setBody("OK").setBodyDelay(1500, TimeUnit.MILLISECONDS));

        ApiService api = new ApiService();
        api.setName("Test Timeout API");
        api.setUrl(mockWebServer.url("/timeout").toString());
        api.setMethod(HttpMethod.GET);
        api.setExpectedStatusCode(200);
        api.setTimeoutMs(500); // 500ms timeout
        api.setLatencyThresholdMs(5000);
        api.setCheckIntervalSeconds(30);
        api.setEnabled(true);
        api.setCurrentStatus(ApiStatus.UNKNOWN);
        ApiService savedApi = apiServiceRepository.save(api);

        HealthCheck result = monitoringEngineService.executeAndSaveCheck(savedApi.getId());

        assertNotNull(result);
        assertFalse(result.getSuccess());
        assertEquals(ApiStatus.DOWN, result.getStatus());
        assertEquals("TIMEOUT", result.getErrorType());

        ApiService updatedApi = apiServiceRepository.findById(savedApi.getId()).orElseThrow();
        assertEquals(ApiStatus.DOWN, updatedApi.getCurrentStatus());
    }

    @Test
    void testScheduledCheckAndPause() throws InterruptedException {
        doNothing().when(ssrfValidator).validateUrl(anyString());
        mockWebServer.enqueue(new MockResponse().setResponseCode(200).setBody("OK"));

        ApiService api = new ApiService();
        api.setName("Test Scheduler API");
        api.setUrl(mockWebServer.url("/scheduled").toString());
        api.setMethod(HttpMethod.GET);
        api.setExpectedStatusCode(200);
        api.setTimeoutMs(5000);
        api.setLatencyThresholdMs(5000);
        api.setCheckIntervalSeconds(10);
        api.setEnabled(true);
        api.setCurrentStatus(ApiStatus.UNKNOWN);
        // nextCheckAt is null, so it should be due immediately
        ApiService savedApi = apiServiceRepository.save(api);

        // 1. Trigger Scheduler
        monitoringScheduler.dispatchDueChecks();
        
        // Give virtual threads time to execute
        Thread.sleep(1500);

        ApiService updatedApi = apiServiceRepository.findById(savedApi.getId()).orElseThrow();
        assertEquals(ApiStatus.HEALTHY, updatedApi.getCurrentStatus());
        assertNotNull(updatedApi.getLastCheckedAt());
        assertNotNull(updatedApi.getNextCheckAt());

        // 2. Pause
        updatedApi.setEnabled(false);
        updatedApi.setCurrentStatus(ApiStatus.PAUSED);
        apiServiceRepository.save(updatedApi);

        // Clear mock web server queue and trigger again, it shouldn't execute
        mockWebServer.enqueue(new MockResponse().setResponseCode(200).setBody("SHOULD_NOT_HIT"));
        monitoringScheduler.dispatchDueChecks();
        Thread.sleep(500);

        ApiService pausedApi = apiServiceRepository.findById(savedApi.getId()).orElseThrow();
        assertEquals(ApiStatus.PAUSED, pausedApi.getCurrentStatus());
        assertEquals(updatedApi.getLastCheckedAt(), pausedApi.getLastCheckedAt()); // Should not have changed
    }
}
