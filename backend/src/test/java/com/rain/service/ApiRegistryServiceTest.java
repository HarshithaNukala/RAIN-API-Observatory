package com.rain.service;

import com.rain.dto.ApiServiceRequest;
import com.rain.dto.ApiServiceResponse;
import com.rain.entity.ApiService;
import com.rain.entity.ApiStatus;
import com.rain.entity.HttpMethod;
import com.rain.exception.ResourceNotFoundException;
import com.rain.repository.ApiServiceRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import java.time.Instant;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

public class ApiRegistryServiceTest {

    @Mock
    private ApiServiceRepository repository;

    @InjectMocks
    private ApiRegistryService service;

    @BeforeEach
    public void setUp() {
        MockitoAnnotations.openMocks(this);
    }

    @Test
    public void testCreateService_ValidUrl() {
        ApiServiceRequest request = new ApiServiceRequest();
        request.setName("Valid API");
        request.setUrl("https://api.github.com");
        request.setMethod(HttpMethod.GET);

        ApiService mockEntity = new ApiService();
        mockEntity.setId(1L);
        mockEntity.setName("Valid API");
        mockEntity.setEnabled(true);
        mockEntity.setCurrentStatus(ApiStatus.UNKNOWN);
        mockEntity.setCreatedAt(Instant.now());
        mockEntity.setUpdatedAt(Instant.now());

        when(repository.save(any(ApiService.class))).thenReturn(mockEntity);

        ApiServiceResponse response = service.createService(request);

        assertNotNull(response);
        assertEquals(1L, response.getId());
        assertEquals(ApiStatus.UNKNOWN, response.getCurrentStatus());
    }

    @Test
    public void testCreateService_InvalidUrlThrowsException() {
        ApiServiceRequest request = new ApiServiceRequest();
        request.setName("Invalid API");
        request.setUrl("ftp://invalid.com"); // Not HTTP/HTTPS

        assertThrows(IllegalArgumentException.class, () -> service.createService(request));
    }

    @Test
    public void testPauseService() {
        ApiService mockEntity = new ApiService();
        mockEntity.setId(1L);
        mockEntity.setEnabled(true);
        mockEntity.setCurrentStatus(ApiStatus.UNKNOWN);

        when(repository.findById(1L)).thenReturn(Optional.of(mockEntity));
        when(repository.save(any(ApiService.class))).thenReturn(mockEntity);

        ApiServiceResponse response = service.pauseService(1L);

        assertFalse(response.getEnabled());
        assertEquals(ApiStatus.PAUSED, response.getCurrentStatus());
    }
}
