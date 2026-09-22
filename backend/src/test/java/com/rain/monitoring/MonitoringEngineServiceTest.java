package com.rain.monitoring;

import com.rain.entity.ApiService;
import com.rain.entity.ApiStatus;
import com.rain.entity.HealthCheck;
import com.rain.entity.HttpMethod;
import com.rain.repository.ApiServiceRepository;
import com.rain.repository.HealthCheckRepository;
import com.rain.repository.IncidentRepository;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;
import org.springframework.web.reactive.function.client.WebClient;

import java.io.IOException;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class MonitoringEngineServiceTest {

    private MockWebServer mockWebServer;
    private HealthCheckExecutor executor;
    private MonitoringEngineService monitoringEngineService;
    private ApiServiceRepository apiServiceRepository;
    private HealthCheckRepository healthCheckRepository;
    private IncidentRepository incidentRepository;
    private SsrfValidator ssrfValidator;

    @BeforeEach
    void setUp() throws IOException {
        mockWebServer = new MockWebServer();
        mockWebServer.start();

        WebClient webClient = WebClient.builder().build();
        ssrfValidator = mock(SsrfValidator.class); // Mock SSRF to allow localhost in tests
        doNothing().when(ssrfValidator).validateUrl(anyString());
        
        executor = new HealthCheckExecutor(webClient, ssrfValidator);
        
        apiServiceRepository = mock(ApiServiceRepository.class);
        healthCheckRepository = mock(HealthCheckRepository.class);
        incidentRepository = mock(IncidentRepository.class);
        monitoringEngineService = new MonitoringEngineService(executor, healthCheckRepository, apiServiceRepository, incidentRepository);
        monitoringEngineService.setSelf(monitoringEngineService);
    }

    @AfterEach
    void tearDown() throws IOException {
        mockWebServer.shutdown();
    }

    @Test
    void executeAndSaveCheck_Healthy200() {
        mockWebServer.enqueue(new MockResponse().setResponseCode(200).setBody("OK"));

        ApiService apiService = new ApiService();
        apiService.setId(1L);
        apiService.setUrl(mockWebServer.url("/test").toString());
        apiService.setMethod(HttpMethod.GET);
        apiService.setEnabled(true);
        apiService.setExpectedStatusCode(200);
        apiService.setTimeoutMs(5000);
        apiService.setLatencyThresholdMs(5000);
        apiService.setCheckIntervalSeconds(60);

        when(apiServiceRepository.findById(1L)).thenReturn(Optional.of(apiService));
        when(apiServiceRepository.findWithLockById(1L)).thenReturn(Optional.of(apiService));
        when(healthCheckRepository.save(any(HealthCheck.class))).thenAnswer(i -> i.getArgument(0));

        HealthCheck result = monitoringEngineService.executeAndSaveCheck(1L);

        assertNotNull(result);
        assertTrue(result.getSuccess());
        assertEquals(ApiStatus.HEALTHY, result.getStatus());
        assertEquals(200, result.getHttpStatus());
        
        verify(apiServiceRepository).save(apiService);
        assertEquals(ApiStatus.HEALTHY, apiService.getCurrentStatus());
    }

    @Test
    void executeAndSaveCheck_UnexpectedStatus() {
        mockWebServer.enqueue(new MockResponse().setResponseCode(500).setBody("Error"));

        ApiService apiService = new ApiService();
        apiService.setId(2L);
        apiService.setUrl(mockWebServer.url("/fail").toString());
        apiService.setMethod(HttpMethod.GET);
        apiService.setEnabled(true);
        apiService.setExpectedStatusCode(200);
        apiService.setTimeoutMs(5000);
        apiService.setLatencyThresholdMs(5000);
        apiService.setCheckIntervalSeconds(60);

        when(apiServiceRepository.findById(2L)).thenReturn(Optional.of(apiService));
        when(apiServiceRepository.findWithLockById(2L)).thenReturn(Optional.of(apiService));
        when(healthCheckRepository.save(any(HealthCheck.class))).thenAnswer(i -> i.getArgument(0));

        HealthCheck result = monitoringEngineService.executeAndSaveCheck(2L);

        assertNotNull(result);
        assertFalse(result.getSuccess());
        assertEquals(ApiStatus.DOWN, result.getStatus());
        assertEquals("HTTP_STATUS_MISMATCH", result.getErrorType());
    }
}
