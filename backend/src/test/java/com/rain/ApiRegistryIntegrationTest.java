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

import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest
@Transactional
public class ApiRegistryIntegrationTest {

    @Autowired
    private ApiRegistryService apiRegistryService;

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
}
